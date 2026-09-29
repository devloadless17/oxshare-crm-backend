import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { MoneyTestContext, startMoneyTestDb, stopMoneyTestDb } from './money-setup';
import { closeDb, resetDb } from '../src/database/db';
import { CLIENT_SORT_COLUMNS } from '../src/store/users.store';

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
      WHERE (created_at, id) < (now(), 2147483647)
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

/**
 * R-2.5's other half: "every sortable column is indexed, and the allowlist may
 * not exceed them."
 *
 * DERIVED FROM `CLIENT_SORT_COLUMNS`, not from a list written here. A hand-kept
 * copy would need the same discipline it exists to replace — the failure mode
 * is somebody adding a sort key and not thinking about the index, and they will
 * not think about this file either. Reading the allowlist means a new key
 * arrives in this test automatically and fails until migration 0024 gains its
 * index.
 *
 * What a missing index costs is invisible in every other kind of test: the
 * results are identical, and the query plan quietly becomes a sort over 219,000
 * rows on every page of every filter. Verified to bite — pointing one of these
 * at `phone`, which has no composite index, fails with "ORDER BY phone fell
 * back to a sort".
 */
describe('every sortable column can be seeked and ordered by an index', () => {
  /** The SQL expression each allowlist key maps to, mirroring users.store.ts. */
  const EXPRESSIONS: Record<string, string> = {
    createdAt: 'created_at',
    email: 'email',
    firstName: 'first_name',
    status: 'status',
    /*
     * `type` is NOT here any more, and the allowlist no longer carries it.
     *
     * The column it sorted — `users.type` — is a label nothing maintained, and
     * the list now DERIVES the type from `ib_accounts` and
     * `referred_by_ib_user_id` instead (see `DERIVED_CLIENT_TYPE`). Sorting by
     * the stale column would order the screen by values it no longer displays,
     * and sorting by the derived CASE would fall back to a sort over every
     * client — which is exactly what this suite exists to refuse.
     *
     * Making it sortable again means an index on that expression, and this
     * assertion is where that has to be proved.
     */
    verificationLevel: 'verification_level',
    // Not the bare column: it is nullable, and `(country, id) < (?, ?)` is
    // UNKNOWN rather than false for every null row, so those clients would
    // silently vanish from the list. Migration 0024's index is built on this
    // exact expression — change one and the other stops being used.
    country: "coalesce(country, '')",
  };

  it('covers every key in the allowlist, so this cannot pass vacuously', () => {
    expect(Object.keys(EXPRESSIONS).sort()).toEqual(Object.keys(CLIENT_SORT_COLUMNS).sort());
  });

  for (const [key, expression] of Object.entries(EXPRESSIONS)) {
    it(`sorts by ${key} from an index, with no Sort node`, async () => {
      const p = await plan(`
        SELECT id FROM users
        ORDER BY ${expression} DESC, id DESC
        LIMIT 26
      `);
      expect(p, `ORDER BY ${expression} fell back to a sort`).not.toContain('Sort');
      expect(p).toContain('Index');
    });

    it(`seeks past a cursor on ${key} using an index`, async () => {
      // The keyset seek itself, in the shape `findPage` issues it. An index
      // that serves the ORDER BY but not the row comparison would still make
      // page two a scan.
      const probe =
        key === 'createdAt'
          ? '(now(), 2147483647)'
          : key === 'verificationLevel'
            ? '(1, 2147483647)'
            : "('zzz', 2147483647)";
      const column =
        key === 'createdAt' || key === 'verificationLevel' ? expression : `${expression}::text`;

      const p = await plan(`
        SELECT id FROM users
        WHERE (${column}, id) < ${probe}
        ORDER BY ${expression} DESC, id DESC
        LIMIT 26
      `);
      expect(p).toContain('Index');
    });
  }
});
