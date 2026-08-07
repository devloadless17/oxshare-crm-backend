import { sql, type SQL } from 'drizzle-orm';
import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE_DB } from '../database/database.module';
import type { Db } from '../database/db';
import {
  ibApplications,
  ibAccounts,
  kycSubmissions,
  transactions,
  users,
} from '../database/schema';
import { clientScopePredicate, type ClientScope } from '../common/security/client-scope';

/**
 * The dashboard aggregates — ONE query per section, and every one of them
 * scoped.
 *
 * ## Why these live in a store rather than in the service
 *
 * Because the scope predicate does. `common/security/client-scope.ts` states the
 * one rule this whole feature rests on: the predicate goes in the WHERE clause,
 * never after the fetch. An aggregate computed in JavaScript over rows a store
 * handed back is the fetch-then-filter shape that rule forbids, and it fails in
 * the worst available way — a scoped administrator is shown a headline number
 * that counts clients they are specifically denied, with nothing anywhere to
 * say so. A COUNT is not less sensitive than a list; "you have 4 clients" and
 * "the platform has 219,000" are different disclosures, and the second one is
 * the leak.
 *
 * So every method here takes a `ClientScope` and threads it through
 * `clientScopePredicate` on the column holding the CLIENT's id — `users.id`,
 * `kyc_submissions.user_id`, `transactions.user_id`, `ib_applications.user_id`,
 * `ib_accounts.user_id`. The helper returns `undefined` for an unrestricted
 * actor and Drizzle's `and()` drops it, so there is no branch at any call site
 * to get backwards.
 *
 * ## Why the scope is a REQUIRED parameter here
 *
 * `UsersStore.findPage` defaults `scope` to UNRESTRICTED so that a
 * non-administrative caller keeps working. Nothing non-administrative calls
 * this file — a dashboard is an admin screen by construction — so the default
 * would only ever serve a call site that forgot, which is the exact failure the
 * default exists to be permissive about elsewhere. Required, it is a compile
 * error instead.
 *
 * ## Money
 *
 * `transactions.amount` is `NUMERIC(28,8)`. Every SUM below is cast back to
 * `text` in SQL and crosses this boundary as a **string** (ARCHITECTURE §6.1).
 * `node-postgres` already returns NUMERIC as a string for exactly this reason,
 * and `::text` on the aggregate makes that a property of the query rather than
 * of a driver setting somebody may change. `coalesce(..., 0)` before the cast,
 * so an empty set is `'0'` rather than `null` — a dashboard tile showing "—"
 * for a state with no withdrawals is worse than one showing zero.
 */

/** A bucket count keyed by the enum value it counts. */
export type CountsByKey = Record<string, number>;

export interface WithdrawalStateTotal {
  state: string;
  count: number;
  /** NUMERIC(28,8) as a string, never a number (§6.1). */
  totalAmount: string;
}

export interface RegistrationPoint {
  /** `YYYY-MM-DD`, in UTC. */
  date: string;
  count: number;
}

export interface KycTrendPoint {
  date: string;
  submitted: number;
  approved: number;
}

export interface WithdrawalVolumePoint {
  date: string;
  count: number;
  /** NUMERIC(28,8) as a string, never a number (§6.1). */
  totalAmount: string;
}

/**
 * A `generate_series` of the last `days` UTC dates, inclusive of today.
 *
 * ## Zero-filling belongs HERE, not in JavaScript
 *
 * A day with no registrations must come back as `0`, not be absent. Absent is
 * not merely untidy: a line chart fed rows it was handed draws the gap CLOSED,
 * so a week nobody signed up compresses into a straight line between the days
 * either side and the screen shows steady growth through an outage. The
 * operator has no way to see that the data is missing rather than flat.
 *
 * Doing it in SQL, as a LEFT JOIN from the series onto the grouped counts, means
 * the shape is right at the source and every consumer — this API, a CSV export,
 * a future report — gets it without re-deriving the calendar. A JavaScript
 * fill-in would have to reconstruct which days should exist, in the same
 * timezone the GROUP BY used, and any drift between the two silently
 * misattributes a day's numbers.
 *
 * ## UTC, stated
 *
 * `date_trunc('day', col AT TIME ZONE 'UTC')` and a series built the same way,
 * so the bucket boundaries and the calendar agree by construction. Bucketing in
 * the server's local zone and filling from a UTC calendar is how a chart ends up
 * with an extra empty day at one end and a doubled one at the other.
 */
