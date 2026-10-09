import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { MoneyTestContext, startMoneyTestDb, stopMoneyTestDb } from './money-setup';
import { closeDb, resetDb } from '../src/database/db';
import {
  ADMIN_TRANSACTION_SORT_COLUMNS,
  WITHDRAWAL_SORT_COLUMNS,
} from '../src/modules/payments/transactions.service';
import { KYC_SORT_COLUMNS } from '../src/store/kyc.store';
import { AUDIT_SORT_COLUMNS } from '../src/store/audit-log.store';
import {
  IB_APPLICATION_SORT_COLUMNS,
  IB_PARTNER_SORT_COLUMNS,
  IB_ACCRUAL_SORT_COLUMNS,
} from '../src/store/ib.store';
import { ADMIN_SORT_COLUMNS } from '../src/store/admins.store';
import { ROLE_SORT_COLUMNS } from '../src/store/roles.store';
import {
  TRADING_ACCOUNT_SORT_COLUMNS,
  WALLET_SORT_COLUMNS,
} from '../src/modules/admin/admin-holdings.service';

/**
 * R-2.5's other half, for the six lists migration 0037 covers: "every sortable
 * column is indexed, and the allowlist may not exceed them."
 *
 * The sibling of `client-list-indexes.spec.ts`, which does this for the ADM-01
 * client index and migration 0024. Same technique and the same reasoning.
 *
 * ## Why this tests QUERY PLANS and not results
 *
 * A test asserting "sorting by amount returns them in order" passes before the
 * index and after it, on 25 rows and on 25 million. The defect a missing index
 * produces is not a wrong answer — it is a sort over the whole filtered set on
 * every page of every filter, which is invisible to every other kind of test.
 * The only way to see it is to ask the planner what it intends to do.
 *
 * `SET enable_seqscan = off` is the standard technique on a small test table:
 * with a handful of rows a sequential scan is genuinely cheaper, so the planner
 * would rightly choose it and the assertions would say nothing. Disabling it
 * asks the question that actually matters — CAN this ordering be served from an
 * index — which is what decides the plan once the table is large.
 *
 * ## The allowlists are IMPORTED, not retyped
 *
 * Each `EXPRESSIONS` map below is checked against the real `*_SORT_COLUMNS`
 * object, so a sort key added without an index arrives in this spec
 * automatically and fails until 0037 gains one. A hand-kept list would need the
 * same discipline it exists to replace: whoever forgets the index will also
 * forget to update a list in a test file.
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

  // Enough rows that the planner has something to consider, and ANALYZE so it
  // has statistics rather than guesses.
  for (const table of [
    'transactions',
    'kyc_submissions',
    'audit_log',
    'ib_applications',
    'ib_accounts',
    'admins',
    'roles',
    'transfers',
    'ib_wallet_transfers',
  ]) {
    await ctx.db.execute(sql.raw(`ANALYZE ${table}`));
  }
  await ctx.db.execute(sql`SET enable_seqscan = off`);
}, 120_000);

afterAll(async () => {
  await closeDb();
  if (ctx) await stopMoneyTestDb(ctx);
});

/**
 * One list's worth of assertions.
 *
 * @param table       the table the ORDER BY runs against, joined where the
 *                    query joins — the joined client columns are indexed on
 *                    `users`, so the plan must show an index there too.
 * @param tiebreak    the unique column the ORDER BY ends in.
 * @param expressions allowlist key → the SQL expression it maps to.
 * @param allowlist   the real `*_SORT_COLUMNS` object, so this cannot drift.
 */
/**
 * The (list, sort key) pairs allowed to order by a JOINED column.
 *
 * Frozen so the exemption is a decision rather than a consequence. Each orders a
 * queue by something on `users`, which no index on the base table can serve — so
 * the plan is asserted to USE an index without being asserted to avoid a sort.
 *
 * ⚠️ Some of these lists page by KEYSET. For them an unindexed ORDER BY means a
 * full sort of the filtered set on every page, which is precisely the cost
 * keyset paging was chosen to avoid. They are kept because sorting a review
 * queue by the person is what the desk actually does, and the sets are bounded
 * by the filters above them — but the next addition should answer that question
 * rather than inherit this answer.
 */
