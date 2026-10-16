import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { Mt5AccountsService } from '../src/modules/trading/mt5/mt5-accounts.service';
import type {
  Mt5AccountSnapshot,
  Mt5BridgeClient,
  Mt5Position,
} from '../src/modules/trading/mt5/mt5-bridge.client';
import { TradingService } from '../src/modules/trading/trading.service';
import { Mt5AccountSyncService } from '../src/modules/trading/mt5/mt5-account-sync.service';
import type { EmailService } from '../src/modules/email/email.service';
import type { AuthenticatedAdmin } from '../src/modules/admin/guards/admin.guard';
import { ProductsStore } from '../src/store/products.store';
import { AppSettingsStore } from '../src/store/app-settings.store';
import { UNRESTRICTED } from '../src/common/security/client-scope';
import { EMPTY_MASK } from '../src/common/security/field-mask';
import {
  ExternalServiceError,
  NotFoundError,
  ValidationError,
} from '../src/common/errors/domain-errors';
import { auditStubAs } from './audit-stub';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * ARCHIVING A CLIENT'S TRADING ACCOUNT (0225, 16 Oct 2026).
 *
 * A client opened ten accounts; the desk hides the ones they will not use. The
 * money rule pinned here: a live account is archived only while MT5 says it
 * holds NOTHING, and an unreachable bridge refuses rather than assuming empty.
 * Once archived, the account is gone from every client read.
 */
let ctx: MoneyTestContext;
let accounts: Mt5AccountsService;
let trading: TradingService;
let clientId: number;
let bridgeDown = false;

const MT5: Record<string, Mt5AccountSnapshot> = {};
const POSITIONS: Record<string, Mt5Position[]> = {};

const ADMIN = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'archive-admin@oxshare.internal',
  permissions: ['trading.view', 'trading.archive'],
  clientScope: UNRESTRICTED,
  fieldMask: EMPTY_MASK,
} as unknown as AuthenticatedAdmin;

function onMt5(login: string, figures: Partial<Mt5AccountSnapshot> = {}): void {
  MT5[login] = {
    login: Number(login),
    group: 'real\\Archive',
    currency: 'USD',
    leverage: 100,
    balance: '0.00000000',
    equity: '0.00000000',
    credit: '0.00000000',
    margin: '0.00000000',
    marginFree: '0.00000000',
    marginLevel: null,
    ...figures,
  };
  POSITIONS[login] = [];
}

async function account(login: string, environment: 'live' | 'demo' = 'live'): Promise<string> {
  const { rows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO trading_accounts (user_id, login, environment, currency, balance)
    VALUES (${clientId}, ${login}, ${environment}, 'USD', '0') RETURNING id`);
  return rows[0].id;
}

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  const { rows } = await ctx.db.execute<{ id: number }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name)
    VALUES ('archive-client@oxshare-e2e.test', 'x', 'Lost', 'Client') RETURNING id`);
  clientId = rows[0].id;
  await ctx.db.execute(sql`
    INSERT INTO admins (id, email, password_hash, name, role, permissions)
    VALUES (${ADMIN.id}, ${ADMIN.email}, 'x', 'Archive Admin', 'sub_admin', '[]'::jsonb)
    ON CONFLICT (id) DO NOTHING`);

  const down = () => Promise.reject(new ExternalServiceError('bridge unreachable'));
  const bridge = {
    isConfigured: true,
    getAccount: vi.fn((login: string) =>
      bridgeDown ? down() : Promise.resolve(MT5[login] ?? null),
    ),
    getPositions: vi.fn((login: string) =>
      bridgeDown ? down() : Promise.resolve(POSITIONS[login] ?? []),
    ),
  } as unknown as Mt5BridgeClient;

  accounts = new Mt5AccountsService(
    ctx.db,
    bridge,
    auditStubAs(),
    {} as EmailService,
    new AppSettingsStore(ctx.db),
    new ProductsStore(ctx.db),
  );
  // Not configured, so the reads never refresh a balance through the fake.
  trading = new TradingService(
    ctx.db,
    { isConfigured: false } as unknown as Mt5BridgeClient,
    new Mt5AccountSyncService(ctx.db),
  );
}, 180_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

beforeEach(async () => {
  bridgeDown = false;
  await ctx.db.execute(sql`DELETE FROM trading_accounts WHERE user_id = ${clientId}`);
});

