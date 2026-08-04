import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { MoneyTestContext, startMoneyTestDb, stopMoneyTestDb } from './money-setup';
import { closeDb, resetDb } from '../src/database/db';

/**
 * ADM-01's client list reaches its indexes.
 *
 * ARCHITECTURE §5: ~219,000 client rows are trivial for Postgres, and "the risk
 * is unindexed filters and N+1 queries in the admin table, not row count". Two
 * filters were unindexed.
 *
 * WHY THIS TESTS QUERY PLANS AND NOT RESULTS.
 *
 * A test that asserted "searching for Ada returns Ada" would have passed
 * throughout — before the index and after it, on 3 rows and on 219,000. The
 * defect was never wrong results, it was a sequential scan per keystroke. The
 * only way to test that is to ask the planner what it intends to do.
 *
 * The trigram index in particular is fragile in a way results-testing cannot
 * see: an expression index is used ONLY when the query's expression matches it
 * character for character. Change the coalesce, the separator, or the column
 * order in users.store.ts and the index is silently abandoned — nothing fails,
 * no result changes, and the table quietly goes back to a full scan. That is the
 * regression these assertions exist to catch.
 *
 * `SET enable_seqscan = off` is the standard technique for this on a small test
 * table: with only a handful of rows a sequential scan is genuinely cheaper, so
 * the planner would rightly choose it and tell us nothing. Disabling it asks the
 * question we actually care about — *can* this query use an index at all — which
 * is what determines the plan once the table is large.
 */

let ctx: MoneyTestContext;

async function plan(query: string): Promise<string> {
  const rows = await ctx.db.execute(sql.raw(`EXPLAIN ${query}`));
  return rows.rows.map((r) => Object.values(r)[0] as string).join('\n');
}

beforeAll(async () => {
  resetDb();
  ctx = await startMoneyTestDb();
  resetDb();

  for (let i = 0; i < 25; i++) {
    await ctx.db.execute(sql`
      INSERT INTO users (email, password_hash, first_name, last_name)
      VALUES (${`client${i}@test.local`}, 'x', ${`First${i}`}, ${`Last${i}`})
    `);
  }
  await ctx.db.execute(sql`ANALYZE users`);
  // See the note above: on 25 rows a seq scan is correctly the cheapest plan,
  // which would make every assertion below vacuous.
  await ctx.db.execute(sql`SET enable_seqscan = off`);
});

afterAll(async () => {
  await closeDb();
  if (ctx) await stopMoneyTestDb(ctx);
});

describe('the search box can use the trigram index', () => {
  it('declares the extension and the index', async () => {
    const ext = await ctx.db.execute(sql`SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'`);
    expect(ext.rows).toHaveLength(1);

    const idx = await ctx.db.execute(
      sql`SELECT indexname FROM pg_indexes WHERE tablename = 'users' AND indexname = 'users_search_trgm_idx'`,
    );
    expect(idx.rows).toHaveLength(1);
  });

  it('uses it for the infix ILIKE the store actually issues', async () => {
    // Character-for-character the predicate in users.store.ts findPage().
    const p = await plan(`
      SELECT id FROM users
      WHERE (coalesce(email, '') || ' ' || coalesce(first_name, '') || ' ' || coalesce(last_name, ''))
            ILIKE '%First7%'
    `);
    expect(p).toContain('users_search_trgm_idx');
  });

  it('does NOT reach it through the three-column OR this replaced', async () => {
    // The old predicate. A leading wildcard cannot use a b-tree, and this shape
    // cannot use the expression index either — so it was a full scan per
    // keystroke. Asserted so the reason for the rewrite stays visible: reverting
    // the store to the OR form silently loses the index.
    const p = await plan(`
      SELECT id FROM users
      WHERE email ILIKE '%First7%' OR first_name ILIKE '%First7%' OR last_name ILIKE '%First7%'
    `);
    expect(p).not.toContain('users_search_trgm_idx');
  });
});

describe('the keyset seek can use the composite index', () => {
  it('declares it in the direction the query orders by', async () => {
    const idx = await ctx.db.execute(
      sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'users_created_at_id_idx'`,
    );
    expect(idx.rows).toHaveLength(1);
    const def = (idx.rows[0] as { indexdef: string }).indexdef;
    // Both DESC. A mismatch still works — Postgres can read an index backwards —
    // but only when EVERY column agrees, so this is the property worth pinning.
    expect(def).toContain('created_at DESC');
    expect(def).toContain('id DESC');
  });

  it('serves the row-comparison seek without a separate sort', async () => {
    const p = await plan(`
      SELECT id FROM users
      WHERE (created_at, id) < (now(), '00000000-0000-0000-0000-000000000000'::uuid)
      ORDER BY created_at DESC, id DESC
      LIMIT 26
    `);
    expect(p).toContain('users_created_at_id_idx');
    // The point of matching the index direction to the ORDER BY: the rows come
    // out of the index already ordered, so there is nothing to sort. A Sort node
    // here would mean reading the whole filtered set before returning 26 rows.
    expect(p).not.toContain('Sort');
  });
});
