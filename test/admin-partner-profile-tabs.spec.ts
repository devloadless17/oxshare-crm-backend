import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { AdminHoldingsService } from '../src/modules/admin/admin-holdings.service';
import { ClientVisibilityService } from '../src/common/security/client-visibility.service';
import { UsersStore } from '../src/store/users.store';
import type { AuthenticatedAdmin } from '../src/modules/admin/guards/admin.guard';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * Two reads behind the client profile (owner, 26 Sep 2026).
 *
 *  - History names the METHOD a movement went through — "Whish Money", not the
 *    `whish` key — for a deposit (payment method) and a withdrawal (payout
 *    method) alike, and leaves a manual credit's name null for the screen to
 *    name from its provider.
 *  - A partner's Accounts tab lists the trading accounts of every client that
 *    partner introduced, through `?referredBy=` on the trading-accounts list,
 *    and nobody else's — scoped like every other filter.
 */
let ctx: MoneyTestContext;
let holdings: AdminHoldingsService;
let partnerId: number;
let otherPartnerId: number;
let clientA: number;
let clientB: number;
let stranger: number;

const TRADING_VIEWER = {
  id: '00000000-0000-0000-0000-000000000001',
  email: 'trading-viewer@oxshare-e2e.test',
  role: 'admin',
  permissions: ['trading.view'],
  clientScope: { unrestricted: true, tagIds: [] },
  fieldMask: [],
} as unknown as AuthenticatedAdmin;

async function user(email: string, referredBy: number | null = null): Promise<number> {
  const { rows } = await ctx.db.execute<{ id: number }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name, referred_by_ib_user_id)
    VALUES (${email}, 'x', 'Tab', 'Test', ${referredBy})
    RETURNING id
  `);
  return rows[0].id;
}

async function partner(userId: number, code: string): Promise<void> {
  await ctx.db.execute(sql`
    INSERT INTO ib_accounts (user_id, referral_code, program_id)
    VALUES (${userId}, ${code}, (SELECT id FROM ib_programs ORDER BY sort_order, name LIMIT 1))
  `);
}

async function account(userId: number, login: string): Promise<void> {
  await ctx.db.execute(sql`
    INSERT INTO trading_accounts (user_id, login, currency, environment)
    VALUES (${userId}, ${login}, 'USD', 'live')
  `);
}

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  holdings = new AdminHoldingsService(ctx.db, new ClientVisibilityService(new UsersStore(ctx.db)));

  partnerId = await user('tabs-partner@oxshare-e2e.test');
  await partner(partnerId, 'TABSP001');
  otherPartnerId = await user('tabs-other-partner@oxshare-e2e.test');
  await partner(otherPartnerId, 'TABSP002');
  clientA = await user('tabs-client-a@oxshare-e2e.test', partnerId);
  clientB = await user('tabs-client-b@oxshare-e2e.test', partnerId);
  stranger = await user('tabs-stranger@oxshare-e2e.test', otherPartnerId);

  await account(clientA, '91001');
  await account(clientA, '91002');
  await account(clientB, '91003');
  await account(stranger, '91004');
  // The partner's OWN account is not one of their clients' accounts.
  await account(partnerId, '91005');
}, 180_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

describe("a partner's Accounts tab", () => {
  it("lists every account of every client they introduced, and nobody else's", async () => {
    const page = await holdings.listTradingAccounts(
      { referredBy: partnerId, limit: '50', sort: 'login', order: 'asc' },
      TRADING_VIEWER,
    );

    expect(page.items.map((row) => row.login)).toEqual(['91001', '91002', '91003']);
    expect(page.total).toBe(3);
  });

  it('is empty for a partner who introduced nobody with an account', async () => {
    const lonely = await user('tabs-lonely@oxshare-e2e.test');
    await partner(lonely, 'TABSP003');

    const page = await holdings.listTradingAccounts(
      { referredBy: lonely, limit: '50' },
      TRADING_VIEWER,
    );

    expect(page.items).toEqual([]);
    expect(page.total).toBe(0);
  });

  it('narrows with the other filters, not instead of them', async () => {
    const page = await holdings.listTradingAccounts(
      { referredBy: partnerId, q: '91003', limit: '50' },
      TRADING_VIEWER,
    );

    expect(page.items.map((row) => row.login)).toEqual(['91003']);
  });
});

describe("a client's History names the method", () => {
  let walletId: string;

  beforeAll(async () => {
    await ctx.db.execute(sql`
      INSERT INTO payment_methods (key, name, currency)
      VALUES ('tabs-whish', 'Whish Money', 'USD')
      ON CONFLICT (key) DO NOTHING
    `);
    await ctx.db.execute(sql`
      INSERT INTO withdrawal_payment_methods (key, name)
      VALUES ('tabs-bank', 'Bank transfer')
      ON CONFLICT (key) DO NOTHING
    `);
    const { rows } = await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO wallets (user_id, currency, balance)
      VALUES (${clientA}, 'USD', '0')
      RETURNING id
    `);
    walletId = rows[0].id;

    const movement = async (
      direction: string,
      provider: string,
      ref: string,
      at: string,
      keys: { method?: string; withdrawalMethod?: string } = {},
    ) =>
      ctx.db.execute(sql`
        INSERT INTO transactions
          (user_id, wallet_id, direction, amount, currency, state, provider, provider_ref,
           method_key, withdrawal_method_key, created_at)
        VALUES (
          ${clientA}, ${walletId}, ${direction}::transaction_direction, '10.00000000', 'USD',
          'success'::transaction_state, ${provider}, ${ref},
          ${keys.method ?? null}, ${keys.withdrawalMethod ?? null}, ${at}
        )
      `);
    await movement('deposit', 'whish', 'tabs-1', '2026-09-20T10:00:00Z', { method: 'tabs-whish' });
    await movement('withdrawal', 'bank', 'tabs-2', '2026-09-21T10:00:00Z', {
      withdrawalMethod: 'tabs-bank',
    });
    await movement('deposit', 'manual_admin', 'tabs-3', '2026-09-22T10:00:00Z');
  });

  it('by its display name, for a deposit and a withdrawal alike', async () => {
    const page = await holdings.listClientTransactions({ userId: clientA });

    expect(page.rows.map((row) => [row.provider, row.methodName])).toEqual([
      ['manual_admin', null],
      ['bank', 'Bank transfer'],
      ['whish', 'Whish Money'],
    ]);
    // The join adds no rows and loses none.
    expect(page.total).toBe(3);
  });
});
