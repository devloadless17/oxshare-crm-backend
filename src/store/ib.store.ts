import { and, count, desc, eq, inArray, sql, type SQLWrapper } from 'drizzle-orm';
import { Inject, Injectable } from '@nestjs/common';
import { orderTerms, type SortOrder } from '../common/sorting';
import { DRIZZLE_DB } from '../database/database.module';
import type { Db, Executor } from '../database/db';
import { ibAccounts, ibApplications, ibLevels, users } from '../database/schema';
import {
  clientScopePredicate,
  UNRESTRICTED,
  type ClientScope,
} from '../common/security/client-scope';

export type IbApplicationStatus = (typeof ibApplications.status.enumValues)[number];

export type IbApplicationRow = typeof ibApplications.$inferSelect;
export type IbAccountRow = typeof ibAccounts.$inferSelect;

/**
 * The columns the partner APPLICATION queue may be ordered by — R-2.5.
 *
 * `submittedAt` is `NOT NULL DEFAULT now()`, so unlike the KYC queue's it needs
 * no null handling: an application exists only once it has been submitted.
 *
 * The applicant columns come from the `users` INNER JOIN the queue already does
 * for its name and email display, so sorting by them costs no extra join.
 */
export const IB_APPLICATION_SORT_COLUMNS = {
  submittedAt: ibApplications.submittedAt,
  status: ibApplications.status,
  userEmail: users.email,
  userFirstName: users.firstName,
} as const;

export type IbApplicationSortKey = keyof typeof IB_APPLICATION_SORT_COLUMNS;

/** Newest first — what the queue showed before it was sortable. */
export const DEFAULT_IB_APPLICATION_SORT: IbApplicationSortKey = 'submittedAt';

/**
 * The columns the PARTNER list may be ordered by — R-2.5.
 *
 * `level` is the ladder rung, and it sorts as the INTEGER it is. That is worth
 * stating because the obvious alternative — ordering by the joined
 * `ib_levels.name` — would sort "Level 10" before "Level 2" as text, which is
 * exactly the kind of ordering that looks plausible enough to ship.
 */
export const IB_PARTNER_SORT_COLUMNS = {
  approvedAt: ibAccounts.approvedAt,
  level: ibAccounts.level,
  referralCode: ibAccounts.referralCode,
  userEmail: users.email,
  userFirstName: users.firstName,
} as const;

export type IbPartnerSortKey = keyof typeof IB_PARTNER_SORT_COLUMNS;

/** Newest approval first — what the list showed before it was sortable. */
export const DEFAULT_IB_PARTNER_SORT: IbPartnerSortKey = 'approvedAt';

/**
 * Reads and writes for the partner programme.
 *
 * The one method worth reading before the others is `transition`. Everything
 * else here is ordinary.
 */
@Injectable()
export class IbStore {
  constructor(@Inject(DRIZZLE_DB) private readonly db: Db) {}

  // ── applications ───────────────────────────────────────────────────────────

  /** The application a client currently has open, if any. */
  async findPendingByUser(userId: string): Promise<IbApplicationRow | undefined> {
    const [row] = await this.db
      .select()
      .from(ibApplications)
      .where(and(eq(ibApplications.userId, userId), eq(ibApplications.status, 'pending')))
      .limit(1);
    return row;
  }

  /**
   * The client's most recent application, whatever became of it.
   *
   * The portal needs this, not just the pending one: a rejected applicant must
   * be shown the reason they were given, and "no pending application" alone
   * cannot tell the difference between never having applied and having been
   * turned down.
   */
  async findLatestByUser(userId: string): Promise<IbApplicationRow | undefined> {
    const [row] = await this.db
      .select()
      .from(ibApplications)
      .where(eq(ibApplications.userId, userId))
      .orderBy(desc(ibApplications.submittedAt))
      .limit(1);
    return row;
  }

  async findById(id: string): Promise<IbApplicationRow | undefined> {
    const [row] = await this.db
      .select()
      .from(ibApplications)
      .where(eq(ibApplications.id, id))
      .limit(1);
    return row;
  }

  async createApplication(
    values: Pick<IbApplicationRow, 'userId'> &
      Partial<Pick<IbApplicationRow, 'motivation' | 'expectedVolume' | 'website'>>,
  ): Promise<IbApplicationRow> {
    const [row] = await this.db.insert(ibApplications).values(values).returning();
    return row;
  }