function dateSeries(days: number): SQL {
  return sql`
    SELECT generate_series(
      (now() AT TIME ZONE 'UTC')::date - make_interval(days => ${days - 1}),
      (now() AT TIME ZONE 'UTC')::date,
      interval '1 day'
    )::date AS day
  `;
}

/** The inclusive lower bound of the window, as a timestamptz. */
function windowStart(days: number): SQL {
  return sql`((now() AT TIME ZONE 'UTC')::date - make_interval(days => ${days - 1}))::timestamptz`;
}

@Injectable()
export class StatsStore {
  constructor(@Inject(DRIZZLE_DB) private readonly db: Db) {}

  /**
   * Client headline counters, in ONE query.
   *
   * Every counter is a `count(*) FILTER (WHERE …)` over the same scan rather
   * than its own round trip. Nine separate `SELECT count(*)` statements would
   * read the same 219,000-row table nine times and, worse, read it nine times
   * at nine slightly different instants — so "total" and the sum of the status
   * buckets could disagree on a busy platform and a reviewer would have no way
   * to tell an accounting bug from ordinary concurrency.
   *
   * `registeredToday` is `>= today` rather than `= today`: a row written a
   * microsecond into tomorrow while this runs belongs to tomorrow, and
   * date-truncation comparison expresses that without a second bound.
   */
  async clientCounters(scope: ClientScope) {
    const visible = clientScopePredicate(scope, users.id);
    const where = visible ? sql`WHERE ${visible}` : sql``;

    const result = await this.db.execute<{
      total: number;
      today: number;
      this_week: number;
      this_month: number;
      active: number;
      pending: number;
      suspended: number;
      verified: number;
      not_verified: number;
    }>(sql`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (
          WHERE ${users.createdAt} >= (now() AT TIME ZONE 'UTC')::date
        )::int AS today,
        count(*) FILTER (
          WHERE ${users.createdAt} >= date_trunc('week', now() AT TIME ZONE 'UTC')
        )::int AS this_week,
        count(*) FILTER (
          WHERE ${users.createdAt} >= date_trunc('month', now() AT TIME ZONE 'UTC')
        )::int AS this_month,
        count(*) FILTER (WHERE ${users.status} = 'active')::int AS active,
        count(*) FILTER (WHERE ${users.status} = 'pending')::int AS pending,
        count(*) FILTER (WHERE ${users.status} = 'suspended')::int AS suspended,
        count(*) FILTER (WHERE ${users.verificationLevel} >= 1)::int AS verified,
        count(*) FILTER (WHERE ${users.verificationLevel} < 1)::int AS not_verified
      FROM ${users}
      ${where}
    `);

    const row = result.rows[0];
    return {
      total: row.total,
      registeredToday: row.today,
      registeredThisWeek: row.this_week,
      registeredThisMonth: row.this_month,
      byStatus: {
        active: row.active,
        pending: row.pending,
        suspended: row.suspended,
      },
      byVerification: {
        verified: row.verified,
        notVerified: row.not_verified,
      },
    };
  }

  /**
   * KYC submissions per status — all six `kyc_status` values, always present.
   *
   * Seeded from the enum rather than from the rows, so a status with no
   * submissions reads `0` instead of vanishing. Same reasoning as the
   * zero-filled series: a missing key and a zero look identical to a chart and
   * mean opposite things to a compliance reviewer.
   */
  async kycCounts(scope: ClientScope): Promise<CountsByKey> {
    const visible = clientScopePredicate(scope, kycSubmissions.userId);
    const where = visible ? sql`WHERE ${visible}` : sql``;

    const result = await this.db.execute<{ status: string; value: number }>(sql`
      SELECT ${kycSubmissions.status}::text AS status, count(*)::int AS value
      FROM ${kycSubmissions}
      ${where}
      GROUP BY ${kycSubmissions.status}
    `);

    const counts: CountsByKey = {};
    for (const status of kycSubmissions.status.enumValues) counts[status] = 0;
    for (const row of result.rows) counts[row.status] = row.value;
    return counts;
  }

