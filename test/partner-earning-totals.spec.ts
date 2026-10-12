import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { IbStore } from '../src/store/ib.store';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * A PARTNER'S EARNINGS ARE KEPT TOTALS (0217), AND MUST EQUAL THE ACCRUALS.
 *
 * The Partners list reads `ib_partner_earning_totals` plus the changes not yet
 * folded into it, never the accruals themselves. A kept figure that drifts from
 * its rows is a wrong amount of money on screen with nothing saying so, so
 * every way an accrual can change is checked against the accruals summed live:
 * written, confirmed, reversed, deleted, paid to a client instead, folded and
 * not folded.
 */

let ctx: MoneyTestContext;
let store: IbStore;
let partner: number;
let other: number;
let client: number;
let seq = 0;

async function makeUser(email: string): Promise<number> {
  const { rows } = await ctx.db.execute<{ id: number }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name)
    VALUES (${email}, 'x', 'Test', 'Person') RETURNING id`);
  return rows[0].id;
}

async function accrue(
  ibUserId: number,
  amount: string,
  opts: { status?: string; currency?: string; paidToClient?: boolean } = {},
): Promise<string> {
  seq += 1;
  const sourceId = `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
  const { rows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO ib_accruals (ib_user_id, client_user_id, source_type, source_id, depth,
                             rate_value, base_amount, amount, currency, status, paid_to_client)
    VALUES (${ibUserId}, ${client}, 'deal', ${sourceId}, 1, '10.0000', '100.00000000',
            ${amount}, ${opts.currency ?? 'USD'},
            ${opts.status ?? 'pending'}::ib_accrual_status, ${opts.paidToClient ?? false})
    RETURNING id`);
  return rows[0].id;
}

/** What the accruals themselves say — the figure the kept totals must match. */
async function live(ibUserId: number): Promise<Record<string, string>> {
  const { rows } = await ctx.db.execute<{ key: string; amount: string }>(sql`
    SELECT currency || ':' || status AS key, sum(amount)::text AS amount
      FROM ib_accruals
     WHERE ib_user_id = ${ibUserId} AND NOT paid_to_client AND status IN ('confirmed', 'pending')
     GROUP BY currency, status`);
  return Object.fromEntries(rows.map((r) => [r.key, r.amount]));
}

async function kept(ibUserId: number): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of (await store.earningsByPartner([ibUserId, other])).get(ibUserId) ?? []) {
    if (entry.confirmed !== '0') out[`${entry.currency}:confirmed`] = entry.confirmed;
    if (entry.pending !== '0') out[`${entry.currency}:pending`] = entry.pending;
  }
  return out;
}

const fold = () => ctx.db.execute(sql`SELECT fold_partner_earnings()`);

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  store = new IbStore(ctx.db);
  partner = await makeUser('earn-partner@oxshare.test');
  other = await makeUser('earn-other@oxshare.test');
  client = await makeUser('earn-client@oxshare.test');
}, 120_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

describe('kept partner earnings equal the accruals', () => {
  it('through every change, before and after a fold', async () => {
    const a = await accrue(partner, '7.00000000');
    const b = await accrue(partner, '3.50000000');
    await accrue(partner, '2.00000000', { currency: 'USDT', status: 'confirmed' });
    // Another partner's money, and a legacy rebate paid to a client: never counted here.
    await accrue(other, '99.00000000', { status: 'confirmed' });
    await accrue(partner, '50.00000000', { status: 'confirmed', paidToClient: true });
    expect(await kept(partner)).toEqual(await live(partner));
    expect(await kept(partner)).toEqual({
      'USD:pending': '10.50000000',
      'USDT:confirmed': '2.00000000',
    });

    await fold();
    expect(await kept(partner)).toEqual(await live(partner));

    // Confirmed, then reversed (which leaves both figures), then one deleted.
    await ctx.db.execute(sql`UPDATE ib_accruals SET status = 'confirmed' WHERE id = ${a}::uuid`);
    expect(await kept(partner)).toEqual(await live(partner));
    await ctx.db.execute(sql`UPDATE ib_accruals SET status = 'reversed' WHERE id = ${a}::uuid`);
    await ctx.db.execute(sql`DELETE FROM ib_accruals WHERE id = ${b}::uuid`);
    expect(await kept(partner)).toEqual(await live(partner));
    expect(await kept(partner)).toEqual({ 'USDT:confirmed': '2.00000000' });

    await fold();
    await fold(); // a second fold moves nothing
    expect(await kept(partner)).toEqual(await live(partner));
    expect(await kept(other)).toEqual({ 'USD:confirmed': '99.00000000' });
  });

  it('a change that moves no money writes nothing', async () => {
    await fold();
    await ctx.db.execute(sql`UPDATE ib_accruals SET confirm_attempts = confirm_attempts + 1`);
    const { rows } = await ctx.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM ib_partner_earning_deltas`,
    );
    expect(rows[0].n).toBe(0);
  });

  it('emptying the accruals empties the totals', async () => {
    await ctx.db.execute(sql`TRUNCATE ib_accruals CASCADE`);
    expect(await kept(partner)).toEqual({});
    expect(await kept(other)).toEqual({});
  });
});
