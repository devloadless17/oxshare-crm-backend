import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { ledgerStatement } from '../src/modules/wallet/ledger-statement';
import { UNRESTRICTED } from '../src/common/security/client-scope';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * THE PERIOD STATEMENT (audit R4-G1): opening, every posting by type, closing — per currency and
 * wallet kind, from the ledger. Against a real database: the figures are SQL sums over posting
 * times, and a statement an accountant closes a month from must be exact to the cent.
 */
let ctx: MoneyTestContext;

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  const { rows: u } = await ctx.db.execute<{ id: number }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name)
    VALUES ('statement@test.local', 'x', 'State', 'Ment') RETURNING id`);
  // Posted by hand at known instants; the wallet holds what its ledger sums to (120).
  const { rows: w } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO wallets (user_id, currency, balance) VALUES (${u[0].id}, 'USD', '120')
    RETURNING id`);
  for (const [amount, type, at, after] of [
    ['100', 'deposit', '2026-09-01T10:00:00Z', '100'],
    ['-30', 'withdrawal', '2026-09-15T10:00:00Z', '70'],
    ['50', 'deposit', '2026-10-05T10:00:00Z', '120'],
  ] as const) {
    await ctx.db.execute(sql`
      INSERT INTO ledger_entries (wallet_id, amount, balance_after, entry_type, reference_type,
                                  reference_id, created_at)
      VALUES (${w[0].id}, ${amount}, ${after}, ${type}::ledger_entry_type, 'transaction',
              ${`st-${at}`}, ${at}::timestamptz)`);
  }
}, 180_000);
afterAll(async () => stopMoneyTestDb(ctx));

const usd = async (from?: string, until?: string) =>
  (
    await ledgerStatement(ctx.db, UNRESTRICTED, {
      from: from ? new Date(from) : undefined,
      until: until ? new Date(until) : undefined,
    })
  ).find((row) => row.currency === 'USD' && row.walletKind === 'main');

describe('the period statement', () => {
  it('September: nothing held at the start, a deposit in and a withdrawal out, 70 held at the end', async () => {
    const sept = await usd('2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z');
    expect(sept).toMatchObject({
      opening: '0.00000000',
      movement: '70.00000000',
      closing: '70.00000000',
    });
    expect(sept?.lines).toEqual([
      { entryType: 'deposit', flow: 'in', count: 1, total: '100.00000000' },
      { entryType: 'withdrawal', flow: 'out', count: 1, total: '30.00000000' },
    ]);
  });

  it('October opens with what September closed on', async () => {
    const oct = await usd('2026-10-01T00:00:00Z', '2026-11-01T00:00:00Z');
    expect(oct).toMatchObject({
      opening: '70.00000000',
      movement: '50.00000000',
      closing: '120.00000000',
    });
  });

  it('with no start, it is the client liabilities at the end', async () => {
    expect((await usd(undefined, '2026-09-20T00:00:00Z'))?.closing).toBe('70.00000000');
    expect((await usd())?.closing).toBe('120.00000000');
  });
});