const JOINED_SORTS_EXEMPT = new Set<string>([
  // Keyset-paged. These are the three the bound was written for.
  'the withdrawal queue.userEmail',
  'the withdrawal queue.userFirstName',
  'the wallet list.userEmail',
  'the wallet list.userFirstName',
  'the trading-account list.userEmail',
  'the trading-account list.userFirstName',
  // Offset-paged, so an unindexed ORDER BY costs what offset already costs.
  'the KYC review queue.userEmail',
  'the KYC review queue.userFirstName',
  'the partner application queue.userEmail',
  'the partner application queue.userFirstName',
  'the partner list.userEmail',
  'the partner list.userFirstName',
]);

/**
 * Every exemption still names a live sort key.
 *
 * The other direction, for the reason the sibling censuses give: an exemption
 * for a key that no longer exists is a line that looks like diligence and
 * protects nothing. Collected as the suites run — `describeSortIndexes` records
 * each pair it sees — so this compares the list against what the allowlists
 * actually declare rather than against a second copy of it.
 */
const JOINED_SORTS_SEEN = new Set<string>();

function describeSortIndexes(
  label: string,
  table: string,
  tiebreak: string,
  expressions: Record<string, { sql: string; nullsLast?: boolean; on?: string; join?: string }>,
  allowlist: Record<string, unknown>,
) {
  describe(`${label} can be ordered from an index`, () => {
    it('covers every key in the allowlist, so this cannot pass vacuously', () => {
      expect(Object.keys(expressions).sort()).toEqual(Object.keys(allowlist).sort());
    });

    for (const [key, spec] of Object.entries(expressions)) {
      it(`sorts by ${key} from an index, with no Sort node`, async () => {
        /*
         * The joined client columns (`userEmail`, `userFirstName`) are indexed
         * on `users` by migrations 0010/0024, and the queue reaches them
         * through its INNER JOIN. Ordering by a joined column cannot avoid a
         * sort in a join plan the way a single-table order can, so for those
         * the assertion is that an index is USED — not that no sort exists.
         *
         * `join` names the ON clause when the joined table is not `users`. The
         * partner list gained one in 0102: it orders by the PROGRAMME a partner
         * is paid on, which lives in `ib_programs`, where the rung it replaced
         * was a plain integer on `ib_accounts`.
         */
        const joined = spec.on !== undefined;
        const on = spec.join ?? `users.id = ${table}.user_id`;
        const from = joined ? `${table} JOIN ${spec.on} ON ${on}` : table;
        const nulls = spec.nullsLast ? ' NULLS LAST' : '';
        const p = await plan(`
          SELECT 1 FROM ${from}
          ORDER BY ${spec.sql} DESC${nulls}, ${table}.${tiebreak} DESC
          LIMIT 26
        `);

        expect(p).toContain('Index');
        if (joined) {
          /*
           * The exemption is FROZEN, not a property of being joined.
           *
           * `if (!joined)` alone meant any sort key reaching through a join
           * skipped the "no Sort node" assertion automatically — so a new joined
           * key inherited the exemption by existing, and three of the lists it
           * covers page by KEYSET, where an unindexed ORDER BY is a full sort of
           * the filtered set on every page of every filter. That is the exact
           * cost `pagination.ts` chose keyset to avoid, reachable from a
           * query-string value.
           *
           * It cannot be closed by an index — a cross-table ordering has nowhere
           * to put one — so what is available is a BOUND: these are the ones
           * that were weighed, and a new one has to be weighed too.
           */
          JOINED_SORTS_SEEN.add(`${label}.${key}`);
          expect(
            JOINED_SORTS_EXEMPT.has(`${label}.${key}`),
            `${label}.${key} orders by a JOINED column, so it cannot avoid a sort node. ` +
              'That may be acceptable — it is for the ones listed — but it is a decision ' +
              'about a list that may page by keyset, not something to inherit. Add it to ' +
              'JOINED_SORTS_EXEMPT deliberately, or drop the key from the allowlist.',
          ).toBe(true);
        } else {
          expect(p, `ORDER BY ${spec.sql} fell back to a sort`).not.toContain('Sort');
        }
      });
    }
  });
}

