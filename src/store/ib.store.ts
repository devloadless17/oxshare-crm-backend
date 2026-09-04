import {
  aliasedTable,
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  or,
  sql,
  type SQLWrapper,
} from 'drizzle-orm';
import { Inject, Injectable } from '@nestjs/common';
import { orderTerms, type SortOrder } from '../common/sorting';
import { DRIZZLE_DB } from '../database/database.module';
import type { Db, Executor } from '../database/db';
import {
  agencies,
  ibAccounts,
  ibAccruals,
  ibApplications,
  ibLevels,
  ibPrograms,
  users,
} from '../database/schema';
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
 * `level` is back (0112) and sorts on the INTEGER, which is the whole reason it
 * is the column rather than the joined name: a rung's identity is its number,
 * and ordering by text puts "Level 10" before "Level 2".
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
 * The columns the commission ledger may be ordered by — R-2.5, an allow-list.
 *
 * `amount` orders on the NUMERIC column in SQL, for the reason the withdrawal
 * queue records: a float cast loses precision above 2^53, and sorting the
 * fetched page in JavaScript orders 25 rows while presenting the answer as an
 * ordering of the whole ledger.
 */
export const IB_ACCRUAL_SORT_COLUMNS = {
  createdAt: ibAccruals.createdAt,
  amount: ibAccruals.amount,
  status: ibAccruals.status,
  /*
   * `depth` replaces `level` (0102). It sorts as the INTEGER it is, and it is
   * the more useful ordering anyway: grouping a ledger by "own clients" versus
   * "sub-partners' clients" is a question about the trade, which is what depth
   * records, where the rung recorded a placement that decided nothing.
   */
  depth: ibAccruals.depth,
} as const;

export type IbAccrualSortKey = keyof typeof IB_ACCRUAL_SORT_COLUMNS;