  /**
   * Withdrawal count and total amount per state.
   *
   * `direction = 'withdrawal'` in the predicate: `transactions` holds deposits
   * too, and a "withdrawals pending" tile that silently included deposits would
   * be wrong in the direction that matters — it would overstate money on its way
   * out of the platform.
   *
   * Every state is seeded to `{count: 0, totalAmount: '0'}` for the same reason
   * the KYC statuses are.
   */
  async withdrawalTotals(scope: ClientScope): Promise<WithdrawalStateTotal[]> {
    const visible = clientScopePredicate(scope, transactions.userId);
    const scoped = visible ? sql` AND ${visible}` : sql``;

    const result = await this.db.execute<{ state: string; value: number; total: string }>(sql`
      SELECT
        ${transactions.state}::text AS state,
        count(*)::int AS value,
        -- ::text, so the NUMERIC(28,8) crosses this boundary as a string
        -- whatever the driver is configured to do (§6.1). coalesce first, so an
        -- empty state is '0' rather than null.
        coalesce(sum(${transactions.amount}), 0)::text AS total
      FROM ${transactions}
      WHERE ${transactions.direction} = 'withdrawal'${scoped}
      GROUP BY ${transactions.state}
    `);

    const byState = new Map(result.rows.map((r) => [r.state, r]));
    return transactions.state.enumValues.map((state) => {
      const row = byState.get(state);
      return {
        state,
        count: row?.value ?? 0,
        // Never Number(row.total) — the string IS the value (§6.1).
        totalAmount: row?.total ?? '0',
      };
    });
  }

  /**
   * IB applications per status, plus the number of partners on the books.
   *
   * The application counts join `users` because the scope is a statement about
   * CLIENTS and `ib_applications` only carries a `user_id`; `clientScopePredicate`
   * takes that column directly, so no join is needed — the predicate is an
   * EXISTS over `client_tag_assignments` keyed on the id it is handed.
   */
  async ibCounts(scope: ClientScope): Promise<{ applications: CountsByKey; partners: number }> {
    const applicationScope = clientScopePredicate(scope, ibApplications.userId);
    const partnerScope = clientScopePredicate(scope, ibAccounts.userId);

    const [applicationRows, partnerRows] = await Promise.all([
      this.db.execute<{ status: string; value: number }>(sql`
        SELECT ${ibApplications.status}::text AS status, count(*)::int AS value
        FROM ${ibApplications}
        ${applicationScope ? sql`WHERE ${applicationScope}` : sql``}
        GROUP BY ${ibApplications.status}
      `),
      this.db.execute<{ value: number }>(sql`
        SELECT count(*)::int AS value
        FROM ${ibAccounts}
        ${partnerScope ? sql`WHERE ${partnerScope}` : sql``}
      `),
    ]);

    const applications: CountsByKey = {};
    for (const status of ibApplications.status.enumValues) applications[status] = 0;
    for (const row of applicationRows.rows) applications[row.status] = row.value;

    return { applications, partners: partnerRows.rows[0].value };
  }

  /**
   * Registrations per day for the last `days` days, gaps filled with 0.
   *
   * A LEFT JOIN from the generated calendar onto the grouped counts, so the
   * series is complete by construction — see `dateSeries` for why that is not a
   * cosmetic choice.
   *
   * `days` reaches `make_interval` as a bound PARAMETER, not as interpolated
   * text. It is validated upstream, but a query that would be injectable if its
   * input ever changed source is a trap left for someone else
   * (`client-scope.ts` makes the same argument about tag ids).
   */
  async registrationsByDay(scope: ClientScope, days: number): Promise<RegistrationPoint[]> {
    const visible = clientScopePredicate(scope, users.id);
    const scoped = visible ? sql` AND ${visible}` : sql``;

    /*
     * The joined table is NOT ALIASED, and that is load-bearing.
     *
     * `clientScopePredicate` builds its EXISTS against the column object it is
     * handed, which Drizzle renders fully qualified as `"users"."id"`. Aliasing
     * the join (`LEFT JOIN users u`) puts that name out of scope for the rest of
     * the query, and Postgres answers `missing FROM-clause entry for table
     * "users"` — a 500 from a screen, on the one code path where the predicate
     * is present, which is to say only ever for a SCOPED admin. An unrestricted
     * admin would see a working dashboard throughout.
     *
     * So every query in this file that carries the predicate refers to the base
     * table by its real name. `${users}` renders as `"users"`, and the LEFT JOIN
     * condition then reads the same identifier the predicate does.
     */
    const result = await this.db.execute<{ day: string; value: number }>(sql`
      WITH days AS (${dateSeries(days)})
      SELECT
        to_char(days.day, 'YYYY-MM-DD') AS day,
        count(${users.id})::int AS value
      FROM days
      LEFT JOIN ${users}
        ON date_trunc('day', ${users.createdAt} AT TIME ZONE 'UTC')::date = days.day
       AND ${users.createdAt} >= ${windowStart(days)}${scoped}
      GROUP BY days.day
      ORDER BY days.day
    `);

    return result.rows.map((row) => ({ date: row.day, count: row.value }));
  }

