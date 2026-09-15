import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * THE SEARCH BOXES STAY INDEXED AT VOLUME — measured, not asserted in a comment.
 *
 * ## Why a plan test rather than a stopwatch
 *
 * ARCHITECTURE §5 is explicit that ~219,000 client rows are trivial for
 * Postgres and that "the risk is unindexed filters and N+1 queries in the admin
 * table, not row count". Every free-text filter in this system is an infix
 * `ILIKE '%term%'`, which no b-tree can serve, so each one is carried by a
 * pg_trgm GIN index — and Postgres uses an expression index ONLY when the query
 * expression matches the one it was built on, character for character.
 *
 * That makes the failure mode silent and specific. Reorder the concatenation,
 * split it into three ORed ILIKEs, add a `coalesce` the index does not have, and
 * every test still passes, every row still comes back, and the query becomes a
 * sequential scan over the whole table on every keystroke. Four source comments
 * warn about it. Nothing checked it.
 *
 * A wall-clock assertion would not check it either: at test volume a sequential
 * scan is fast, and at CI volume a timing threshold is a flake. So this asks the
 * PLANNER what it intends to do, which is the thing that actually changes.
 *
 * ## The volume, and why this is the honest number
 *
 * 20,000 users and 20,000 audit rows. Not 219,000 — that is a five-minute
 * fixture for no extra signal, because what decides the plan is the ratio
 * between the matching rows and the table, and that is already decisive here.
 * Measured on this fixture (WSL2, shared container, 15 Sep 2026): a trigram
 * lookup over 20k users returns in single-digit milliseconds, a sequential scan
 * of the same table in ~15 ms. The scan is not slow yet — which is the whole
 * point. It gets slower every row, and nobody notices until it is the incident.
 *
 * ## What a failure here means
 *
 * A `Seq Scan` in one of these plans is a filter that has silently stopped being
 * indexed. Fix the QUERY to match the index, or add the index the new query
 * needs — do not relax the assertion.
 */

let ctx: MoneyTestContext;

/** The expression `users.store.ts` searches on, and `0010` indexed. */
const USER_SEARCH = sql`(coalesce(email, '') || ' ' || coalesce(first_name, '') || ' ' || coalesce(last_name, ''))`;

const ROWS = 20_000;
/** A search an operator actually runs finds ONE person, not a quarter of the base. */
const RARE = 5;

let rareSubjectId: string;

async function plan(query: ReturnType<typeof sql>): Promise<string> {
  const { rows } = await ctx.db.execute<{ 'QUERY PLAN': string }>(
    sql`EXPLAIN (ANALYZE, BUFFERS) ${query}`,
  );
  return rows.map((r) => r['QUERY PLAN']).join('\n');
}

/**
 * The plan Postgres produces when a sequential scan is made expensive.
 *
 * ## Why this, and not only the natural plan
 *
 * Two different questions hide behind "is this filter indexed":
 *
 *   CAN the index serve this query?   — a fact about the expressions matching
 *   WILL the planner choose it?       — a fact about table size and statistics
 *
 * The defect 0125 fixed is the FIRST one, and only the first one is stable
 * enough to assert. 0124's index was built on a varchar expression while the
 * query is rewritten to text, so no plan at any size could ever use it — while
 * `\d audit_log` listed it and every review saw an indexed column.
 *
 * The second question has a legitimate answer of "no" at test volume: 20,000
 * audit rows are 426 pages, and reading all of them costs less than a bitmap
 * scan plus a sort. That is Postgres being right, and pinning it would be
 * pinning the fixture — it flips with the row count, the page size, the
 * statistics target and the Postgres version.
 *
 * So usability is asserted HARD, here, everywhere. The one case where the
 * planner already prefers the index at this volume is asserted separately and
 * says so.
 *
 * `enable_seqscan = off` is a cost penalty rather than a prohibition: Postgres
 * still falls back to a scan when NO index path exists. That is exactly what
 * makes it the right instrument — an unusable index still reads `Seq Scan`.
 */