// ── The withdrawal queue ─────────────────────────────────────────────────────
//
// `amount` is the one worth naming: NUMERIC(28,8), indexed as numeric, so the
// b-tree orders by true value. An index over a float cast would collapse values
// differing beyond 2^53 into one key — the money bug the column type prevents.
describeSortIndexes(
  'the withdrawal queue',
  'transactions',
  'id',
  {
    createdAt: { sql: 'transactions.created_at' },
    amount: { sql: 'transactions.amount' },
    state: { sql: 'transactions.state' },
    userEmail: { sql: 'users.email', on: 'users' },
    userFirstName: { sql: 'users.first_name', on: 'users' },
  },
  WITHDRAWAL_SORT_COLUMNS,
);

// ── The KYC review queue ─────────────────────────────────────────────────────
//
// "Submitted" sorts on coalesce(submitted_at, created_at) since 0214: never
// null, so a cursor can seek on it both ways, and indexed as that expression.
describeSortIndexes(
  'the KYC review queue',
  'kyc_submissions',
  'user_id',
  {
    submittedAt: {
      sql: 'coalesce(kyc_submissions.submitted_at, kyc_submissions.created_at)',
    },
    status: { sql: 'kyc_submissions.status' },
    createdAt: { sql: 'kyc_submissions.created_at' },
    userEmail: { sql: 'users.email', on: 'users' },
    userFirstName: { sql: 'users.first_name', on: 'users' },
  },
  KYC_SORT_COLUMNS,
);

// ── The audit trail ──────────────────────────────────────────────────────────
describeSortIndexes(
  'the audit trail',
  'audit_log',
  'id',
  {
    createdAt: { sql: 'audit_log.created_at' },
    action: { sql: 'audit_log.action' },
    actorEmail: { sql: 'audit_log.actor_email' },
  },
  AUDIT_SORT_COLUMNS,
);

// ── The partner application queue ────────────────────────────────────────────
describeSortIndexes(
  'the partner application queue',
  'ib_applications',
  'id',
  {
    submittedAt: { sql: 'ib_applications.submitted_at' },
    status: { sql: 'ib_applications.status' },
    userEmail: { sql: 'users.email', on: 'users' },
    userFirstName: { sql: 'users.first_name', on: 'users' },
  },
  IB_APPLICATION_SORT_COLUMNS,
);

// ── The partner list ─────────────────────────────────────────────────────────
describeSortIndexes(
  'the partner list',
  'ib_accounts',
  'user_id',
  {
    approvedAt: { sql: 'ib_accounts.approved_at' },
    /*
     * The RUNG (0112), ordered as the INTEGER it is. That is the whole reason
     * it is this column rather than the level's joined NAME: a rung's identity
     * is its number, and ordering by text puts "Level 10" before "Level 2".
     */
    level: { sql: 'ib_accounts.level' },
    referralCode: { sql: 'ib_accounts.referral_code' },
    userEmail: { sql: 'users.email', on: 'users' },
    userFirstName: { sql: 'users.first_name', on: 'users' },
  },
  IB_PARTNER_SORT_COLUMNS,
);

// ── The administrator directory ──────────────────────────────────────────────
describeSortIndexes(
  'the administrator directory',
  'admins',
  'id',
  {
    name: { sql: 'admins.name' },
    email: { sql: 'admins.email' },
    role: { sql: 'admins.role' },
    status: { sql: 'admins.status' },
    createdAt: { sql: 'admins.created_at' },
  },
  ADMIN_SORT_COLUMNS,
);

// ── The role list ────────────────────────────────────────────────────────────
describeSortIndexes(
  'the role list',
  'roles',
  'id',
  {
    name: { sql: 'roles.name' },
    createdAt: { sql: 'roles.created_at' },
  },
  ROLE_SORT_COLUMNS,
);

