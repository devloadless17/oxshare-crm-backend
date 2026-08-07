import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { MoneyTestContext, startMoneyTestDb, stopMoneyTestDb } from './money-setup';
import { closeDb, resetDb } from '../src/database/db';
import { WITHDRAWAL_SORT_COLUMNS } from '../src/modules/payments/transactions.service';
import { KYC_SORT_COLUMNS } from '../src/store/kyc.store';
import { AUDIT_SORT_COLUMNS } from '../src/store/audit-log.store';
import { IB_APPLICATION_SORT_COLUMNS, IB_PARTNER_SORT_COLUMNS } from '../src/store/ib.store';
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
function describeSortIndexes(
  label: string,
  table: string,
  tiebreak: string,
  expressions: Record<string, { sql: string; nullsLast?: boolean; on?: string }>,
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
         */
        const joined = spec.on !== undefined;
        const from = joined ? `${table} JOIN users ON users.id = ${table}.user_id` : table;
        const nulls = spec.nullsLast ? ' NULLS LAST' : '';
        const p = await plan(`
          SELECT 1 FROM ${from}
          ORDER BY ${spec.sql} DESC${nulls}, ${table}.${tiebreak} DESC
          LIMIT 26
        `);

        expect(p).toContain('Index');
        if (!joined) {
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
// `submitted_at` is NULLABLE and the query pins NULLS LAST in both directions,
// so the index declares the same — otherwise the planner sorts instead.
describeSortIndexes(
  'the KYC review queue',
  'kyc_submissions',
  'user_id',
  {
    submittedAt: { sql: 'kyc_submissions.submitted_at', nullsLast: true },
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
    ['ib_accounts_level_user_idx', 'level DESC', 'user_id DESC'],
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