  /**
   * Move an application out of `pending`, but ONLY if it is still there.
   *
   * The expected status goes in the WHERE clause, so the check and the write
   * are one statement. This is the same shape `KycStore.transition` uses and it
   * exists for the same reason: two admins racing approve against reject would
   * otherwise both read `pending`, both pass their own check, and both write —
   * and the second decision silently overwrites the first, after the first has
   * already sent the client an email saying the opposite.
   *
   * Returns `undefined` when nothing matched. The caller is expected to treat
   * that as a conflict rather than as a missing row; a pre-read can say which
   * it was, but only advisorily. If the two disagree, the database wins.
   */
  async transition(
    id: string,
    from: readonly IbApplicationStatus[],
    patch: Partial<
      Pick<IbApplicationRow, 'status' | 'rejectionReason' | 'reviewedBy' | 'reviewedAt'>
    >,
    executor?: Executor,
  ): Promise<IbApplicationRow | undefined> {
    const [row] = await (executor ?? this.db)
      .update(ibApplications)
      .set(patch)
      .where(and(eq(ibApplications.id, id), inArray(ibApplications.status, [...from])))
      .returning();
    return row;
  }

  /**
   * The review queue, joined to the applicant and paginated in SQL.
   *
   * `scope` is row-level visibility, defaulting to unrestricted. An admin
   * limited to a subset of clients must not see a partner application from
   * outside it — the same rule the KYC queue follows, and the reason the
   * predicate is applied here rather than filtered in the controller.
   */
  async findPageWithUsers(filter: {
    status?: IbApplicationStatus;
    page: number;
    limit: number;
    scope?: ClientScope;
    /** R-2.5 server-side sort. Validated by `sortKey` before it gets here. */
    sort?: IbApplicationSortKey;
    order?: SortOrder;
  }) {
    const scope = filter.scope ?? UNRESTRICTED;
    const visible = clientScopePredicate(scope, users.id);

    const sortKey: IbApplicationSortKey = filter.sort ?? DEFAULT_IB_APPLICATION_SORT;
    const direction = filter.order ?? 'desc';
    const sortColumn: SQLWrapper = IB_APPLICATION_SORT_COLUMNS[sortKey];

    const where = and(
      filter.status ? eq(ibApplications.status, filter.status) : undefined,
      visible,
    );

    const rows = await this.db
      .select({
        application: ibApplications,
        user: {
          id: users.id,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
          verificationLevel: users.verificationLevel,
        },
      })
      .from(ibApplications)
      .innerJoin(users, eq(users.id, ibApplications.userId))
      .where(where)
      // `id` is the total-order tiebreak. Without it, two applications sharing a
      // status — which is most of the queue — sit either side of an OFFSET
      // boundary in an order Postgres may change between queries, so paging can
      // show one twice and another never. See `orderTerms`.
      .orderBy(...orderTerms(sortColumn, ibApplications.id, direction))
      .limit(filter.limit)
      .offset((filter.page - 1) * filter.limit);

    const [{ value: total }] = await this.db
      .select({ value: count() })
      .from(ibApplications)
      .innerJoin(users, eq(users.id, ibApplications.userId))
      .where(where);

    /*
     * Per-status counts for the tab labels, computed by the database in ONE
     * grouped query rather than three round trips. Scoped identically — a count
     * that ignored visibility would tell a limited admin there are twelve
     * pending applications and then show them four.
     */
    const grouped = await this.db
      .select({ status: ibApplications.status, value: count() })
      .from(ibApplications)
      .innerJoin(users, eq(users.id, ibApplications.userId))
      .where(visible)
      .groupBy(ibApplications.status);

    const counts: Record<IbApplicationStatus, number> = {
      pending: 0,
      approved: 0,
      rejected: 0,
    };
    for (const row of grouped) counts[row.status] = row.value;

    return { rows, total, counts };
  }

  // ── accounts ───────────────────────────────────────────────────────────────

  async findAccount(userId: string): Promise<IbAccountRow | undefined> {
    const [row] = await this.db
      .select()
      .from(ibAccounts)
      .where(eq(ibAccounts.userId, userId))
      .limit(1);
    return row;
  }