/** Newest first — a commission ledger is read from the top. */
export const DEFAULT_IB_ACCRUAL_SORT: IbAccrualSortKey = 'createdAt';

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
      Partial<Pick<IbApplicationRow, 'motivation' | 'website' | 'agencyId'>>,
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
    /**
     * Free-text search over the APPLICANT — email, first name, last name.
     *
     * The same three columns the KYC queue searches, deliberately: both are
     * review queues of people, an operator moves between them, and a search box
     * that matched different fields on each would be a trap rather than a
     * feature. It does NOT search `motivation` — matching free text the
     * applicant wrote would surface rows for words they used in passing.
     */
    q?: string;
    /** R-2.5 server-side sort. Validated by `sortKey` before it gets here. */
    sort?: IbApplicationSortKey;
    order?: SortOrder;
  }) {
    const scope = filter.scope ?? UNRESTRICTED;
    const visible = clientScopePredicate(scope, users.id);

    /*
     * In the WHERE clause, so it narrows the RESULT SET rather than the page.
     * Filtering fetched rows would leave the total counting everything and the
     * pager offering pages that render empty — see the note on `scoped`.
     */
    const term = filter.q?.trim() ? `%${filter.q.trim()}%` : undefined;
    const matches = term
      ? or(ilike(users.email, term), ilike(users.firstName, term), ilike(users.lastName, term))
      : undefined;

    const sortKey: IbApplicationSortKey = filter.sort ?? DEFAULT_IB_APPLICATION_SORT;
    const direction = filter.order ?? 'desc';
    const sortColumn: SQLWrapper = IB_APPLICATION_SORT_COLUMNS[sortKey];

    const where = and(
      filter.status ? eq(ibApplications.status, filter.status) : undefined,
      visible,
      matches,
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
        /*
         * The agency's NAME, not just the id on the application row.
         *
         * This is the one thing an applicant actually chooses — it decides
         * what the partner may sell, which is why the apply screen asks for it
         * and made it required. The row carried `agencyId` and nothing
         * resolved it, so the export shipped columns for two questions the
         * form stopped asking (website, motivation — always null) and no
         * column for the answer it does collect.
         *
         * LEFT join: an application predating the agency requirement has none,
         * and that is a real state rather than a reason to drop the row.
         */
        agencyName: agencies.name,
      })
      .from(ibApplications)
      .innerJoin(users, eq(users.id, ibApplications.userId))
      .leftJoin(agencies, eq(agencies.id, ibApplications.agencyId))
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
    /*
     * `level` replaced `programId` as the required term — 0112. A partner must
     * be created ON a rung, because that is what decides their pay; the
     * programme is historical and nothing writes it any more.
     */
    values: Pick<IbAccountRow, 'userId' | 'referralCode' | 'level'> &
      Partial<Pick<IbAccountRow, 'parentIbUserId' | 'applicationId' | 'agencyId'>>,
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
   * The partners placed DIRECTLY under this one, with the person and the rung.
   *
   * `countDirectPartners` above answers "how many" for the placement rule; this
   * answers "who" for the profile screen, and they are deliberately separate —
   * the count runs on every approval and has no business fetching rows.
   *
   * Not paged. A partner's direct line is a handful of people by construction:
   * the ladder is two rungs deep, so anyone with sub-partners has them at the
   * only level below their own. If that stops being true the screen will want
   * paging, and this signature is where it goes.
   *
   * UNSCOPED, and the caller is where scope is applied. The parent has already
   * been checked visible by the time this runs, and filtering the children by
   * the reader's own tag scope would silently under-report a partner's line —
   * "you have two sub-partners" when they have five is worse than the panel
   * saying it is scoped.
   */
  async findDirectPartners(parentUserId: string) {
    return (
      this.db
        .select({
          userId: ibAccounts.userId,
          /* The RUNG they stand on, which is what decides their terms (0112). */
          level: ibAccounts.level,
          levelName: ibLevels.name,
          referralCode: ibAccounts.referralCode,
          active: ibAccounts.active,
          approvedAt: ibAccounts.approvedAt,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
        })
        .from(ibAccounts)
        .innerJoin(users, eq(users.id, ibAccounts.userId))
        /*
         * `leftJoin`, and the nullability is real: `ib_accounts.level` is NOT
         * NULL but carries no foreign key to `ib_levels`, deliberately — a tree
         * may legitimately run deeper than the ladder the broker pays on, and a
         * FK would make appointing that partner impossible rather than making
         * them earn nothing. So a partner on an unconfigured rung is a row this
         * table can hold, and `levelName` is null for them.
         */
        .leftJoin(ibLevels, eq(ibLevels.level, ibAccounts.level))
        .where(eq(ibAccounts.parentIbUserId, parentUserId))
        .orderBy(asc(ibAccounts.level), desc(ibAccounts.approvedAt))
    );
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
      })
      .from(ibAccounts)
      .innerJoin(users, eq(users.id, ibAccounts.userId))
      /*
       * The programme join is GONE (0112), and removing it was not optional.
       *
       * It was an INNER join on `ib_accounts.program_id`, which is nullable now
       * and null on every partner appointed since. That silently returned an
       * EMPTY page while the count beside it still said two — a partner list
       * that reports a total it cannot show, which is the worst shape a list
       * can have because it looks like a filter rather than a bug.
       *
       * `account.level` carries what the programme name used to: which terms
       * this partner is on.
       */
      .where(visible)
      // `user_id` is this table's PRIMARY KEY — one partner account per client —
      // so it is the unique tiebreak here, where the applications queue uses
      // `id`. Load-bearing for the same reason: a catalogue has a handful of
      // programmes, so ties across a page boundary are the norm rather than the
      // exception when sorting by `programName`.
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

  /**
   * The COMMISSION LEDGER — every accrual, who earned it and who generated it.
   *
   * ## ⚠️ Nothing read this table before
   *
   * The engine wrote `ib_accruals` on every settled deposit and no endpoint,
   * screen or export ever read them back. An operator could see partners and
   * levels but not one commission: not who had earned what, not what was pending
   * against what was confirmed, and not which client produced it. "What do we
   * owe our partners" was unanswerable outside the database.
   *
   * ## Two user joins, and they are different people
   *
   * `ibUser` is the partner being PAID; `clientUser` is the client whose deposit
   * generated it. Conflating them is the mistake this shape exists to prevent —
   * a commission row is a statement about a relationship, and showing one side
   * makes it unreadable.
   *
   * ## The scope predicate is on the PARTNER
   *
   * An admin restricted to a set of clients sees the accruals of the partners
   * they can see. Filtering on the client instead would leak a partner's total
   * earnings to somebody entitled to only part of their book.
   */
  async findAccrualsPage(filter: {
    page: number;
    limit: number;
    scope?: ClientScope;
    ibUserId?: string;
    clientUserId?: string;
    status?: string;
    /** `commission` or `rebate`. Absent returns BOTH — see the route. */
    kind?: string;
    sort?: IbAccrualSortKey;
    order?: SortOrder;
  }) {
    /*
     * Rows are scoped on the PARTNER (`ib_user_id`): a scoped admin sees the
     * accruals of a partner in their territory. But each accrual ALSO names the
     * CLIENT whose deposit generated it, and that client may be OUTSIDE the
     * reader's territory — so a scoped desk reviewing an in-scope partner's
     * commissions was shown out-of-scope clients' names and emails (#4, the
     * 13 Aug scoped walk).
     *
     * The fix is the field-mask philosophy (RBAC-03): keep the row and its
     * AMOUNTS — the partner's earning is legitimately theirs to review — but
     * NULL the out-of-scope client's identity. The amounts a partner earned are
     * not PII; the client who generated them is. `clientInScope` is computed in
     * SQL from the same predicate every other surface uses, and the masking is
     * applied in the mapper below, so it cannot be forgotten by a later select.
     */
    const scope = filter.scope ?? UNRESTRICTED;
    const visible = clientScopePredicate(scope, ibAccruals.ibUserId);
    const where = and(
      visible,
      ...(filter.ibUserId ? [eq(ibAccruals.ibUserId, filter.ibUserId)] : []),
      ...(filter.clientUserId ? [eq(ibAccruals.clientUserId, filter.clientUserId)] : []),
      ...(filter.status ? [eq(ibAccruals.status, filter.status as 'pending')] : []),
      /* Validated against the column's own enum at the edge, so an
         unrecognised value is a 400 rather than a filter matching nothing. */
      ...(filter.kind ? [eq(ibAccruals.kind, filter.kind as 'commission')] : []),
    );

    const sortKey: IbAccrualSortKey = filter.sort ?? DEFAULT_IB_ACCRUAL_SORT;
    const direction = filter.order ?? 'desc';
    const sortColumn: SQLWrapper = IB_ACCRUAL_SORT_COLUMNS[sortKey];

    /*
     * Aliased, because both joins land on `users`. Without distinct aliases the
     * second join is a duplicate table reference and the query is ambiguous.
     */
    const partner = aliasedTable(users, 'partner_user');
    const client = aliasedTable(users, 'client_user');

    // True when the client on the row is inside the reader's territory. An
    // unrestricted reader has no predicate, so every row is in scope.
    const clientScope = clientScopePredicate(scope, client.id);
    const clientInScopeExpr = clientScope ? sql<boolean>`(${clientScope})` : sql<boolean>`true`;

    const rawRows = await this.db
      .select({
        accrual: ibAccruals,
        /*
         * The TERMS that produced this row, by name — from whichever column
         * carries them.
         *
         * A row records EXACTLY ONE: `level_id` since 0112, `program_id` before
         * it, and both are nullable so neither can be joined inner. An inner
         * join on either would drop half the ledger out of the list — which is
         * the one thing an append-only financial record must never do. The
         * COALESCE is what makes one column on the screen able to explain a
         * payout from either era.
         */
        termsName: sql<string | null>`COALESCE(${ibLevels.name}, ${ibPrograms.name})`,
        clientInScope: clientInScopeExpr,
        partner: {
          id: partner.id,
          email: partner.email,
          firstName: partner.firstName,
          lastName: partner.lastName,
        },
        client: {
          id: client.id,
          email: client.email,
          firstName: client.firstName,
          lastName: client.lastName,
        },
      })
      .from(ibAccruals)
      .innerJoin(partner, eq(partner.id, ibAccruals.ibUserId))
      .innerJoin(client, eq(client.id, ibAccruals.clientUserId))
      .leftJoin(ibLevels, eq(ibLevels.id, ibAccruals.levelId))
      .leftJoin(ibPrograms, eq(ibPrograms.id, ibAccruals.programId))
      .where(where)
      // `id` breaks the tie. `status` and `depth` have a handful of values, so
      // ties across a page boundary are the norm — without it, paging such a
      // sort can repeat one row and skip another.
      .orderBy(...orderTerms(sortColumn, ibAccruals.id, direction))
      .limit(filter.limit)
      .offset((filter.page - 1) * filter.limit);

    /*
     * Mask the out-of-scope client's IDENTITY and strip the internal flag. The
     * `id` is kept (an opaque uuid names no one and the row still needs a key);
     * email and name — the PII the finding names — become null, and
     * `clientMasked` tells the screen to render "client outside your territory"
     * rather than a blank that reads as missing data. The accrual amounts are
     * untouched: the partner earned them and may review them.
     */
    const rows = rawRows.map(({ clientInScope, ...row }) =>
      clientInScope
        ? { ...row, clientMasked: false }
        : {
            ...row,
            client: { id: row.client.id, email: null, firstName: null, lastName: null },
            clientMasked: true,
          },
    );

    const [{ value: total }] = await this.db
      .select({ value: count() })
      .from(ibAccruals)
      .where(where);

    /*
     * Totals by STATUS, summed in SQL over the whole filtered set rather than
     * the page. Adding a page of decimal strings in JavaScript would be both
     * the wrong number (it is one page) and the wrong arithmetic (floats).
     *
     * `::text` keeps the sum a decimal STRING all the way out — §6.1. A bare
     * `sum()` on NUMERIC comes back as a string from the driver anyway, but
     * saying so here means a future change to the select cannot quietly turn it
     * into a number.
     */
    const totals = await this.db
      .select({
        status: ibAccruals.status,
        amount: sql<string>`coalesce(sum(${ibAccruals.amount}), 0)::text`,
      })
      .from(ibAccruals)
      .where(where)
      .groupBy(ibAccruals.status);

    return { rows, total, totals };
  }

  /**
   * Lifetime and pending earnings per partner, for the partner LIST.
   *
   * One grouped query for the whole page rather than one per row: a list of
   * twenty-five partners would otherwise be twenty-five extra round trips to
   * render a column.
   *
   * Returns a map keyed by partner id. A partner with no accruals is simply
   * absent — the caller renders zero, which is the honest reading of "nothing
   * has been earned" and avoids inventing a row that does not exist.
   */
  async earningsByPartner(ibUserIds: string[]) {
    if (ibUserIds.length === 0) return new Map<string, { confirmed: string; pending: string }>();

    const rows = await this.db
      .select({
        ibUserId: ibAccruals.ibUserId,
        status: ibAccruals.status,
        amount: sql<string>`coalesce(sum(${ibAccruals.amount}), 0)::text`,
      })
      .from(ibAccruals)
      .where(inArray(ibAccruals.ibUserId, ibUserIds))
      .groupBy(ibAccruals.ibUserId, ibAccruals.status);

    const map = new Map<string, { confirmed: string; pending: string }>();
    for (const row of rows) {
      const entry = map.get(row.ibUserId) ?? { confirmed: '0', pending: '0' };
      if (row.status === 'confirmed') entry.confirmed = row.amount;
      if (row.status === 'pending') entry.pending = row.amount;
      map.set(row.ibUserId, entry);
    }
    return map;
  }

  async updateAccount(
    userId: string,
    /*
     * `level` replaced `programId` as the term that decides pay — 0112. The
     * programme stays assignable only so a historical value can be corrected;
     * nothing on the live path writes it.
     */
    patch: Partial<Pick<IbAccountRow, 'level' | 'programId' | 'parentIbUserId' | 'active'>>,
  ): Promise<IbAccountRow | undefined> {
    const [row] = await this.db
      .update(ibAccounts)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(ibAccounts.userId, userId))
      .returning();
    return row;
  }
}
