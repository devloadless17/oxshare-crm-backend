import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { sql } from 'drizzle-orm';
import { TransfersService } from '../src/modules/payments/transfers.service';
import type { Mt5BridgeClient } from '../src/modules/trading/mt5/mt5-bridge.client';
import { Mt5WebhooksController } from '../src/modules/trading/mt5/mt5-webhooks.controller';
import type { Mt5AccountSyncService } from '../src/modules/trading/mt5/mt5-account-sync.service';
import type { Mt5AccountDirectoryService } from '../src/modules/trading/mt5/mt5-account-directory.service';
import type { Mt5GroupSyncService } from '../src/modules/trading/mt5/mt5-group-sync.service';
import type { Mt5GroupSyncScheduler } from '../src/modules/trading/mt5/mt5-group-sync.scheduler';
import type { Mt5DealsService } from '../src/modules/trading/mt5/mt5-deals.service';
import type { Mt5LiveService } from '../src/modules/trading/mt5/mt5-live.service';
import type { AppSettingsStore } from '../src/store/app-settings.store';
import { NotificationsRealtimeGateway } from '../src/modules/notifications/realtime.gateway';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { CurrenciesService } from '../src/modules/currencies/currencies.service';
import { auditStubAs } from './audit-stub';
import { notificationsStubAs } from './notifications-stub';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * A closed trade reaches the client's screen (7 Oct 2026).
 *
 * The bridge's change feed finds the deal within seconds and pushes the
 * balance; these are the CRM's three halves of that promise:
 *
 * 1. Every real change to an OWNED account's balance is announced
 *    (`account_balance`, migration 0204) — and nothing else is.
 * 2. A transfer out of an account is never refused on a stale mirror: MT5 is
 *    asked once before a refusal.
 * 3. An account opened on MT5 directly is recorded the moment its first
 *    balance arrives, not on the next ten-minute directory run.
 */

let ctx: MoneyTestContext;
let listener: Client;
let heard: { userId: number; accountId: string }[] = [];

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  const uri = new URL(process.env['TEST_PG_URI'] as string);
  uri.pathname = `/${ctx.databaseName}`;
  listener = new Client({ connectionString: uri.toString() });
  await listener.connect();
  await listener.query('LISTEN account_balance');
  listener.on('notification', (message) => {
    if (message.payload) heard.push(JSON.parse(message.payload) as (typeof heard)[number]);
  });
}, 120_000);

afterAll(async () => {
  await listener?.end().catch(() => undefined);
  if (ctx) await stopMoneyTestDb(ctx);
});

beforeEach(() => {
  heard = [];
});

