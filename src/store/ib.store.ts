import { accrualBeneficiarySql } from '../common/accrual-beneficiary';
import {
  aliasedTable,
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  or,
  sql,
  type SQLWrapper,
  not,
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
import { clientIdentitySearch } from './users.store';

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

/** One currency's commission for one partner — decimal strings (§6.1). */
export interface PartnerEarnings {
  currency: string;
  confirmed: string;
  pending: string;
}

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
    /*
     * ESCAPED. A user-typed term goes into a LIKE pattern, where `%` and `_` are
     * wildcards and a backslash escapes them — so an operator searching for a
     * literal `%` matched every row, and `a_c` matched `abc`.
     *
     * Not an injection: the value is still a bind parameter. It is a SEARCH that
     * silently answers a different question from the one asked, which on a review
     * queue reads as "everybody is pending" rather than as a bug. Eight sibling
     * searches already escape; these two were the exceptions.
     */
    // A Portal ID or a name/email — see `clientIdentitySearch`.
    const q = filter.q?.trim();
    const matches = q ? clientIdentitySearch(q) : undefined;

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
          portalId: users.portalId,
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
   * SCOPED, and it reports what it withheld.
   *
   * This was unscoped, on the reasoning that filtering the children by the
   * reader's own tag scope "would silently under-report a partner's line — you
   * have two sub-partners when they have five".
   *
   * That is the SAME argument `users.store.ts` made for `listReferredBy` and
   * `countReferredBy` ("unscoped by design"), and it was overturned on 11 Sep —
   * see the header of `test/referral-network-scope.spec.ts`. The reasoning
   * carries over exactly, because a sub-partner IS a client of this platform:
   * "the subject has already been checked visible" is true about the PARTNER
   * and says nothing about the people below them, and an unscoped downline
   * hands over the IDS of clients the reader is specifically denied — a larger
   * oracle than the 403-versus-404 distinction `client-scope.ts` refuses to
   * give away.
   *
   * What it withheld is said as a COUNT (`countDirectPartnersOutside`), never
   * as rows: the owner's ruling of 28 Sep 2026 — "a count, no identity",
   * everywhere a relation crosses a territory (R2). This comment used to argue
   * the opposite, that a count is itself a disclosure; the owner weighed that
   * and chose the count, because a line that silently drops people reads as a
   * partner with nobody beneath them. It matches `referredOutsideScope` on the
   * client profile.
   *
   * It also settles a response that contradicted itself: `countReferredBy` on
   * this same partner-detail payload is scoped, so the counts obeyed territory
   * while the roster beside them did not.
   */
  async findDirectPartners(parentUserId: string, scope: ClientScope) {
    const belongsToParent = eq(ibAccounts.parentIbUserId, parentUserId);

    const rows = await this.db
      .select({
        userId: ibAccounts.userId,
        /* The RUNG they stand on, which is what decides their terms (0112). */
        level: ibAccounts.level,
        levelName: ibLevels.name,
        referralCode: ibAccounts.referralCode,
        active: ibAccounts.active,
        approvedAt: ibAccounts.approvedAt,
        portalId: users.portalId,
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
      // The predicate goes in the WHERE CLAUSE, never a filter after the rows
      // are loaded — client-scope.ts, and the reason it names a `findById
      // reached from somewhere unexpected`.
      .where(and(belongsToParent, clientScopePredicate(scope, users.id)))
      .orderBy(asc(ibAccounts.level), desc(ibAccounts.approvedAt));

    return rows;
  }

  /**
   * How many of this partner's DIRECT sub-partners `findDirectPartners`
   * withheld from this reader — the count, never who (R2). Zero for an
   * unrestricted reader, without a query.
   */
  async countDirectPartnersOutside(parentUserId: string, scope: ClientScope): Promise<number> {
    const inScope = clientScopePredicate(scope, ibAccounts.userId);
    if (!inScope) return 0;
    const [{ value }] = await this.db
      .select({ value: count() })
      .from(ibAccounts)
      .where(and(eq(ibAccounts.parentIbUserId, parentUserId), not(inScope)));
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
    /**
     * A Portal ID, a name or an email — through `clientIdentitySearch`, the one
     * definition every client search shares — OR a referral code.
     *
     * The code is the one thing an operator is most often handed about a
     * partner ("a client signed up with ABC123 — whose is that?"), and it was
     * findable nowhere: the directory took no search at all and the client list
     * does not know codes exist. Matched EXACTLY, upper-cased the way
     * `recordReferrer` normalises one, so it rides the column's unique index.
     *
     * AND-ed with `visible` like every other term, so a scoped admin cannot
     * find a partner outside their territory by guessing a code — the search
     * narrows what they may see and never widens it.
     */
    q?: string;
    /** `true` active partners only, `false` suspended only, absent both. */
    active?: boolean;
  }) {
    const visible = clientScopePredicate(filter.scope ?? UNRESTRICTED, users.id);
    const term = filter.q?.trim();
    const where = and(
      visible,
      ...(term
        ? [or(clientIdentitySearch(term, users), eq(ibAccounts.referralCode, term.toUpperCase()))]
        : []),
      ...(filter.active === undefined ? [] : [eq(ibAccounts.active, filter.active)]),
    );
    /*
     * The PARENT, by Portal ID — the number the console names people by. Only
     * when the parent is inside the reader's territory: the list is scoped on
     * the partner, and their parent may sit in a territory this reader does not
     * hold. The Portal ID is the handle every other screen's search takes, so
     * it goes with the rest of an out-of-scope person's identity.
     */
    const parentVisible = clientScopePredicate(
      filter.scope ?? UNRESTRICTED,
      ibAccounts.parentIbUserId,
    );
    const parentPortalId = sql<number | null>`(SELECT parent.portal_id FROM users AS parent
      WHERE parent.id = ${ibAccounts.parentIbUserId}${parentVisible ? sql` AND ${parentVisible}` : sql``})`;

    const sortKey: IbPartnerSortKey = filter.sort ?? DEFAULT_IB_PARTNER_SORT;
    const direction = filter.order ?? 'desc';
    const sortColumn: SQLWrapper = IB_PARTNER_SORT_COLUMNS[sortKey];

    const rows = await this.db
      .select({
        account: ibAccounts,
        user: {
          id: users.id,
          portalId: users.portalId,
          email: users.email,
          firstName: users.firstName,
          lastName: users.lastName,
        },
        parentPortalId,
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
      .where(where)
      // `user_id` is this table's PRIMARY KEY — one partner account per client —
      // so it is the unique tiebreak here, where the applications queue uses
      // `id`. Load-bearing for the same reason: a catalogue has a handful of
      // programmes, so ties across a page boundary are the norm rather than the
      // exception when sorting by `programName`.
      .orderBy(...orderTerms(sortColumn, ibAccounts.userId, direction))
      .limit(filter.limit)
      .offset((filter.page - 1) * filter.limit);

    // The SAME `where`, so the total counts exactly the rows a page can show.
    const [{ value: total }] = await this.db
      .select({ value: count() })
      .from(ibAccounts)
      .innerJoin(users, eq(users.id, ibAccounts.userId))
      .where(where);

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
   * An admin restricted to a set of clients sees the accruals whose BENEFICIARY
   * is in their territory — the partner on a commission, the client on a
   * rebate. Scoping every row on the partner would do both wrongs at once: show
   * a partner's desk the rebates that are their client's own money, and hide a
   * client's rebates from the desk that actually holds that client.
   */
  async findAccrualsPage(filter: {
    page: number;
    limit: number;
    scope?: ClientScope;
    ibUserId?: string;
    clientUserId?: string;
    /**
     * The PARTNER's Portal ID, or free text over their email and name — never
     * the client's.
     *
     * The row names two people and only one of them is safely searchable. An
     * out-of-scope person's identity is MASKED in the mapper below, and a
     * filter that matched on it would answer "does someone with this address
     * exist in another territory" from the row count alone — the existence
     * probe the masking is there to prevent.
     *
     * It stays on the PARTNER even now that scope follows the beneficiary,
     * because on a commission — the rows an operator searches this list for —
     * the partner IS the beneficiary and is therefore never masked. On a rebate
     * the partner is attribution rather than entitlement, so a match there
     * reveals nothing about who was paid.
     */
    q?: string;
    status?: string;
    /** `commission` or `rebate`. Absent returns BOTH — see the route. */
    kind?: string;
    sort?: IbAccrualSortKey;
    order?: SortOrder;
  }) {
    /*
     * Each accrual names TWO people, and the reader may hold territory over
     * only one of them. Whichever of the two is out of scope must not have
     * their identity rendered — a scoped desk reviewing an in-scope partner's
     * commissions was shown out-of-scope clients' names and emails (#4, the
     * 13 Aug scoped walk), and the mirror now applies to a rebate whose
     * beneficiary is in scope but whose attributed partner is not.
     *
     * The fix is the field-mask philosophy (RBAC-03): keep the row and its
     * AMOUNTS — the partner's earning is legitimately theirs to review — but
     * NULL the out-of-scope client's identity. The amounts a partner earned are
     * not PII; the client who generated them is. `clientInScope` is computed in
     * SQL from the same predicate every other surface uses, and the masking is
     * applied in the mapper below, so it cannot be forgotten by a later select.
     */
    const scope = filter.scope ?? UNRESTRICTED;

    /*
     * ── THE ROW IS SCOPED ON ITS BENEFICIARY, AND THAT DEPENDS ON `kind` ─────
     *
     * ⚠️ This scoped every row on `ib_user_id`, and on a REBATE that is the
     * wrong person. `confirmPending` states the rule this query has to follow:
     * "`ibUserId` on a rebate row is the partner whose RUNG produced it —
     * attribution, not entitlement", and the money goes to `clientUserId`.
     *
     * Scoping the wrong column inverted the answer in both directions at once.
     * An admin holding the PARTNER's tag saw rebates that are the client's
     * money and the client's business — a client they have no territory over.
     * An admin holding the CLIENT's tag saw none of their own client's rebates,
     * because the row was filed under a partner they cannot see. Both halves
     * were live: every rebate row in this database has `ib_user_id` different
     * from `client_user_id`.
     *
     * A commission is unchanged — the partner earns it, so `ib_user_id` IS the
     * beneficiary and the territory question is about them.
     *
     * Expressed as ONE predicate over a CASE rather than two branches, so the
     * `kind` filter and the scope cannot disagree: an unfiltered list mixes
     * both kinds in one page, and each row has to be judged by its own
     * beneficiary rather than by whichever branch the request happened to take.
     */
    const beneficiary = accrualBeneficiarySql();
    const visible = clientScopePredicate(scope, beneficiary);

    /*
     * Aliased, because both joins land on `users`. Without distinct aliases the
     * second join is a duplicate table reference and the query is ambiguous.
     */
    const partner = aliasedTable(users, 'partner_user');
    const client = aliasedTable(users, 'client_user');

    /*
     * Whether the PERSON a filter or search names is one this reader may see.
     * A row stays visible through its beneficiary while the other party is
     * masked; narrowing by that other party's id or identity would pick their
     * rows out and put a name to the mask. So an outside person answers exactly
     * like an unknown one — no rows. Undefined for an unrestricted reader.
     */
    const partnerScope = clientScopePredicate(scope, partner.id);
    const seesPerson = (id: string) => clientScopePredicate(scope, sql`${id}::uuid`);

    const where = and(
      visible,
      ...(filter.ibUserId
        ? [eq(ibAccruals.ibUserId, filter.ibUserId), seesPerson(filter.ibUserId)]
        : []),
      ...(filter.clientUserId
        ? [eq(ibAccruals.clientUserId, filter.clientUserId), seesPerson(filter.clientUserId)]
        : []),
      ...(filter.status ? [eq(ibAccruals.status, filter.status as 'pending')] : []),
      /* Validated against the column's own enum at the edge, so an
         unrecognised value is a 400 rather than a filter matching nothing. */
      ...(filter.kind ? [eq(ibAccruals.kind, filter.kind as 'commission')] : []),
      /*
       * The partner, by what the SCREEN shows. This list displayed a named
       * Partner column and offered exactly one way to narrow to one —
       * `ibUserId`, a uuid printed nowhere on the page — so an operator looking
       * straight at a partner's rows could not filter to them without leaving
       * for another screen to copy an id.
       *
       * A Portal ID or a name/email, through the one definition every client
       * search shares — on the PARTNER alias, for the reason given on `q`, and
       * only a partner this reader may see (`partnerScope`).
       */
      ...(filter.q?.trim() ? [clientIdentitySearch(filter.q, partner), partnerScope] : []),
    );

    const sortKey: IbAccrualSortKey = filter.sort ?? DEFAULT_IB_ACCRUAL_SORT;
    const direction = filter.order ?? 'desc';
    const sortColumn: SQLWrapper = IB_ACCRUAL_SORT_COLUMNS[sortKey];

    // True when the client on the row is inside the reader's territory. An
    // unrestricted reader has no predicate, so every row is in scope.
    const clientScope = clientScopePredicate(scope, client.id);
    const clientInScopeExpr = clientScope ? sql<boolean>`(${clientScope})` : sql<boolean>`true`;

    /*
     * THE SAME QUESTION ABOUT THE PARTNER, and it became answerable the moment
     * scope started following the beneficiary.
     *
     * Before, a row was only ever visible through its partner, so the partner
     * was in scope by construction and masking them was meaningless. A rebate
     * is now visible through its CLIENT — which is correct, it is the client's
     * money — and the partner on that row is attribution: someone whose
     * territory this reader may not hold. Rendering their name and email would
     * reintroduce the 13 Aug finding pointing the other way.
     */
    const partnerInScopeExpr = partnerScope ? sql<boolean>`(${partnerScope})` : sql<boolean>`true`;

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
        partnerInScope: partnerInScopeExpr,
        partner: {
          id: partner.id,
          portalId: partner.portalId,
          email: partner.email,
          firstName: partner.firstName,
          lastName: partner.lastName,
        },
        client: {
          id: client.id,
          portalId: client.portalId,
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
    const rows = rawRows.map(({ clientInScope, partnerInScope, ...row }) => {
      /*
       * EITHER PERSON can be the out-of-scope one, and the masks are applied
       * independently. A commission is visible through its partner, so the
       * client is the one that may need masking; a rebate is visible through
       * its client, so the partner is. Masking only whichever the row was
       * matched ON would leave the other side exposed on the other kind.
       *
       * The AMOUNTS are untouched either way — the row is visible because its
       * beneficiary is in territory, and what they were paid is the reader's
       * business. It is the other party's identity that is not.
       */
      /*
       * The Portal ID goes with the name. Unlike the uuid it is not opaque: it
       * is the number an operator types into every other screen's search, so
       * showing it for someone outside the reader's territory would hand them
       * the key to a person they may not look up.
       */
      /*
       * The uuid goes too (R1): the row still has its own key, `accrual.id`,
       * and an outside person's record id is not the reader's to hold.
       */
      const hide = () => ({
        id: null as string | null,
        portalId: null as number | null,
        email: null as string | null,
        firstName: null as string | null,
        lastName: null as string | null,
      });

      return {
        ...row,
        /*
         * The accrual names both people again by id, and names the outside
         * client's trade: those go with the mask. The amounts, dates and terms
         * stay — they are the visible beneficiary's.
         */
        accrual: {
          ...row.accrual,
          clientUserId: clientInScope ? row.accrual.clientUserId : null,
          ibUserId: partnerInScope ? row.accrual.ibUserId : null,
          sourceId: clientInScope ? row.accrual.sourceId : null,
        },
        client: clientInScope ? row.client : hide(),
        partner: partnerInScope ? row.partner : hide(),
        clientMasked: !clientInScope,
        partnerMasked: !partnerInScope,
      };
    });

    /*
     * The partner join is REQUIRED here, not decorative: `where` can now name
     * `partner_user` columns, and a count query that does not join the alias
     * fails at the database with "missing FROM-clause entry" — a 500 on the
     * first keystroke in the search box, which is exactly how the same omission
     * presented on the ledger. The join cannot change the count: `ib_user_id`
     * is NOT NULL with a foreign key.
     */
    const [{ value: total }] = await this.db
      .select({ value: count() })
      .from(ibAccruals)
      .innerJoin(partner, eq(partner.id, ibAccruals.ibUserId))
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
      .innerJoin(partner, eq(partner.id, ibAccruals.ibUserId))
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
  /**
   * What each partner has earned, ONE ENTRY PER CURRENCY — never one total.
   *
   * ⚠️ This grouped by `(ib_user_id, status)` alone and summed `amount` across
   * whatever currencies the accruals were in. An accrual takes the currency of
   * the trade that produced it, so a partner earning 100 USD and 90 EUR was
   * reported as having earned 190 — and the profile's Partner tab then printed
   * that 190 as the platform's default currency. A plausible number describing
   * nothing, on the one figure a partner is paid against; the same rule the
   * portal's `largestBalance` and every per-currency summary here keep (there
   * is no FX source in this system, so there is nothing to convert WITH).
   *
   * Sorted by currency so the order is stable between reads. A partner with no
   * commission in any currency is absent from the map — callers report `[]`,
   * "nothing earned yet", rather than a zero in a currency nobody chose.
   *
   * Reversed accruals are excluded in the query rather than skipped in the
   * loop: they never counted towards either figure, and grouping them would
   * give a currency that only ever held a clawback a row of zeroes.
   */
  async earningsByPartner(ibUserIds: string[]) {
    const byPartner = new Map<string, PartnerEarnings[]>();
    if (ibUserIds.length === 0) return byPartner;

    const rows = await this.db
      .select({
        ibUserId: ibAccruals.ibUserId,
        currency: ibAccruals.currency,
        status: ibAccruals.status,
        amount: sql<string>`coalesce(sum(${ibAccruals.amount}), 0)::text`,
      })
      .from(ibAccruals)
      .where(
        and(
          inArray(ibAccruals.ibUserId, ibUserIds),
          inArray(ibAccruals.status, ['confirmed', 'pending']),
          /*
           * ── COMMISSION ONLY. A REBATE IS NOT THIS PARTNER'S EARNING ───────
           *
           * ⚠️ This summed EVERY accrual carrying the partner's id, and a
           * rebate row carries it too — `ibUserId` there is the partner whose
           * rung PRICED the rebate, while the money is paid to
           * `clientUserId`. `confirmPending` says so in as many words:
           * "attribution, not entitlement".
           *
           * So a partner's lifetime earnings were inflated by money that went
           * to their clients. Measured on this database: one partner earned
           * 20.79 and the figure read 41.58, because their client's rebate
           * happened to equal their commission. It is not a rounding
           * discrepancy — it is a different person's money added in.
           *
           * The wallet was always right; only this display total was wrong,
           * which is the worst shape for it: an operator reconciling the
           * partner's commission wallet against the number on screen finds a
           * gap and no explanation for it.
           */
          eq(ibAccruals.kind, 'commission'),
        ),
      )
      .groupBy(ibAccruals.ibUserId, ibAccruals.currency, ibAccruals.status)
      .orderBy(asc(ibAccruals.currency));

    for (const row of rows) {
      const entries = byPartner.get(row.ibUserId) ?? [];
      let entry = entries.find((candidate) => candidate.currency === row.currency);
      if (!entry) {
        entry = { currency: row.currency, confirmed: '0', pending: '0' };
        entries.push(entry);
        byPartner.set(row.ibUserId, entries);
      }
      if (row.status === 'confirmed') entry.confirmed = row.amount;
      if (row.status === 'pending') entry.pending = row.amount;
    }
    return byPartner;
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