  async findAccountByReferralCode(code: string): Promise<IbAccountRow | undefined> {
    const [row] = await this.db
      .select()
      .from(ibAccounts)
      .where(eq(ibAccounts.referralCode, code))
      .limit(1);
    return row;
  }

  async createAccount(
    values: Pick<IbAccountRow, 'userId' | 'level' | 'referralCode'> &
      Partial<Pick<IbAccountRow, 'parentIbUserId' | 'applicationId'>>,
    executor?: Executor,
  ): Promise<IbAccountRow> {
    const [row] = await (executor ?? this.db).insert(ibAccounts).values(values).returning();
    return row;
  }

  /** How many partners sit directly beneath this one — the `maxDirectPartners` check. */
  async countDirectPartners(parentUserId: string): Promise<number> {
    const [{ value }] = await this.db
      .select({ value: count() })
      .from(ibAccounts)
      .where(eq(ibAccounts.parentIbUserId, parentUserId));
    return value;
  }

  /**
   * Every partner between this one and the top of their chain.
   *
   * A recursive CTE rather than a loop of round trips, because the cycle guard
   * calls it on every reassignment and a chain walked one query per level is a
   * request whose cost depends on how deep the tree happens to be.
   *
   * `UNION` — not `UNION ALL` — is doing real work: it deduplicates, so a chain
   * that is ALREADY cyclic terminates here instead of spinning forever. The
   * table can hold a cycle (a self-FK only checks the target exists), so this
   * query must survive one rather than assume it cannot happen.
   */
  async ancestorsOf(userId: string): Promise<string[]> {
    const result = await this.db.execute<{ user_id: string }>(sql`
      WITH RECURSIVE chain AS (
        SELECT user_id, parent_ib_user_id
          FROM ib_accounts
         WHERE user_id = ${userId}
        UNION
        SELECT a.user_id, a.parent_ib_user_id
          FROM ib_accounts a
          JOIN chain c ON a.user_id = c.parent_ib_user_id
      )
      SELECT user_id FROM chain WHERE user_id <> ${userId}
    `);
    return result.rows.map((r) => r.user_id);
  }

  /** The partner list. Joined to the person, because a uuid is not a partner. */
  async findPartnersPage(filter: {
    page: number;
    limit: number;
    scope?: ClientScope;
    /** R-2.5 server-side sort. Validated by `sortKey` before it gets here. */
    sort?: IbPartnerSortKey;
    order?: SortOrder;
  }) {
    const visible = clientScopePredicate(filter.scope ?? UNRESTRICTED, users.id);

    const sortKey: IbPartnerSortKey = filter.sort ?? DEFAULT_IB_PARTNER_SORT;
    const direction = filter.order ?? 'desc';
    const sortColumn: SQLWrapper = IB_PARTNER_SORT_COLUMNS[sortKey];

    const rows = await this.db
      .select({
        account: ibAccounts,
        user: {
          id: users.id,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
        },
        levelName: ibLevels.name,
      })
      .from(ibAccounts)
      .innerJoin(users, eq(users.id, ibAccounts.userId))
      .innerJoin(ibLevels, eq(ibLevels.level, ibAccounts.level))
      .where(visible)
      // `user_id` is this table's PRIMARY KEY — one partner account per client —
      // so it is the unique tiebreak here, where the applications queue uses
      // `id`. Load-bearing for the same reason: `level` has a handful of values
      // and ties across a page boundary are the norm rather than the exception.
      .orderBy(...orderTerms(sortColumn, ibAccounts.userId, direction))
      .limit(filter.limit)
      .offset((filter.page - 1) * filter.limit);

    const [{ value: total }] = await this.db
      .select({ value: count() })
      .from(ibAccounts)
      .innerJoin(users, eq(users.id, ibAccounts.userId))
      .where(visible);

    return { rows, total };
  }

  async updateAccount(
    userId: string,
    patch: Partial<Pick<IbAccountRow, 'level' | 'parentIbUserId' | 'active'>>,
  ): Promise<IbAccountRow | undefined> {
    const [row] = await this.db
      .update(ibAccounts)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(ibAccounts.userId, userId))
      .returning();
    return row;
  }
}