describe('the money rule: nothing that holds anything is hidden', () => {
  it.each([
    ['a balance', { balance: '12.50000000', equity: '12.50000000' }, /balance of 12\.50 USD/],
    ['credit', { credit: '5.00000000', equity: '5.00000000' }, /credit of 5\.00 USD/],
    ['floating equity', { equity: '-0.01000000' }, /equity of -0\.01 USD/],
  ])('refuses an account holding %s, and changes nothing', async (_, figures, message) => {
    onMt5('8100001', figures);
    const id = await account('8100001');
    await expect(accounts.setAccountArchived(id, true, ADMIN)).rejects.toThrow(message);
    expect(await trading.listMine(clientId)).toHaveLength(1);
  });

  it('refuses when the CRM shows money, even if MT5 does not know the login', async () => {
    const { rows } = await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO trading_accounts (user_id, login, environment, currency, balance)
      VALUES (${clientId}, '8100009', 'live', 'USD', '2500') RETURNING id`);
    await expect(accounts.setAccountArchived(rows[0].id, true, ADMIN)).rejects.toThrow(
      /balance of 2500\.00 USD in the CRM/,
    );
  });

  it('refuses while a transfer to or from it is still moving (audit R3-11)', async () => {
    onMt5('8100010');
    const id = await account('8100010');
    const { rows: w } = await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO wallets (user_id, currency, balance) VALUES (${clientId}, 'USD', '0')
      ON CONFLICT (user_id, currency, kind) DO UPDATE SET balance = wallets.balance RETURNING id`);
    await ctx.db.execute(sql`
      INSERT INTO transfers (user_id, wallet_id, trading_account_id, direction, amount, currency, origin)
      VALUES (${clientId}, ${w[0].id}, ${id}, 'account_to_wallet', '10', 'USD', 'client')`);
    await expect(accounts.setAccountArchived(id, true, ADMIN)).rejects.toThrow(/still in progress/);
    await ctx.db.execute(sql`DELETE FROM transfers WHERE trading_account_id = ${id}`);
  });

  it('refuses an account with an open position', async () => {
    onMt5('8100002');
    POSITIONS['8100002'] = [{ ticket: 1 } as Mt5Position];
    const id = await account('8100002');
    await expect(accounts.setAccountArchived(id, true, ADMIN)).rejects.toThrow(/open position/);
  });

  it('refuses when the bridge cannot say, rather than assuming empty', async () => {
    onMt5('8100003');
    const id = await account('8100003');
    bridgeDown = true;
    await expect(accounts.setAccountArchived(id, true, ADMIN)).rejects.toBeInstanceOf(
      ExternalServiceError,
    );
    expect(await trading.listMine(clientId)).toHaveLength(1);
  });

  it('archives a demo account without asking MT5 (practice money)', async () => {
    const id = await account('8100004', 'demo');
    bridgeDown = true;
    await expect(accounts.setAccountArchived(id, true, ADMIN)).resolves.toMatchObject({ id });
  });

  it('answers an account outside the reader’s territory as not found, and changes nothing', async () => {
    onMt5('8100006');
    const id = await account('8100006');
    const nobodysDesk = {
      ...ADMIN,
      clientScope: { unrestricted: false, tagIds: [] },
    } as unknown as AuthenticatedAdmin;
    await expect(accounts.setAccountArchived(id, true, nobodysDesk)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(accounts.setAccountArchived(id, false, nobodysDesk)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(await trading.listMine(clientId)).toHaveLength(1);
  });

  it('refuses an admin without trading.archive', async () => {
    onMt5('8100005');
    const id = await account('8100005');
    const viewer = { ...ADMIN, permissions: ['trading.view'] };
    await expect(accounts.setAccountArchived(id, true, viewer)).rejects.toThrow();
  });
});

describe('an archived account is gone from every client read', () => {
  it('leaves the list, the transfer picker and the detail; Restore brings it back', async () => {
    onMt5('8100010');
    onMt5('8100011');
    const kept = await account('8100010');
    const hidden = await account('8100011');

    await accounts.setAccountArchived(hidden, true, ADMIN);

    expect((await trading.listMine(clientId)).map((a) => a.id)).toEqual([kept]);
    expect((await trading.listTransferable(clientId)).map((a) => a.id)).toEqual([kept]);
    await expect(trading.findMine(clientId, hidden)).rejects.toBeInstanceOf(NotFoundError);

    // Archiving twice is the same answer, not an error.
    await expect(accounts.setAccountArchived(hidden, true, ADMIN)).resolves.toMatchObject({
      id: hidden,
    });

    await accounts.setAccountArchived(hidden, false, ADMIN);
    expect(await trading.listMine(clientId)).toHaveLength(2);
    await expect(trading.findMine(clientId, hidden)).resolves.toMatchObject({ id: hidden });
  });

  it('refuses an account with no client', async () => {
    const { rows } = await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO trading_accounts (user_id, login, environment, currency, balance)
      VALUES (NULL, '8100020', 'live', 'USD', '0') RETURNING id`);
    await expect(accounts.setAccountArchived(rows[0].id, true, ADMIN)).rejects.toBeInstanceOf(
      ValidationError,
    );
    await ctx.db.execute(sql`DELETE FROM trading_accounts WHERE login = '8100020'`);
  });
});
