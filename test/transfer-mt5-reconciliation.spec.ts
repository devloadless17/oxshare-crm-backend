import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { ReconciliationService } from '../src/modules/wallet/reconciliation.service';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * Transfers ↔ MT5 deals (audit R3-1, 16 Oct 2026): the reconciliation report finds a settled
 * transfer MT5 never applied, and an MT5 deal whose transfer is not settled — the second is money
 * the client holds twice. Against a real database: the match is SQL on MT5's cut comment.
 */
let ctx: MoneyTestContext;

beforeAll(async () => {
  ctx = await startMoneyTestDb();
}, 180_000);
afterAll(async () => stopMoneyTestDb(ctx));

async function transfer(userId: number, walletId: string, accountId: string, state: string) {
  const { rows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO transfers (user_id, wallet_id, trading_account_id, direction, amount, currency,
                           state, settled_at, created_at, origin)
    VALUES (${userId}, ${walletId}, ${accountId}, 'wallet_to_account', '100', 'USD',
            ${state}::transfer_state, now() - interval '1 hour', now() - interval '1 hour', 'client')
    RETURNING id`);
  return rows[0].id;
}

async function deal(transferId: string, login: string, profit: string) {
  await ctx.db.execute(sql`
    INSERT INTO mt5_deals (mt5_deal_id, login, symbol, action, entry, volume, price, profit,
                           commission, swap, comment, dealt_at)
    VALUES (${`9${Math.floor(Math.random() * 1e12)}`}, ${login}, '', 2, 0, 0, 0, ${profit}, 0, 0,
            ${`CRM transfer ${transferId.slice(0, 18)}`}, now() - interval '1 hour')`);
}

describe('the reconciliation report checks every transfer against MT5', () => {
  it('names a settled transfer with no deal and a deal whose transfer failed — and only those', async () => {
    const { rows: u } = await ctx.db.execute<{ id: number }>(sql`
      INSERT INTO users (email, password_hash, first_name, last_name)
      VALUES ('recon-mt5@test.local', 'x', 'Recon', 'Client') RETURNING id`);
    const userId = u[0].id;
    const { rows: w } = await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO wallets (user_id, currency, balance) VALUES (${userId}, 'USD', '0') RETURNING id`);
    const { rows: a } = await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO trading_accounts (user_id, login, environment, currency, balance, status)
      VALUES (${userId}, '7700001', 'live', 'USD', '0', 'active') RETURNING id`);
    const [walletId, accountId] = [w[0].id, a[0].id];

    const matched = await transfer(userId, walletId, accountId, 'settled');
    await deal(matched, '7700001', '100');
    const noDeal = await transfer(userId, walletId, accountId, 'settled');
    const failedButApplied = await transfer(userId, walletId, accountId, 'failed');
    await deal(failedButApplied, '7700001', '100');

    const report = await new ReconciliationService(ctx.db).run();

    expect(report.balanced).toBe(false);
    expect(report.transferMismatchCount).toBe(2);
    expect(
      report.transferMismatches.map((m) => [m.kind, m.transferId, m.transferState]).sort(),
    ).toEqual(
      [
        ['deal_without_settled_transfer', failedButApplied, 'failed'],
        ['settled_without_deal', noDeal, 'settled'],
      ].sort(),
    );
    expect(report.transferMismatches.some((m) => m.transferId === matched)).toBe(false);
  });
});

describe('a deposit aimed at an account that never moved on is reported (audit R1-4)', () => {
  it('names a settled deposit no transfer took, and not one that moved', async () => {
    const { rows: u } = await ctx.db.execute<{ id: number }>(sql`
      INSERT INTO users (email, password_hash, first_name, last_name)
      VALUES ('stranded@test.local', 'x', 'Stranded', 'Client') RETURNING id`);
    const userId = u[0].id;
    const { rows: w } = await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO wallets (user_id, currency, balance) VALUES (${userId}, 'USD', '0') RETURNING id`);
    const { rows: a } = await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO trading_accounts (user_id, login, environment, currency, balance, status)
      VALUES (${userId}, '7700002', 'live', 'USD', '0', 'active') RETURNING id`);
    const deposit = async (ref: string) =>
      (
        await ctx.db.execute<{ id: string }>(sql`
          INSERT INTO transactions (user_id, wallet_id, direction, amount, currency, state,
                                    provider, provider_ref, destination_trading_account_id,
                                    settled_at, created_at)
          VALUES (${userId}, ${w[0].id}, 'deposit', '60', 'USD', 'success', 'manual_test', ${ref},
                  ${a[0].id}, now() - interval '1 hour', now() - interval '1 hour')
          RETURNING id`)
      ).rows[0].id;
    const stranded = await deposit('stranded-1');
    const moved = await deposit('moved-1');
    await ctx.db.execute(sql`
      INSERT INTO transfers (user_id, wallet_id, trading_account_id, direction, amount, currency,
                             state, settled_at, origin, source_transaction_id, request_ref)
      VALUES (${userId}, ${w[0].id}, ${a[0].id}, 'wallet_to_account', '60', 'USD', 'settled',
              now(), 'deposit', ${moved}, ${`deposit:${moved}`})`);

    const report = await new ReconciliationService(ctx.db).run();
    const ids = report.strandedDeposits.map((d) => d.transactionId);
    expect(ids).toContain(stranded);
    expect(ids).not.toContain(moved);
    expect(report.strandedDeposits.find((d) => d.transactionId === stranded)?.login).toBe(
      '7700002',
    );
  });
});