async function planWithoutSeqScan(query: ReturnType<typeof sql>): Promise<string> {
  await ctx.db.execute(sql`SET enable_seqscan = off`);
  try {
    return await plan(query);
  } finally {
    await ctx.db.execute(sql`SET enable_seqscan = on`);
  }
}

beforeAll(async () => {
  ctx = await startMoneyTestDb();

  /*
   * One statement, not 20,000 round trips. `generate_series` builds the rows
   * inside Postgres; inserting them from JavaScript would make the fixture the
   * slowest part of the suite by an order of magnitude.
   *
   * The names are spread across a small alphabet rather than being identical:
   * a table where every row matches every search tells the planner nothing, and
   * an index scan returning the whole table is a sequential scan with extra
   * steps.
   */
  await ctx.db.execute(sql`
    INSERT INTO users (email, password_hash, first_name, last_name)
    SELECT
      'scale-' || i || '@oxshare-e2e.test',
      'x',
      (ARRAY['Alexandra','Bruce','Carla','Dmitri','Elena','Fadi','Georges','Hana'])[1 + (i % 8)],
      (ARRAY['Nolan','Mansour','Haddad','Khoury','Aoun','Saad','Rizk','Fares'])[1 + (i % 8)]
    FROM generate_series(1, ${ROWS}) AS i
  `);

  /*
   * A HANDFUL of rare names, and this is the part that makes the test mean
   * something rather than a detail of the fixture.
   *
   * An index is not automatically the cheaper plan. With a `LIMIT 25` over a
   * term matching a quarter of the table, a sequential scan finds twenty-five
   * matches in the first two hundred rows and Postgres correctly prefers it —
   * which is what the first version of this file measured, and it was measuring
   * the fixture. A real operator searching a real client base is looking for
   * ONE person among many, so the searched term has to be rare for the question
   * "is this filter indexed" to be the question being asked.
   */
  await ctx.db.execute(sql`
    INSERT INTO users (email, password_hash, first_name, last_name)
    SELECT 'rare-' || i || '@oxshare-e2e.test', 'x', 'Zephyrine', 'Quartermain'
    FROM generate_series(1, ${RARE}) AS i
  `);

  /*
   * The audit trail, spread across many actors and many subjects for the same
   * reason: a column holding one value is a column no index can help with, and
   * a test over one would prove nothing about the index it names.
   */
  const { rows: subjects } = await ctx.db.execute<{ id: string }>(sql`
    SELECT id FROM users ORDER BY created_at LIMIT 1
  `);
  rareSubjectId = subjects[0].id;

  await ctx.db.execute(sql`
    INSERT INTO audit_log (actor_id, actor_email, actor_kind, action, subject_type, subject_id)
    SELECT
      ${rareSubjectId},
      'operator-' || i || '@oxshare.com',
      'admin',
      'client.suspend',
      'user',
      gen_random_uuid()::text
    FROM generate_series(1, ${ROWS}) AS i
  `);

  // One operator and one subject with a SMALL history, which is the shape both
  // audit indexes exist to serve.
  await ctx.db.execute(sql`
    INSERT INTO audit_log (actor_id, actor_email, actor_kind, action, subject_type, subject_id)
    SELECT ${rareSubjectId}, 'zephyrine.reviewer@oxshare.com', 'admin',
           'kyc.approve', 'user', ${rareSubjectId}
    FROM generate_series(1, 5) AS i
  `);

  /*
   * WALLETS AND LEDGER ENTRIES for the money-list joins.
   *
   * Without them those tables are empty, the planner drives the join from the
   * empty side, and the client index is never reached — so the test passes or
   * fails on the shape of an empty table rather than on the predicate. One
   * wallet each and one entry each is enough: what is being asked is which
   * index the FILTER can use, not how deep the join goes.
   */
  await ctx.db.execute(sql`
    INSERT INTO wallets (user_id, currency, kind, balance)
    SELECT id, 'USD', 'main', '0' FROM users
  `);
  await ctx.db.execute(sql`
    INSERT INTO ledger_entries
      (wallet_id, entry_type, amount, balance_after, reference_type, reference_id)
    SELECT id, 'adjustment', '0', '0', 'manual', gen_random_uuid()::text FROM wallets
  `);

  /*
   * ANALYZE, and it is not optional.
   *
   * A freshly-bulk-loaded table has no statistics, so the planner guesses — and
   * its guess for an unfamiliar table is often a sequential scan whatever the
   * indexes say. Without this the test would fail against correct code, which is
   * the worst kind of red.
   */
  await ctx.db.execute(sql`ANALYZE users`);
  await ctx.db.execute(sql`ANALYZE audit_log`);
  await ctx.db.execute(sql`ANALYZE wallets`);
  await ctx.db.execute(sql`ANALYZE ledger_entries`);
}, 300_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

describe('the measured expression is the SHIPPED expression', () => {
  /*
   * THE WEAKNESS THIS CLOSES.
   *
   * Every plan below is measured against SQL written in this file. That proves
   * the INDEX can serve that SQL — and proves nothing about the query the
   * application actually sends. If `wallet.service.ts` reorders its
   * concatenation tomorrow, the plans here stay green and the product goes back
   * to a sequential scan, which is the precise failure mode this file exists
   * for. So the two are tied together: the predicate measured here has to
   * appear, character for character, in the source that sends it.
   *
   * A string comparison rather than a `.toSQL()` round trip because these are
   * `sql` template fragments built inside methods that execute them — there is
   * no query object to intercept without changing the production code to be
   * testable, which trades a real design for a test convenience.
   */
  const CLIENT_PREDICATE =
    "(coalesce(${users.email}, '') || ' ' || coalesce(${users.firstName}, '') || ' ' || " +
    "coalesce(${users.lastName}, '')) ILIKE";

  const senders = [
    'src/store/users.store.ts',
    'src/modules/wallet/wallet.service.ts',
    'src/modules/admin/admin-holdings.service.ts',
  ];

  it.each(senders)('%s searches clients on the indexed expression', (file) => {
    const source = readFileSync(file, 'utf8').replace(/\s+/g, ' ');
    expect(
      source.includes(CLIENT_PREDICATE.replace(/\s+/g, ' ')),
      `${file} no longer sends the expression \`users_search_trgm_idx\` was built on. ` +
        'Either restore it or add the index the new expression needs — a mismatch is a ' +
        'sequential scan with no error and no warning.',
    ).toBe(true);
  });

  it('the audit actor search keeps its ::text cast', () => {
    // 0124 shipped the index without it and 0125 rebuilt it with one. The two
    // halves have to agree, and this is the half that lives in TypeScript.
    const source = readFileSync('src/store/audit-log.store.ts', 'utf8');
    expect(
      source.includes("coalesce(${auditLog.actorEmail}, '')::text) ILIKE"),
      'the audit actor search lost its ::text cast — see 0125, the index cannot be used without it.',
    ).toBe(true);
  });

  it('the ledger tells the planner its LEFT join cannot match a missing client', () => {
    const source = readFileSync('src/modules/wallet/wallet.service.ts', 'utf8');
    expect(
      source.includes('conditions.push(isNotNull(users.id));'),
      'the ledger search lost `isNotNull(users.id)`, so Postgres can no longer convert its ' +
        'LEFT join and will hash-join every client before filtering.',
    ).toBe(true);
  });

  it('names sources that exist', () => {
    // A stale path would make the checks above pass by testing a file that is
    // no longer there — `readFileSync` throws, so this is the guard that the
    // guard is pointed at something.
    for (const file of [...senders, 'src/store/audit-log.store.ts']) {
      expect(() => readFileSync(file, 'utf8')).not.toThrow();
    }
  });
});

describe('the fixture is big enough for the planner to have a choice', () => {
  it('holds enough rows that a sequential scan is not simply the cheapest option', async () => {
    // The non-vacuity floor. Below a few thousand rows Postgres will prefer a
    // sequential scan no matter how correct the index is, and every assertion
    // below would then be testing the fixture rather than the query.
    const { rows } = await ctx.db.execute<{ n: string }>(sql`SELECT count(*) AS n FROM users`);
    expect(Number(rows[0].n)).toBeGreaterThanOrEqual(ROWS);
  });

  it('the searched term matches a HANDFUL of rows, as a real search does', async () => {
    // An index scan that returns a quarter of the table is a sequential scan
    // with extra steps, and the planner knows it. This is the floor that keeps
    // the plan assertions below asking about the index rather than about the
    // selectivity of a made-up fixture.
    const { rows } = await ctx.db.execute<{ n: string }>(sql`
      SELECT count(*) AS n FROM users WHERE ${USER_SEARCH} ILIKE '%zephyrine%'
    `);
    const matched = Number(rows[0].n);
    expect(matched).toBe(RARE);
    expect(matched / ROWS).toBeLessThan(0.001);
  });
});

describe('the client search is served by the trigram index', () => {
  it('CAN be served by the index — the property 0124 got wrong', async () => {
    const text = await planWithoutSeqScan(sql`
      SELECT id FROM users WHERE ${USER_SEARCH} ILIKE '%zephyrine%' LIMIT 25
    `);
    expect(text, `the client search cannot use its index:\n${text}`).toMatch(
      /users_search_trgm_idx/,
    );
  });

  it('and the planner already CHOOSES it at twenty thousand clients', async () => {
    // The second question, asserted where the answer is already yes. This is
    // the measurement rather than the contract: it says the index is not merely
    // usable but winning, at a volume two orders below the ~219,000 §5 names.
    const text = await plan(sql`
      SELECT id FROM users WHERE ${USER_SEARCH} ILIKE '%zephyrine%' LIMIT 25
    `);
    expect(text, `the client search fell back to a scan:\n${text}`).not.toMatch(
      /Seq Scan on users/,
    );
    expect(text).toMatch(/users_search_trgm_idx/);
  });

  it('a REORDERED expression is NOT served by it — the trap, demonstrated', async () => {
    /*
     * The same rows, the same result, a different plan. This is the failure the
     * four source comments warn about, and it is here so the next person can
     * see it rather than take it on trust: swap first and last name in the
     * concatenation and Postgres cannot use the index at all.
     *
     * Asserted as a SCAN deliberately. If this ever stops being a scan the
     * index has been changed, and the queries were written against the old one.
     */
    const reordered = sql`(coalesce(first_name, '') || ' ' || coalesce(email, '') || ' ' || coalesce(last_name, ''))`;
    const text = await planWithoutSeqScan(sql`
      SELECT id FROM users WHERE ${reordered} ILIKE '%zephyrine%' LIMIT 25
    `);
    // Even with a sequential scan made expensive, there is no index path to
    // take — which is the whole point.
    expect(text, `a reordered expression unexpectedly used an index:\n${text}`).toMatch(
      /Seq Scan on users/,
    );
  });
});

describe('the money lists search the OWNER through the same index', () => {
  it('the wallets desk does not read every client to filter one', async () => {
    // `admin-holdings.service.ts` joins `users` and filters on the indexed
    // expression. The join is what makes this the same index, and writing the
    // predicate against the joined table is what keeps it usable.
    const text = await planWithoutSeqScan(sql`
      SELECT w.id
      FROM wallets w
      JOIN users u ON u.id = w.user_id
      WHERE (coalesce(u.email, '') || ' ' || coalesce(u.first_name, '') || ' ' || coalesce(u.last_name, ''))
            ILIKE '%zephyrine%'
      LIMIT 25
    `);
    expect(text, `the wallets search cannot use the client index:\n${text}`).toMatch(
      /users_search_trgm_idx/,
    );
  });

  it('the ledger does not read every client to name one', async () => {
    /*
     * `u.id IS NOT NULL` beside the search, exactly as `wallet.service.ts`
     * writes it, and this case is why that line exists.
     *
     * The ledger joins `users` LEFT so an entry whose client row has gone still
     * appears. Postgres converts LEFT to INNER — and so starts from the trigram
     * index — only when it can prove the filter rejects a NULL-extended row,
     * and the `coalesce`d expression evaluates to `'  '` rather than NULL for a
     * missing client, so it cannot. Without this line the measured plan
     * hash-joined all 20,000 users and filtered afterwards.
     */
    const text = await planWithoutSeqScan(sql`
      SELECT le.id
      FROM ledger_entries le
      JOIN wallets w ON w.id = le.wallet_id
      LEFT JOIN users u ON u.id = w.user_id
      WHERE u.id IS NOT NULL
        AND (coalesce(u.email, '') || ' ' || coalesce(u.first_name, '') || ' ' || coalesce(u.last_name, ''))
            ILIKE '%zephyrine%'
      LIMIT 25
    `);
    expect(text, `the ledger search cannot use the client index:\n${text}`).toMatch(
      /users_search_trgm_idx/,
    );
  });
});

describe('the audit log stays investigable as it grows', () => {
  it('finds an administrator without reading the whole trail', async () => {
    /*
     * The one table guaranteed to become the largest here: append-only and
     * never pruned. An unindexed actor search is the §5 risk in its worst
     * location — it gets slower every day and the only symptom is a slow page.
     */
    /*
     * NO `ORDER BY` here, deliberately, and it is the difference between two
     * questions again.
     *
     * With `ORDER BY created_at DESC LIMIT 25` the planner has a second, very
     * attractive option: walk `audit_log_created_at_idx` backwards and filter as
     * it goes, which returns the first 25 matches without sorting anything. That
     * is a reasonable plan and it tells us nothing about whether the TRIGRAM
     * index can serve the predicate — which is the fact 0124 got wrong.
     *
     * So the predicate is asked on its own.
     */
    const text = await planWithoutSeqScan(sql`
      SELECT id FROM audit_log
      WHERE (coalesce(actor_email, '')::text) ILIKE '%zephyrine.reviewer%'
    `);
    /*
     * THE CASE THIS WHOLE FILE WAS WRITTEN FOR. 0124 built this index on a
     * VARCHAR expression while `ILIKE` rewrites the query to `text`, so no plan
     * at any size could use it — and nothing said so: the index existed, was
     * listed, and was reviewed. This is red against that version and green
     * against 0125.
     */
    expect(text, `the audit actor search cannot use its index:\n${text}`).toMatch(
      /audit_log_actor_email_trgm_idx/,
    );
  });

  it('reads one client’s history newest-first without sorting the whole trail', async () => {
    /*
     * `(subject_id, created_at DESC)` is composite for this read specifically.
     * With an index on `subject_id` alone Postgres finds the rows and then
     * SORTS them, which on a client with years of history is the work the
     * composite exists to avoid.
     */
    const text = await planWithoutSeqScan(sql`
      SELECT id FROM audit_log WHERE subject_id = ${rareSubjectId}
      ORDER BY created_at DESC LIMIT 25
    `);
    expect(text, `the subject read cannot use its index:\n${text}`).toMatch(
      /audit_log_subject_id_created_at_idx/,
    );
    /*
     * A `Sort` above this is not a failure and is not asserted against. At five
     * rows Postgres takes a BITMAP scan, which does not preserve index order, so
     * a quicksort of five rows follows — cheaper than the ordered scan. The
     * composite earns its keep at depth, where the alternative is sorting a
     * client's whole history; what is pinned here is that the read reaches the
     * index built for it rather than one that merely contains the column.
     */
  });
});
