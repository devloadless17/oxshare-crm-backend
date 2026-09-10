import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';

/**
 * THE LEDGER REFUSES UPDATE AND DELETE — asserted by ATTEMPTING THEM.
 *
 * ARCHITECTURE §6.4, rule 4 of the four money rules: "No UPDATE, no DELETE on
 * ledger_entries. Ever." Corrections are compensating rows.
 *
 * ## Why this file exists when a test already claimed to cover it
 *
 * `money-schema-constraints.spec.ts` has a case called "keeps the ledger
 * append-only in the shape callers actually use". It INSERTS a row and counts
 * it. It never attempts an UPDATE or a DELETE — so it passes exactly as well
 * with the protection as without it, and it did: the triggers have been absent
 * since migration 0033 and that case stayed green throughout.
 *
 * A test for a prohibition has to perform the prohibited act. Anything else is
 * a test of the permitted one wearing the prohibition's name.
 *
 * ## What was actually missing
 *
 *   0002  creates ledger_entries AND the two append-only triggers
 *   0028  DROPS the table — which drops its triggers with it
 *   0033  recreates the table, and does not recreate the triggers
 *
 * So every database that ran the money rebuild lost the guarantee, silently,
 * with no migration mentioning it and no test failing. The sibling protection —
 * revoking UPDATE/DELETE from the application role — survived, because it is
 * granted on the table by a later migration rather than attached to it. That is
 * why this was invisible: the app itself still could not mutate the ledger.
 *
 * The trigger is not redundant with the grant, and 0002 says why in its own
 * comment: a trigger "holds even for a superuser connection, which is what local
 * dev and migrations run as". Local dev connects as a superuser here, so on a
 * developer's machine the ledger had no protection of either kind.
 */

let ctx: HttpTestContext;

beforeAll(async () => {
  ctx = await startHttpTestApp();
}, 120_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

/** Run `work` and return the error message, or '' when it unexpectedly succeeded. */
async function refusalFrom(work: Promise<unknown>): Promise<string> {
  try {
    await work;
    return '';
  } catch (error) {
    const parts: string[] = [];
    let cursor: unknown = error;
    while (cursor instanceof Error) {
      parts.push(cursor.message);
      cursor = (cursor as { cause?: unknown }).cause;
    }
    return parts.join(' | ');
  }
}

describe('ledger_entries is append-only', () => {
  let walletId: string;

  beforeAll(async () => {
    const { rows: userRows } = await ctx.db.db.execute<{ id: string }>(sql`
      INSERT INTO users (email, password_hash, first_name, last_name)
      VALUES ('ledger-trigger@test.local', 'x', 'Ledger', 'Trigger')
      RETURNING id
    `);
    const { rows: walletRows } = await ctx.db.db.execute<{ id: string }>(sql`
      INSERT INTO wallets (user_id, currency, balance)
      VALUES (${userRows[0].id}, 'USD', '100')
      RETURNING id
    `);
    walletId = walletRows[0].id;

    await ctx.db.db.execute(sql`
      INSERT INTO ledger_entries (wallet_id, amount, balance_after, entry_type, reference_type, reference_id)
      VALUES (${walletId}, '100', '100', 'deposit', 'transaction', 'trigger-probe-1')
    `);
  }, 60_000);

  it('has the two guard triggers attached to the table', async () => {
    /*
     * Asserted directly as well as behaviourally, because the behavioural
     * assertions below would also pass if a FUTURE protection replaced the
     * trigger — and this is the one that says WHICH mechanism is present, so a
     * table recreated without it fails here naming the thing to restore.
     */
    const { rows } = await ctx.db.db.execute<{ tgname: string }>(sql`
      SELECT tgname FROM pg_trigger
      WHERE tgrelid = 'ledger_entries'::regclass AND NOT tgisinternal
      ORDER BY tgname
    `);
    const names = rows.map((r) => r.tgname);

    expect(
      names,
      'ledger_entries has no append-only trigger. 0028 dropped the table and 0033 ' +
        'recreated it without them — see the header of this file.',
    ).toContain('ledger_entries_no_delete');
    expect(names).toContain('ledger_entries_no_update');
  });

  it('REFUSES an UPDATE, naming the rule', async () => {
    const refusal = await refusalFrom(
      ctx.db.db.execute(sql`UPDATE ledger_entries SET amount = '1' WHERE wallet_id = ${walletId}`),
    );

    expect(refusal, 'an UPDATE on ledger_entries succeeded').not.toBe('');
    expect(refusal).toMatch(/append-only/i);
  });

  it('REFUSES a DELETE, naming the rule', async () => {
    const refusal = await refusalFrom(
      ctx.db.db.execute(sql`DELETE FROM ledger_entries WHERE wallet_id = ${walletId}`),
    );

    expect(refusal, 'a DELETE on ledger_entries succeeded').not.toBe('');
    expect(refusal).toMatch(/append-only/i);
  });

  it('still ACCEPTS an append — the control', async () => {
    /*
     * Without this the two refusals above would also pass against a table that
     * rejects every write, which is a broken money system rather than a
     * protected one. Corrections are compensating ROWS, so appending must work.
     */
    await ctx.db.db.execute(sql`
      INSERT INTO ledger_entries (wallet_id, amount, balance_after, entry_type, reference_type, reference_id)
      VALUES (${walletId}, '-100', '0', 'adjustment', 'transaction', 'trigger-probe-compensating')
    `);

    const { rows } = await ctx.db.db.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM ledger_entries WHERE wallet_id = ${walletId}`,
    );
    expect(rows[0].count, 'the compensating row did not land').toBe(2);
  });
});