  /**
   * KYC submissions and approvals per day, same zero-filling.
   *
   * TWO date columns over one table, so this cannot be a single LEFT JOIN on a
   * shared key: a submission made on Monday and approved on Thursday belongs to
   * Monday's submitted count and Thursday's approved count. Two correlated
   * aggregates against the calendar keep each on its own date rather than
   * forcing one of the two to be wrong.
   *
   * `approved` counts by `reviewed_at` AND `status = 'approved'` — a row
   * reviewed and REJECTED on a day is not an approval that day, and counting
   * every review as an approval is the kind of number that reads plausibly on a
   * dashboard for months.
   */
  async kycTrendByDay(scope: ClientScope, days: number): Promise<KycTrendPoint[]> {
    const visible = clientScopePredicate(scope, kycSubmissions.userId);
    const scoped = visible ? sql` AND ${visible}` : sql``;

    /*
     * Unaliased for the reason `registrationsByDay` records: the scope predicate
     * renders `"kyc_submissions"."user_id"`, and an alias would put that name out
     * of the subquery's scope — a 500 that only a SCOPED admin ever sees.
     *
     * The two subqueries are independent scans of the same table rather than one
     * grouped pass, which is deliberate rather than lazy: a submission made
     * Monday and approved Thursday belongs to Monday's `submitted` and
     * Thursday's `approved`, so there is no single GROUP BY key that puts both
     * on the right day. `kyc_submissions_submitted_at_idx` serves the first and
     * the table is one row per client, so this is small either way.
     */
    const result = await this.db.execute<{ day: string; submitted: number; approved: number }>(sql`
      WITH days AS (${dateSeries(days)})
      SELECT
        to_char(days.day, 'YYYY-MM-DD') AS day,
        (
          SELECT count(*)::int FROM ${kycSubmissions}
          WHERE date_trunc('day', ${kycSubmissions.submittedAt} AT TIME ZONE 'UTC')::date = days.day
            AND ${kycSubmissions.submittedAt} >= ${windowStart(days)}${scoped}
        ) AS submitted,
        (
          SELECT count(*)::int FROM ${kycSubmissions}
          WHERE date_trunc('day', ${kycSubmissions.reviewedAt} AT TIME ZONE 'UTC')::date = days.day
            AND ${kycSubmissions.reviewedAt} >= ${windowStart(days)}
            AND ${kycSubmissions.status} = 'approved'${scoped}
        ) AS approved
      FROM days
      ORDER BY days.day
    `);

    return result.rows.map((row) => ({
      date: row.day,
      submitted: row.submitted,
      approved: row.approved,
    }));
  }

  /**
   * Withdrawal amount and count per day, amounts as strings.
   *
   * Bucketed on `created_at` — when the client ASKED — rather than `settled_at`.
   * Both are defensible and they answer different questions; requested volume is
   * the one a dashboard's "withdrawal volume" line is read as, and it is also the
   * only one defined for a pending or rejected request. The choice is stated here
   * so the next person reads a decision rather than an accident.
   */
  async withdrawalVolumeByDay(scope: ClientScope, days: number): Promise<WithdrawalVolumePoint[]> {
    const visible = clientScopePredicate(scope, transactions.userId);
    const scoped = visible ? sql` AND ${visible}` : sql``;

    // Unaliased, for the reason `registrationsByDay` records — the scope
    // predicate renders `"transactions"."user_id"` and an alias hides it.
    const result = await this.db.execute<{ day: string; value: number; total: string }>(sql`
      WITH days AS (${dateSeries(days)})
      SELECT
        to_char(days.day, 'YYYY-MM-DD') AS day,
        count(${transactions.id})::int AS value,
        -- ::text so the NUMERIC(28,8) sum crosses this boundary as a string
        -- whatever the driver does with numerics (§6.1), and coalesce first so
        -- a quiet day is '0' rather than null.
        coalesce(sum(${transactions.amount}), 0)::text AS total
      FROM days
      LEFT JOIN ${transactions}
        ON date_trunc('day', ${transactions.createdAt} AT TIME ZONE 'UTC')::date = days.day
       AND ${transactions.createdAt} >= ${windowStart(days)}
       AND ${transactions.direction} = 'withdrawal'${scoped}
      GROUP BY days.day
      ORDER BY days.day
    `);

    return result.rows.map((row) => ({
      date: row.day,
      count: row.value,
      // The string is the value. Never Number()/parseFloat here (§6.1).
      totalAmount: row.total,
    }));
  }
}