// ── The wallet list ──────────────────────────────────────────────────────────
//
// `balance` is the one worth naming, for the reason the withdrawal queue's
// `amount` is: NUMERIC(28,8), indexed as numeric, so the b-tree orders by true
// value. An index over a float cast would collapse values differing beyond 2^53
// into one key — and a wallet balance is the number that mistake is worst on.
describeSortIndexes(
  'the wallet list',
  'wallets',
  'id',
  {
    createdAt: { sql: 'wallets.created_at' },
    balance: { sql: 'wallets.balance' },
    currency: { sql: 'wallets.currency' },
    userEmail: { sql: 'users.email', on: 'users' },
    userFirstName: { sql: 'users.first_name', on: 'users' },
  },
  WALLET_SORT_COLUMNS,
);

// ── The trading-account list ─────────────────────────────────────────────────
//
// `login` is NULLABLE and the query pins NULLS LAST in both directions, so the
// index declares the same — otherwise the planner sorts instead of scanning.
describeSortIndexes(
  'the trading-account list',
  'trading_accounts',
  'id',
  {
    createdAt: { sql: 'trading_accounts.created_at' },
    balance: { sql: 'trading_accounts.balance' },
    login: { sql: 'trading_accounts.login', nullsLast: true },
    currency: { sql: 'trading_accounts.currency' },
    status: { sql: 'trading_accounts.status' },
    environment: { sql: 'trading_accounts.environment' },
    userEmail: { sql: 'users.email', on: 'users' },
    userFirstName: { sql: 'users.first_name', on: 'users' },
  },
  TRADING_ACCOUNT_SORT_COLUMNS,
);

// ── The financial union's other arms (migration 0094) ────────────────────────
//
// GET /admin/transactions orders a `transactions UNION ALL transfers UNION ALL
// ib_wallet_transfers`. Postgres can only merge-append an inlined union when
// EVERY branch is index-ordered; the `transactions` indexes above already
// exist, so what 0094 adds — and what these assert — is that each transfer
// arm can serve every one of the union's sorts alone. The allowlist is
// ADMIN_TRANSACTION_SORT_COLUMNS itself, so a key added to the union's sort
// surface arrives in this spec automatically.
//
// `state` joined them in 0165. The union's state used to be `t.state::text` in
// one arm and a CASE mapping to text in another — expressions no btree could
// order, so the index 0094 built for it (`transfers_state_id_idx`) was dead on
// arrival and 0102 dropped it, and every status sort read the whole money
// history. Since 0165 the union's state is a `transaction_state` on every arm:
// the transactions arm is the bare column (the withdrawal queue's index above),
// the transfer arm is the CASE below — mapped onto the ENUM, and indexed as that
// exact expression — and the commission arm is a constant, which orders nothing.
// The CASE here must match `movementsCte` and 0165 character for character: it
// is the expression the planner matches to the index.
const TRANSFER_MOVEMENT_STATE = `CASE transfers.state
  WHEN 'settled' THEN 'success'::transaction_state
  WHEN 'failed' THEN 'failure'::transaction_state
  ELSE 'pending'::transaction_state
END`;
describeSortIndexes(
  'the financial union: transfers arm',
  'transfers',
  'id',
  {
    createdAt: { sql: 'transfers.created_at' },
    amount: { sql: 'transfers.amount' },
    state: { sql: TRANSFER_MOVEMENT_STATE },
  },
  ADMIN_TRANSACTION_SORT_COLUMNS,
);

// `ib_wallet_transfers` has NO state column at all — the union states a
// constant ('success'), and ordering by a constant needs no index.
describeSortIndexes(
  'the financial union: commission-transfer arm',
  'ib_wallet_transfers',
  'id',
  {
    createdAt: { sql: 'ib_wallet_transfers.created_at' },
    amount: { sql: 'ib_wallet_transfers.amount' },
    state: { sql: `'success'::transaction_state` },
  },
  ADMIN_TRANSACTION_SORT_COLUMNS,
);

