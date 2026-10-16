import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { DashboardService } from '../src/modules/trading/dashboard.service';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * The client's own "pending" count (audit R3-13): everything still in progress — a payment not
 * yet decided or on its way, and a transfer MT5 has not confirmed — never just one state.
 */
let ctx: MoneyTestContext;
beforeAll(async () => {
  ctx = await startMoneyTestDb();
}, 180_000);
afterAll(async () => stopMoneyTestDb(ctx));

describe("the client's pending count", () => {
  it('counts a pending deposit, an approved payout and a pending transfer — not what is finished', async () => {
    const { rows: u } = await ctx.db.execute<{ id: number }>(sql`
      INSERT INTO users (email, password_hash, first_name, last_name)
      VALUES ('pending-count@test.local', 'x', 'Pend', 'Ing') RETURNING id`);
    const userId = u[0].id;
    const { rows: w } = await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO wallets (user_id, currency, balance) VALUES (${userId}, 'USD', '0') RETURNING id`);
    const { rows: a } = await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO trading_accounts (user_id, login, environment, currency, balance, status)
      VALUES (${userId}, '7700099', 'live', 'USD', '0', 'active') RETURNING id`);
    for (const [direction, state, ref] of [
      ['deposit', 'pending', 'pc-1'],
      ['withdrawal', 'approved', 'pc-2'],
      ['deposit', 'success', 'pc-3'],
    ] as const) {
      await ctx.db.execute(sql`
        INSERT INTO transactions (user_id, wallet_id, direction, amount, currency, state, provider,
                                  provider_ref)
        VALUES (${userId}, ${w[0].id}, ${direction}::transaction_direction, '10', 'USD',
                ${state}::transaction_state, 'manual_test', ${ref})`);
    }
    await ctx.db.execute(sql`
      INSERT INTO transfers (user_id, wallet_id, trading_account_id, direction, amount, currency,
                             origin)
      VALUES (${userId}, ${w[0].id}, ${a[0].id}, 'account_to_wallet', '5', 'USD', 'client')`);

    const service = new DashboardService(ctx.db, {} as never, {} as never, {} as never);
    const stats = await (
      service as unknown as { statsFor(id: number): Promise<{ pendingTransactions: number }> }
    ).statsFor(userId);
    expect(stats.pendingTransactions).toBe(3);
  });
});