/** Notifications are delivered after COMMIT, asynchronously — wait briefly. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 150));
}

async function makeClient(email: string): Promise<number> {
  const { rows } = await ctx.db.execute<{ id: number }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name, verification_level, email_verified)
    VALUES (${email}, 'x', 'Test', 'Client', 1, true)
    RETURNING id
  `);
  return rows[0].id;
}

async function makeAccount(userId: number | null, login: string, balance = '100'): Promise<string> {
  const { rows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO trading_accounts (user_id, login, environment, currency, balance, status)
    VALUES (${userId}, ${login}, 'live', 'USD', ${balance}, 'active')
    RETURNING id
  `);
  return rows[0].id;
}

describe('a balance change is announced to its owner (0204)', () => {
  it('announces a changed balance on an owned account, naming owner and account', async () => {
    const userId = await makeClient('push-owned@test.local');
    const accountId = await makeAccount(userId, '7700001');
    await settle();
    heard = [];

    await ctx.db.execute(sql`UPDATE trading_accounts SET balance = 125.5 WHERE id = ${accountId}`);
    await settle();

    expect(heard).toEqual([{ userId, accountId }]);
  });

  it('says nothing when a fresher read carries the same balance', async () => {
    const userId = await makeClient('push-same@test.local');
    const accountId = await makeAccount(userId, '7700002', '100');
    await settle();
    heard = [];

    await ctx.db.execute(
      sql`UPDATE trading_accounts SET balance = 100, balance_synced_at = now() WHERE id = ${accountId}`,
    );
    await settle();

    expect(heard).toEqual([]);
  });

  it('says nothing for an account nobody owns', async () => {
    const accountId = await makeAccount(null, '7700003');
    await settle();
    heard = [];

    await ctx.db.execute(sql`UPDATE trading_accounts SET balance = 1 WHERE id = ${accountId}`);
    await settle();

    expect(heard).toEqual([]);
  });

  it('announces a credit change, an assignment and a new owned account', async () => {
    const userId = await makeClient('push-other@test.local');
    const unowned = await makeAccount(null, '7700004');
    await settle();
    heard = [];

    await ctx.db.execute(
      sql`UPDATE trading_accounts SET user_id = ${userId} WHERE id = ${unowned}`,
    );
    await ctx.db.execute(sql`UPDATE trading_accounts SET credit = 50 WHERE id = ${unowned}`);
    const created = await makeAccount(userId, '7700005');
    await settle();

    expect(heard).toEqual([
      { userId, accountId: unowned },
      { userId, accountId: unowned },
      { userId, accountId: created },
    ]);
  });

  it('says nothing when the write rolls back', async () => {
    const userId = await makeClient('push-rollback@test.local');
    const accountId = await makeAccount(userId, '7700006');
    await settle();
    heard = [];

    await ctx.db
      .transaction(async (tx) => {
        await tx.execute(sql`UPDATE trading_accounts SET balance = 999 WHERE id = ${accountId}`);
        throw new Error('roll back');
      })
      .catch(() => undefined);
    await settle();

    expect(heard).toEqual([]);
  });

  it('the gateway delivers it into the owner’s room only', () => {
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));
    const gateway = Object.create(
      NotificationsRealtimeGateway.prototype,
    ) as NotificationsRealtimeGateway;
    (gateway as unknown as { server: unknown }).server = { to };

    gateway.publishAccountBalance({ userId: 1000245, accountId: 'acc-1' });

    expect(to).toHaveBeenCalledWith('client:1000245');
    expect(emit).toHaveBeenCalledWith('account.balance', { accountId: 'acc-1' });
  });
});

describe('a transfer out is never refused on a stale mirror', () => {
  function service(bridge?: Partial<Mt5BridgeClient>) {
    return new TransfersService(
      new WalletService(ctx.db),
      new CurrenciesService(ctx.db, auditStubAs()),
      ctx.db,
      notificationsStubAs(),
      bridge as Mt5BridgeClient | undefined,
    );
  }

  it('asks MT5 before refusing, and its figure lets a just-closed profit out', async () => {
    const userId = await makeClient('stale-profit@test.local');
    // The mirror still says 100; MT5 already holds 160 after a closed trade.
    const accountId = await makeAccount(userId, '7710001', '100');
    const getAccount = vi.fn().mockResolvedValue({ balance: '160.00000000' });

    const pending = await service({ isConfigured: true, getAccount }).request({
      userId,
      tradingAccountId: accountId,
      direction: 'account_to_wallet',
      amount: '150',
      currency: 'USD',
    });

    expect(getAccount).toHaveBeenCalledWith('7710001');
    expect(pending.state).toBe('pending');
  });

  it('still refuses when MT5 agrees there is not enough', async () => {
    const userId = await makeClient('stale-short@test.local');
    const accountId = await makeAccount(userId, '7710002', '100');
    const getAccount = vi.fn().mockResolvedValue({ balance: '120.00000000' });

    await expect(
      service({ isConfigured: true, getAccount }).request({
        userId,
        tradingAccountId: accountId,
        direction: 'account_to_wallet',
        amount: '150',
        currency: 'USD',
      }),
    ).rejects.toThrow(/holds 120\.00000000 USD/);
  });

  it('keeps the mirror’s refusal when MT5 cannot be read — never a guess', async () => {
    const userId = await makeClient('stale-down@test.local');
    const accountId = await makeAccount(userId, '7710003', '100');
    const getAccount = vi.fn().mockRejectedValue(new Error('bridge down'));

    await expect(
      service({ isConfigured: true, getAccount }).request({
        userId,
        tradingAccountId: accountId,
        direction: 'account_to_wallet',
        amount: '150',
        currency: 'USD',
      }),
    ).rejects.toThrow(/holds 100\.00000000 USD/);
  });

  it('does not read MT5 at all when the mirror already allows it', async () => {
    const userId = await makeClient('stale-enough@test.local');
    const accountId = await makeAccount(userId, '7710004', '500');
    const getAccount = vi.fn();

    await service({ isConfigured: true, getAccount }).request({
      userId,
      tradingAccountId: accountId,
      direction: 'account_to_wallet',
      amount: '150',
      currency: 'USD',
    });

    expect(getAccount).not.toHaveBeenCalled();
  });
});

describe('an account opened on MT5 directly is recorded when first seen', () => {
  function controller(
    results: { login: string; applied: boolean; reason?: 'stale' | 'unknown-login' }[],
  ) {
    const recordDiscovered = vi.fn().mockResolvedValue(1);
    const accounts = {
      ingestSnapshotBatch: vi.fn().mockResolvedValue({ results }),
    } as unknown as Mt5AccountSyncService;
    const instance = new Mt5WebhooksController(
      {} as Mt5DealsService,
      accounts,
      {} as Mt5LiveService,
      {} as AppSettingsStore,
      { recordDiscovered } as unknown as Mt5AccountDirectoryService,
      { unknownGroups } as unknown as Mt5GroupSyncService,
      { syncSoon } as unknown as Mt5GroupSyncScheduler,
    );
    return { instance, recordDiscovered };
  }
  const unknownGroups = vi.fn();
  const syncSoon = vi.fn();

  it('hands only the unknown logins to the directory, in the background', async () => {
    const { instance, recordDiscovered } = controller([
      { login: '1', applied: true },
      { login: '2', applied: false, reason: 'stale' },
      { login: '3', applied: false, reason: 'unknown-login' },
    ]);

    const answer = await instance.ingestAccountBatch({
      snapshots: [],
    });

    expect(answer.results).toHaveLength(3);
    expect(recordDiscovered).toHaveBeenCalledWith(['3']);
  });

  it('asks nothing when every login is known', async () => {
    const { instance, recordDiscovered } = controller([{ login: '1', applied: true }]);
    await instance.ingestAccountBatch({ snapshots: [] });
    expect(recordDiscovered).not.toHaveBeenCalled();
  });

  it('syncs MT5 groups at once when a snapshot names a group the CRM has never seen', async () => {
    const { instance } = controller([{ login: '1', applied: true }]);
    unknownGroups.mockResolvedValueOnce(['real\\NewDesk']);
    syncSoon.mockClear();

    await instance.ingestAccountBatch({
      snapshots: [{ login: '1', group: 'real\\NewDesk' }],
    } as never);

    expect(unknownGroups).toHaveBeenCalledWith(['real\\NewDesk']);
    expect(syncSoon).toHaveBeenCalledTimes(1);
  });

  it('does not sync groups when every group is known', async () => {
    const { instance } = controller([{ login: '1', applied: true }]);
    unknownGroups.mockResolvedValueOnce([]);
    syncSoon.mockClear();

    await instance.ingestAccountBatch({
      snapshots: [{ login: '1', group: 'real\\Standard' }],
    } as never);

    expect(syncSoon).not.toHaveBeenCalled();
  });
});

describe('the bridge sweep is not an admin setting any more', () => {
  it('answers the fixed fallback interval, without reading a stored one', () => {
    const instance = new Mt5WebhooksController(
      {} as Mt5DealsService,
      {} as Mt5AccountSyncService,
      {} as Mt5LiveService,
      {} as AppSettingsStore,
    );
    expect(instance.bridgeSettings()).toEqual({ sweepIntervalSeconds: 120 });
  });
});