// ── The commission ledger ────────────────────────────────────────────────────
//
// ⚠️ THE MAP THIS SPEC HAD NEVER SEEN.
//
// `IB_ACCRUAL_SORT_COLUMNS` was the only `*_SORT_COLUMNS` object in the codebase
// absent from this file, and it offered four sort keys against a table carrying
// none of them as a leading column — `ib_accruals`' three indexes lead with
// `ib_user_id`, `(status, created_at)` and `batch_id`. So every ordering of the
// partner payout ledger was a full sort of the filtered set, on every page.
//
// The whole design of this file is that "each EXPRESSIONS map is checked against
// the real `*_SORT_COLUMNS` object, so a sort key added without an index arrives
// in this spec automatically". That works per list — and says nothing about a
// list nobody registered. Migration 0129 adds the four indexes; this is what
// stops the fifth key arriving without one.
describeSortIndexes(
  'the commission ledger',
  'ib_accruals',
  'id',
  {
    createdAt: { sql: 'ib_accruals.created_at' },
    amount: { sql: 'ib_accruals.amount' },
    status: { sql: 'ib_accruals.status' },
    depth: { sql: 'ib_accruals.depth' },
  },
  IB_ACCRUAL_SORT_COLUMNS,
);

/**
 * The index DIRECTIONS, asserted directly.
 *
 * A mismatch still works — Postgres can read an index backwards — but only when
 * EVERY column agrees, so `(col DESC, key DESC)` is the property that lets one
 * index serve both `ORDER BY col DESC, key DESC` and `ORDER BY col ASC, key
 * ASC`. `(col DESC, key ASC)` would serve neither of the orders we issue, and
 * the plans above would quietly gain a Sort node.
 */
describe('the composites are direction-pinned in the shape the queries order by', () => {
  const CASES: Array<[string, string, string]> = [
    ['transactions_amount_id_idx', 'amount DESC', 'id DESC'],
    ['audit_log_created_at_id_idx', 'created_at DESC', 'id DESC'],
    ['admins_name_id_idx', 'name DESC', 'id DESC'],
    ['roles_name_id_idx', 'name DESC', 'id DESC'],
    /* `ib_accounts_level_user_idx` went in 0104 with the column it ordered. The
       partner list sorts by the JOINED programme name now, which a composite on
       `ib_accounts` cannot serve. */
    // Migration 0094 — the financial union's transfer arms. (Their state sort is
    // 0165's expression index — asserted by plan in the union-arm block above.)
    ['transfers_created_at_id_idx', 'created_at DESC', 'id DESC'],
    ['transfers_amount_id_idx', 'amount DESC', 'id DESC'],
    ['ib_wallet_transfers_created_at_id_idx', 'created_at DESC', 'id DESC'],
    ['ib_wallet_transfers_amount_id_idx', 'amount DESC', 'id DESC'],
  ];

  for (const [index, first, second] of CASES) {
    it(`${index} is (${first}, ${second})`, async () => {
      const rows = await ctx.db.execute(
        sql`SELECT indexdef FROM pg_indexes WHERE indexname = ${index}`,
      );
      expect(rows.rows, `${index} does not exist — migration 0037 did not run`).toHaveLength(1);
      const def = (rows.rows[0] as { indexdef: string }).indexdef;
      expect(def).toContain(first);
      expect(def).toContain(second);
    });
  }

  it('pins NULLS LAST on the nullable KYC submitted_at index', async () => {
    // The query orders `submitted_at DESC NULLS LAST` so unsubmitted
    // applications never lead the queue. An index without the same null
    // placement cannot serve it, and the planner silently sorts instead.
    const rows = await ctx.db.execute(
      sql`SELECT indexdef FROM pg_indexes WHERE indexname = 'kyc_submissions_submitted_at_user_idx'`,
    );
    expect(rows.rows).toHaveLength(1);
    expect((rows.rows[0] as { indexdef: string }).indexdef).toContain('NULLS LAST');
  });
});

describe('the joined-sort exemption list stays honest', () => {
  it('names no pair that is no longer a sort key', () => {
    /*
     * Runs last, after every `describeSortIndexes` block has recorded the joined
     * pairs it actually saw. An exemption for a key that has since been dropped
     * from an allowlist is the decay the sibling censuses name: a line that
     * looks like diligence and protects nothing.
     */
    const stale = [...JOINED_SORTS_EXEMPT].filter((pair) => !JOINED_SORTS_SEEN.has(pair)).sort();

    expect(
      stale,
      `These are exempted but no longer appear in any allowlist. Delete them:\n${stale
        .map((p) => `  ${p}`)
        .join('\n')}`,
    ).toEqual([]);
  });
});
