import {
  SQL,
  type SQLWrapper,
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  isNull,
  sql,
} from 'drizzle-orm';
import type { CursorPosition } from '../common/pagination';
import { sortKey, sortOrder } from '../common/sorting';
import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE_DB } from '../database/database.module';
import type { Db, Executor } from '../database/db';
import {
  clientTagAssignments,
  clientTags,
  ibAccounts,
  kycSubmissions,
  users,
} from '../database/schema';
import {
  clientScopePredicate,
  UNRESTRICTED,
  type ClientScope,
} from '../common/security/client-scope';

/**
 * The columns the client list may be ordered by — R-2.5's explicit allowlist.
 *
 * WHY AN ALLOWLIST AND NOT A COLUMN NAME FROM THE QUERY STRING: a sort
 * parameter interpolated into SQL is an injection point, and drizzle 0.45's
 * advisory (GHSA-gpj5-g38j-94v9) is specifically about improperly escaped
 * identifiers — a class this repo was only safe from because no dynamic column
 * name existed anywhere. This is the change that would have made it reachable,
 * so the mapping from a caller's string to a column object is total and closed.
 *
 * WHY IT MAY NOT EXCEED THE INDEXES: every entry needs a `(col DESC, id DESC)`
 * composite, or the seek degrades to a sort over 219,000 rows on every page.
 * Migration 0024 creates exactly these, `test/client-list-indexes.spec.ts`
 * asserts the query PLANS, and adding a key here without an index makes that
 * spec fail rather than making the screen quietly slow.
 *
 * `country` maps to a COALESCE expression, not to the bare column. It is
 * nullable, and `(country, id) < (?, ?)` is UNKNOWN — not false — for every
 * null row, so those clients would silently vanish from the list rather than
 * sorting to one end. On a compliance screen, rows disappearing without a word
 * is the worst available outcome. Migration 0024's index matches this
 * expression exactly; change one and the other stops being used.
 */
export const CLIENT_SORT_COLUMNS = {
  createdAt: users.createdAt,
  email: users.email,
  firstName: users.firstName,
  status: users.status,
  verificationLevel: users.verificationLevel,
  country: sql`coalesce(${users.country}, '')`,
} as const;

/**
 * A client's type, DERIVED — never read from `users.type`.
 *
 * ## The column was a label nothing maintained
 *
 * `users.type` is an enum of individual / referral / partner, written once at
 * registration as the literal `'individual'` and never updated by anything:
 * approving a partner creates an `ib_accounts` row and leaves the label alone,
 * and resolving a referral code writes `referred_by_ib_user_id` and leaves it
 * alone too. On the database this was written against it read 20,032 individual,
 * 1 referral, 1 partner — against 7 real partners and 9 real referrals, both of
 * those being seed rows that happened to be inserted with a value.
 *
 * That is what made the console disagree with itself: the partners screen reads
 * `ib_accounts` and found 7, while the clients screen filtered on this column
 * and found 1. Same question, two answers, and the one a person would check
 * first was the wrong one.
 *
 * ## Derived, so there is nothing to keep in sync
 *
 * A partner IS a row in `ib_accounts`; a referral IS an attributed client. Both
 * are already the authority everywhere else — `SELECT FROM ib_accounts` is how
 * the rest of this codebase answers "is this person a partner", with no second
 * half to forget. Reading the same way here means the label cannot drift,
 * because there is no label.
 *
 * PARTNER WINS over referral when both are true, and that combination is
 * ordinary rather than exotic: a partner introduced by another partner is
 * exactly what a two-rung ladder produces. Their own account is the more
 * specific fact and the one an operator is looking for.
 */
export const DERIVED_CLIENT_TYPE = sql<'individual' | 'referral' | 'partner'>`
  CASE
    WHEN EXISTS (SELECT 1 FROM ${ibAccounts} WHERE ${ibAccounts.userId} = ${users.id})
      THEN 'partner'
    WHEN ${users.referredByIbUserId} IS NOT NULL THEN 'referral'
    ELSE 'individual'
  END`;

export type ClientSortKey = keyof typeof CLIENT_SORT_COLUMNS;

/** A user-typed search term, safe to embed inside a LIKE pattern. */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Is this search term a complete uuid — i.e. a pasted client ID?
 *
 * Full uuids only, on purpose: a fragment stays on the name/email ILIKE path,
 * because "matches nothing" is a truthful answer for half an ID while an
 * accidental prefix match against the wrong client is not. Comparing a
 * non-uuid string to the `users.id` column would also be a Postgres cast
 * error, not an empty result.
 */
export function isUuid(term: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(term.trim());
}

export const DEFAULT_CLIENT_SORT: ClientSortKey = 'createdAt';

/**
 * A caller's `?sort=` string, or a 400 naming what is allowed.
 *
 * NEVER a silent fallback to the default. R-2.5: "an unrecognised value is a
 * 400, never a silent fallback — a silently ignored sort is a lie the UI
 * tells." The admin clicks a header, the rows do not change, and there is
 * nothing anywhere to explain why.
 *
 * ## ⚠️ THIS DELEGATES NOW, AND THE HAND-WRITTEN VERSION IS WHY
 *
 * This was a bespoke copy of `sortKey`, kept deliberately — `common/sorting.ts`
 * still says so, calling this "the one list that already had this right". It
 * did not. The copy gated on `value in CLIENT_SORT_COLUMNS`, and `in` walks the
 * PROTOTYPE CHAIN: `'constructor' in {}` is `true`, and so are `__proto__`,
 * `toString`, `valueOf` and `hasOwnProperty`. So five strings passed a check
 * whose entire job is to be a closed allowlist, and `CLIENT_SORT_COLUMNS[key]`
 * then handed a function — `Object`, not a column — to drizzle as an ORDER BY
 * term.
 *
 * It was not SQL injection: drizzle binds an unknown value as a PARAMETER, not
 * an identifier, so the damage stopped at an unhandled 500. Nor was it reachable
 * anonymously — `AdminGuard` runs first, so a caller needs a real admin session
 * to reach the sort validator at all. What it WAS is a validator bypass on
 * `GET /admin/clients` and the client CSV export, from a string the weakest
 * admin account could send.
 *
 * `sortKey` in `common/sorting.ts` had it right all along
 * (`Object.prototype.hasOwnProperty.call`), which is the argument for deleting a
 * duplicate rather than patching it: the bug existed only in the copy, and only
 * because it was a copy. The two bespoke behaviours that justified keeping it —
 * a message naming *clients* and a default of `createdAt` — are both parameters
 * of the shared helper.
 */
export function clientSortKey(value: string | undefined): ClientSortKey {
  return sortKey(value, CLIENT_SORT_COLUMNS, DEFAULT_CLIENT_SORT, 'clients');
}

export function clientSortOrder(value: string | undefined): 'asc' | 'desc' {
  return sortOrder(value, 'desc');
}

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  firstName: string;
  lastName: string;
  type: 'individual' | 'referral' | 'partner';
  status: 'active' | 'suspended' | 'pending';
  verificationLevel: 0 | 1;
  emailVerified: boolean;
  /** SHA-256 of the emailed verification token — never the token itself. */
  emailVerificationTokenHash?: string;
  emailVerificationExpiry?: Date;
  /** When that token was redeemed. Undefined means still outstanding. */
  emailVerificationConsumedAt?: Date;
  /** SHA-256 of the emailed reset token — never the token itself. */
  passwordResetTokenHash?: string;
  passwordResetExpiry?: Date;
  /** Cutoff for outstanding access tokens - see jwt.strategy.ts. */
  passwordChangedAt?: Date;
  /** Stored filename of the profile photo - see the column comment. */
  avatarFilename?: string;
  country?: string;
  phone?: string;
  /**
   * The partner who introduced them, or undefined for a direct signup.
   *
   * Set once at registration. Nothing updates it — see the column comment: a
   * mutable attribution is a route for one partner's earnings to move to
   * another.
   */
  referredByIbUserId?: string;
  createdAt: Date;
}

type Row = typeof users.$inferSelect;

const toUser = (r: Row): User => ({
  ...r,
  verificationLevel: r.verificationLevel === 1 ? 1 : 0,
  emailVerificationTokenHash: r.emailVerificationTokenHash ?? undefined,
  emailVerificationExpiry: r.emailVerificationExpiry ?? undefined,
  emailVerificationConsumedAt: r.emailVerificationConsumedAt ?? undefined,
  passwordResetTokenHash: r.passwordResetTokenHash ?? undefined,
  passwordResetExpiry: r.passwordResetExpiry ?? undefined,
  passwordChangedAt: r.passwordChangedAt ?? undefined,
  avatarFilename: r.avatarFilename ?? undefined,
  country: r.country ?? undefined,
  phone: r.phone ?? undefined,
  referredByIbUserId: r.referredByIbUserId ?? undefined,
});

/**
 * Every single-row read selects THIS, not `users.*`.
 *
 * `type` is the derived expression (see `DERIVED_CLIENT_TYPE`): the list had
 * moved to it while `findById`, `findForAdmin` and `findByEmail` still read the
 * raw column — so the client list said `partner` and the profile, the portal's
 * own `/auth/me` and every edit response said `individual` about the same
 * person. Same question, two answers, which is precisely what the derived
 * expression was introduced to end. The raw column is write-only now.
 */
const USER_COLUMNS = { ...getTableColumns(users), type: DERIVED_CLIENT_TYPE };

@Injectable()
export class UsersStore {
  constructor(@Inject(DRIZZLE_DB) private readonly db: Db) {}

  async create(data: Omit<User, 'id' | 'createdAt'>): Promise<User> {
    const [row] = await this.db.insert(users).values(data).returning();
    return toUser(row);
  }

  async findById(id: string): Promise<User | undefined> {
    const [row] = await this.db.select(USER_COLUMNS).from(users).where(eq(users.id, id)).limit(1);
    return row ? toUser(row) : undefined;
  }

  /*
   * ⚠️ BOTH METHODS BELOW TAKE THE READER'S SCOPE, AND THAT REVERSES WHAT THEY
   * SAID UNTIL 11 Sep 2026. The old text is quoted here rather than deleted,
   * because it was ARGUED rather than forgotten and the argument deserves an
   * answer:
   *
   *   "Unscoped by design, like IbStore.findDirectPartners and for the same
   *    reason — the subject has already been checked visible, and a count
   *    filtered by the reader's own tags would under-report a partner's book
   *    without saying so."
   *
   * The first clause is true about the PARTNER and says nothing about their
   * CLIENTS. A scoped admin who may see partner P was never thereby entitled to
   * P's referred clients: scope is row-level visibility over CLIENTS, and each
   * of those rows is a client. Field masking does not cover this — masking
   * hides FIELDS by role, scope hides ROWS by territory, and an unscoped
   * downline hands over ids and names of up to fifty clients the reader is
   * specifically denied. That is a larger oracle than the 403-versus-404
   * distinction `client-scope.ts` refuses to give away.
   *
   * The second clause is a real worry with the wrong remedy. "It would
   * under-report without saying so" argues for SAYING SO, not for over-
   * reporting: `referredShown` and `referredTotal` now let the screen state
   * exactly what it is showing and out of how many.
   *
   * `client-scope.ts` is the governing document and it names this case:
   * "The predicate goes in the WHERE CLAUSE. Never fetch-then-filter... a new
   * export endpoint, A COUNT, a join, a findById reached from somewhere
   * unexpected". A count was on the list.
   *
   * THE DECIDING PRECEDENT is that the client LIST's own total is already
   * scoped — `findPage` runs the same predicate over its count, and the
   * territory e2e pins that a scoped reader's total counts only their own.
   * Leaving these two unscoped made the Network tab disagree with the very
   * screen it links into: "50 of 213" above a filtered list of 60. Consistency
   * here is not tidiness, it is the difference between a screen a reader can
   * believe and one that contradicts itself.
   */

  /**
   * How many clients this partner introduced THAT THIS READER MAY SEE.
   *
   * A COUNT rather than a list: the profile shows the figure beside the
   * capped list, and fetching rows to call `.length` on them would grow with a
   * partner's book to render one number. That is also why it must not be
   * replaced by `referredClients.length` — see `IbOverviewDto`, which says so
   * in capitals about its own capped array.
   */
  async countReferredBy(ibUserId: string, scope: ClientScope): Promise<number> {
    const scoped = clientScopePredicate(scope, users.id);
    const where = eq(users.referredByIbUserId, ibUserId);
    const [{ value }] = await this.db
      .select({ value: count() })
      .from(users)
      .where(scoped ? and(where, scoped) : where);
    return value;
  }

  /**
   * The clients this partner introduced, newest first, LIMITED TO WHAT THIS
   * READER MAY SEE — for the one screen that shows the people rather than the
   * figure: the admin client profile's Network tab.
   *
   * CAPPED by the caller, because a profile renders one screen of names and a
   * partner's book grows without bound. The cap is what `referredShown`
   * reports; `countReferredBy` above is what the reader is being shown OUT OF.
   */
  async listReferredBy(ibUserId: string, limit: number, scope: ClientScope): Promise<User[]> {
    const scoped = clientScopePredicate(scope, users.id);
    const where = eq(users.referredByIbUserId, ibUserId);
    const rows = await this.db
      .select(USER_COLUMNS)
      .from(users)
      .where(scoped ? and(where, scoped) : where)
      .orderBy(desc(users.createdAt), asc(users.id))
      .limit(limit);
    return rows.map(toUser);
  }

  /**
   * A client, if this ADMINISTRATOR may see them — the scoped `findById`.
   *
   * DELIBERATELY A DIFFERENT NAME rather than an optional argument on
   * `findById`. Every admin-facing by-id read has to go through a method whose
   * name says it applied the scope, so a call site that forgot is visible as a
   * different function rather than as a missing second argument nobody notices
   * in review. `findById` remains correct for the portal, jobs and anything
   * else that is not acting on behalf of an administrator.
   *
   * Returns undefined for an out-of-scope client, which is what makes the
   * caller's existing `NotFoundError` fire — 404, never 403. A 403 would
   * distinguish "no such client" from "not yours", and that difference is an
   * oracle for enumerating the client base an admin was specifically denied.
   */
  async findForAdmin(id: string, scope: ClientScope): Promise<User | undefined> {
    const scoped = clientScopePredicate(scope, users.id);
    const [row] = await this.db
      .select(USER_COLUMNS)
      .from(users)
      // In the WHERE clause, never a post-fetch comparison — the rule this
      // whole feature rests on. See common/security/client-scope.ts.
      .where(scoped ? and(eq(users.id, id), scoped) : eq(users.id, id))
      .limit(1);
    return row ? toUser(row) : undefined;
  }

  async findByEmail(email: string): Promise<User | undefined> {
    const [row] = await this.db
      .select(USER_COLUMNS)
      .from(users)
      .where(eq(users.email, email.toLowerCase()))
      .limit(1);
    return row ? toUser(row) : undefined;
  }

  /**
   * Look a user up by the HASH of their reset token.
   *
   * The caller hashes the token it received; this never sees the token itself,
   * which is the whole point of storing a digest (see schema.ts). Indexed,
   * because this lookup is unauthenticated and an attacker can trigger it at
   * will — without the index it is a sequential scan on demand.
   */
  async findByPasswordResetTokenHash(hash: string): Promise<User | undefined> {
    const [row] = await this.db
      .select(USER_COLUMNS)
      .from(users)
      .where(eq(users.passwordResetTokenHash, hash))
      .limit(1);
    return row ? toUser(row) : undefined;
  }

  /**
   * By the HASH of the emailed token, mirroring `findByPasswordResetTokenHash`.
   *
   * Takes a hash rather than the token so the plaintext credential stops at the
   * service that received it and never reaches a query the database logs.
   */
  async findByVerificationTokenHash(hash: string): Promise<User | undefined> {
    const [row] = await this.db
      .select(USER_COLUMNS)
      .from(users)
      .where(eq(users.emailVerificationTokenHash, hash))
      .limit(1);
    return row ? toUser(row) : undefined;
  }

  /**
   * Redeem a verification token. `true` if THIS call did it, `false` if it was
   * already redeemed.
   *
   * ## Why a conditional UPDATE and not read-then-write
   *
   * Two POSTs of the same token arrive together more often than the flow
   * suggests: React StrictMode double-mounts in development, a mail scanner
   * prefetches the link a moment before the human clicks it, and a refresh
   * re-sends it. A read of `consumed_at` followed by a write lets both callers
   * see NULL and both believe they were first — harmless for the account's
   * final state, but it makes the answer a coin toss, which is the defect this
   * whole change exists to remove.
   *
   * `WHERE ... consumed_at IS NULL` with a rowcount check is the §6.3
   * idempotency idiom, applied here for the same reason it is applied to
   * payouts: the database decides who was first, not the application.
   *
   * `email_verified` and `consumed_at` are set in this ONE statement and are
   * written nowhere else together, so no reader can observe a row that is
   * consumed but unverified.
   */
  async consumeEmailVerification(id: string, tokenHash: string, at: Date): Promise<boolean> {
    const rows = await this.db
      .update(users)
      .set({ emailVerified: true, emailVerificationConsumedAt: at })
      .where(
        and(
          eq(users.id, id),
          eq(users.emailVerificationTokenHash, tokenHash),
          isNull(users.emailVerificationConsumedAt),
        ),
      )
      .returning({ id: users.id });
    return rows.length === 1;
  }

  /**
   * Patch a user. A key present with `undefined` means CLEAR that column.
   *
   * Drizzle drops undefined values from `.set()`, which makes "clear this
   * field" inexpressible and, when every value is undefined, throws "No values
   * to set" — a runtime failure from what reads like an ordinary update. The
   * password-reset expiry path hit exactly that: clearing a dead token is an
   * update whose every field is a clear.
   *
   * `in` rather than a truthiness check, so omitting a key (leave it alone) and
   * passing it as undefined (clear it) stay distinguishable — which is the
   * distinction Drizzle's own behaviour loses.
   */
  /**
   * `executor` lets a caller write inside THEIR transaction, same shape as
   * `AuditLogStore.record` and the money services' `executor ?? this.db`.
   *
   * Needed because raising `verification_level` and writing the KYC decision
   * have to be one atomic act: they are what opens the withdrawal gate, and a
   * crash between them used to leave one of two states.
   */
  async update(id: string, patch: Partial<User>, executor?: Executor): Promise<User | undefined> {
    const { id: _ignored, createdAt: _also, ...rest } = patch;

    /*
     * Issuing a new verification token MUST end the previous cycle.
     *
     * `email_verification_consumed_at` outlives redemption by design, so a row
     * that carried one and then gets a fresh token would present that token as
     * already redeemed. The client's very first click on a brand-new link would
     * be answered `already_verified`, verifying nothing while telling them it
     * had — and they would then be refused at login on an address that really is
     * unverified, with nothing on screen explaining why.
     *
     * Two callers issue tokens through this method today
     * (`AuthService.resendVerification`, `AdminClientsService.changeEmail`) and
     * both clear it. This is here so the third one cannot forget: a prose rule
     * in a column comment is not a rule, and the failure it prevents surfaces
     * far away from the line that caused it.
     *
     * It refuses rather than silently clearing, because "which cycle is this
     * row in" is not a question a store should answer on the caller's behalf.
     * Registration is unaffected — it INSERTs, where NULL is already correct.
     */
    /*
     * `typeof === 'string'` rather than `!= null`, and NOT `!== null`.
     *
     * The distinction is load-bearing: callers clear a token by passing
     * `undefined` (auth.service.ts:410 and :576), and the loop below turns
     * `undefined` into a NULL write. So this guard must fire only when a REAL
     * token is being issued. `!== null` would treat the clearing calls as
     * issuance and throw on them — which is what a linter's `eqeqeq` autofix
     * would have produced from the original `!= null`.
     */
    if (
      typeof rest.emailVerificationTokenHash === 'string' &&
      !('emailVerificationConsumedAt' in patch)
    ) {
      throw new Error(
        'users.update: setting emailVerificationTokenHash must also set ' +
          'emailVerificationConsumedAt (pass undefined to clear it). A new token ' +
          "inherits the previous cycle's redemption otherwise — see schema.ts.",
      );
    }

    const values: Record<string, unknown> = {};
    for (const key of Object.keys(rest)) {
      const value = (rest as Record<string, unknown>)[key];
      values[key] = value === undefined ? null : value;
    }
    if (Object.keys(values).length === 0) return this.findById(id);

    const [row] = await (executor ?? this.db)
      .update(users)
      .set(values)
      .where(eq(users.id, id))
      .returning();
    return row ? toUser(row) : undefined;
  }

  async findAll(): Promise<User[]> {
    const rows = await this.db.select().from(users);
    return rows.map(toUser);
  }

  /**
   * Paginated, filtered and sorted IN SQL (ADM-01).
   *
   * The previous implementation loaded every row with `SELECT *` — including
   * password_hash and refresh_token — then filtered, sorted and sliced in
   * JavaScript. ARCHITECTURE §5 names ~219,000 clients and warns that "the risk
   * is unindexed filters and N+1 queries in the admin table"; the required
   * indexes existed and were never reached because no predicate got to SQL.
   *
   * Only the columns the admin list renders are selected — secrets never leave
   * the database.
   */
  async findPage(filter: {
    page: number;
    limit: number;
    q?: string;
    type?: string;
    status?: string;
    level?: number;
    /** Exact match on `users.country` — the ADM-14 "country tag". */
    country?: string;
    /** Has the client confirmed their registration address? */
    emailVerified?: boolean;
    /**
     * One of the six `kyc_status` values. `not_started` matches clients with no
     * submission row at all, which is most of them — see the predicate.
     */
    kycStatus?: string;
    /** ADM-14 label filter, by tag SLUG so a rename cannot break a saved link. */
    tagSlug?: string;
    /**
     * The partner who introduced them — `users.referred_by_ib_user_id`.
     *
     * This filter was DOCUMENTED before it existed: the profile's 50-client cap
     * was justified by "the full book stays reachable through the client list
     * filtered by referrer", and it was not. Fifty names, no cap notice, and no
     * route to the rest anywhere in the console.
     *
     * It sits with the other filters rather than beside `listReferredBy`
     * deliberately: this one is PAGED and SCOPED like every other client query,
     * which is what makes it the answer to the cap rather than a second capped
     * surface with its own rules.
     */
    referredBy?: string;
    /** R-2.5 server-side sort. Validated by `clientSortKey` before it gets here. */
    sort?: ClientSortKey;
    order?: 'asc' | 'desc';
    /**
     * Row-level visibility. Defaults to UNRESTRICTED so an existing caller that
     * has not been updated keeps working — but every ADMIN caller must pass the
     * actor's real scope, which is what `test/client-scope-coverage.spec.ts`
     * enforces route by route.
     */
    scope?: ClientScope;
    /** Keyset position — R-2.4. When present, `page` is ignored. */
    cursor?: CursorPosition;
    /** Counting is opt-in: it is a full scan of the filtered set. */
    withTotal?: boolean;
  }) {
    const db = this.db;
    const conditions: SQL[] = [];
    const sortKey: ClientSortKey = filter.sort ?? DEFAULT_CLIENT_SORT;
    const direction = filter.order ?? 'desc';
    const sortColumn: SQLWrapper = CLIENT_SORT_COLUMNS[sortKey];

    /*
     * Filtered on the DERIVED type, so this screen and the partner screens
     * cannot disagree about who is a partner. Filtering `users.type` returned 1
     * against the 7 rows `ib_accounts` actually holds — see DERIVED_CLIENT_TYPE.
     */
    if (filter.type) conditions.push(sql`${DERIVED_CLIENT_TYPE} = ${filter.type}`);
    if (filter.status) conditions.push(eq(users.status, filter.status as 'active'));
    if (typeof filter.level === 'number' && !Number.isNaN(filter.level)) {
      conditions.push(eq(users.verificationLevel, filter.level));
    }
    if (filter.country) conditions.push(eq(users.country, filter.country));

    /*
     * The two filters that make the new columns useful.
     *
     * `kycStatus` filters on the JOINED table, and the `not_started` case has
     * to be written as "the row is absent OR says not_started" — a client who
     * never began verification has no `kyc_submissions` row, so an equality
     * test alone would return nothing for the very group an operator is most
     * likely to be chasing.
     */
    if (typeof filter.emailVerified === 'boolean') {
      conditions.push(eq(users.emailVerified, filter.emailVerified));
    }
    if (filter.kycStatus) {
      conditions.push(
        filter.kycStatus === 'not_started'
          ? sql`coalesce(${kycSubmissions.status}::text, 'not_started') = 'not_started'`
          : sql`${kycSubmissions.status}::text = ${filter.kycStatus}`,
      );
    }

    /*
     * The tag filter, and the client scope, are both EXISTS — never a join.
     *
     * A join multiplies rows the moment a client carries two matching tags,
     * which would duplicate them in the page AND corrupt the keyset seek (the
     * "last row" is then ambiguous). EXISTS short-circuits on the first match
     * and reads `client_tag_assignments_tag_idx` / the composite primary key
     * directly.
     */
    if (filter.tagSlug) {
      conditions.push(
        sql`EXISTS (
          SELECT 1 FROM ${clientTagAssignments} ta
          JOIN ${clientTags} t ON t.id = ta.tag_id
          WHERE ta.user_id = ${users.id} AND t.slug = ${filter.tagSlug}
        )`,
      );
    }

    /*
     * The referrer filter — an equality on an indexed column, and it must stay
     * ABOVE the scope predicate rather than replace it. A reader filtering by a
     * partner they can see is still only entitled to clients in their own
     * territory: without the line below this would be a scope bypass wearing a
     * filter, which is the one way this feature could have made things worse.
     */
    if (filter.referredBy) {
      conditions.push(eq(users.referredByIbUserId, filter.referredBy));
    }

    // The row-level visibility predicate. In the WHERE clause, never after the
    // fetch — see common/security/client-scope.ts for why that is the whole
    // design. `undefined` for an unrestricted actor, and `and()` drops it.
    const scoped = clientScopePredicate(filter.scope ?? UNRESTRICTED, users.id);
    if (scoped) conditions.push(scoped);
    if (filter.q && isUuid(filter.q)) {
      /*
       * A pasted client ID. The admin UI now shows the uuid everywhere a client
       * appears, so the search box has to answer it — and an exact primary-key
       * match is the only honest reading of a full uuid: it is not a name
       * fragment, and pushing 36 hex characters through the trgm ILIKE below
       * would only ever match an email that happens to contain them.
       *
       * Deliberately NOT OR-ed into the ILIKE predicate — its comment explains
       * that the concatenation must stay character-for-character identical to
       * the expression index in migration 0010.
       */
      conditions.push(eq(users.id, filter.q.trim()));
    } else if (filter.q) {
      /*
       * ONE predicate over the three searchable columns concatenated, matching
       * the expression index in migration 0010 exactly.
       *
       * This was `ilike(email) OR ilike(first_name) OR ilike(last_name)`. A
       * LEADING wildcard cannot use a b-tree, so the unique index on email did
       * nothing for it and every keystroke was a sequential scan over the whole
       * table — precisely the "unindexed filters" ARCHITECTURE §5 warns about at
       * ~219,000 rows.
       *
       * pg_trgm's GIN index makes an infix ILIKE indexable, but ONLY when the
       * query's expression is character-for-character what the index was built
       * on. That is why this is written as one concatenation rather than three
       * ORs, and why the coalesce and the separator are not cosmetic: change
       * either here and the index silently stops being used, with nothing
       * failing and only the query plan to tell you.
       *
       * The space separator also stops a match spanning a column boundary — a
       * search for "n j" should not match first_name "John" against a
       * neighbouring column's leading character.
       */
      // `%` and `_` are wildcards inside the pattern; a search for "%" matched
      // every client and a long run of them was an expensive scan. Escaped with
      // the backslash Postgres already treats as LIKE's default escape.
      conditions.push(
        sql`(coalesce(${users.email}, '') || ' ' || coalesce(${users.firstName}, '') || ' ' || coalesce(${users.lastName}, '')) ILIKE ${`%${escapeLike(filter.q)}%`}`,
      );
    }
    /*
     * The keyset seek — R-2.4.
     *
     * `(sort_col, id) < (cursor.value, cursor.id)` as a ROW comparison, not
     * `col < x OR (col = x AND id < y)`. The row form is what Postgres can
     * satisfy with a single index scan, and it is also the form that is
     * obviously correct: it says "everything ordered after this row", which is
     * exactly the question.
     *
     * The `id` tiebreak is load-bearing. Two clients registered in the same
     * millisecond — or sharing a status, a country or a first name, which is
     * far more common — would otherwise sit either side of a page boundary in
     * an order Postgres may change between queries, reintroducing the skipped
     * row this replaces.
     *
     * The COMPARATOR FOLLOWS THE SORT DIRECTION. Under `ORDER BY ... ASC`,
     * "after this row" is `>`, and leaving it as `<` would page backwards
     * through a forwards list: the first Next click would return rows the
     * caller had already seen, silently.
     *
     * The cursor's value is cast to the sort column's own type rather than
     * always to `timestamptz`. `::timestamptz` on an email address is a runtime
     * error at the database, from a value that looked fine in the URL.
     */
    if (filter.cursor) {
      const comparator = direction === 'asc' ? sql`>` : sql`<`;
      const cast =
        sortKey === 'createdAt'
          ? sql`${filter.cursor.value}::timestamptz`
          : sortKey === 'verificationLevel'
            ? sql`${filter.cursor.value}::integer`
            : sql`${filter.cursor.value}::text`;
      // The enum columns compare as text; `status`/`type` cast cleanly because
      // Postgres knows the enum's text representation.
      const seekColumn =
        sortKey === 'createdAt' || sortKey === 'verificationLevel'
          ? sql`${sortColumn}`
          : sql`${sortColumn}::text`;

      conditions.push(
        sql`(${seekColumn}, ${users.id}) ${comparator} (${cast}, ${filter.cursor.id}::uuid)`,
      );
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    /*
     * `emailVerified` and `kycStatus` are on the row because the directory
     * could not otherwise answer the question it exists to answer.
     *
     * `users.status` is 'active' | 'pending' | 'suspended', and "pending" says
     * almost nothing on its own: it does not distinguish somebody who has not
     * confirmed their email from somebody whose documents are sitting in the
     * review queue. Those are different problems with different owners, and the
     * list had no way to tell them apart — so the one column was carrying three
     * unrelated meanings and answering none of them.
     *
     * The KYC state is a LEFT JOIN, and it has to be left: a client who never
     * started verification has no `kyc_submissions` row at all, and an inner
     * join would drop exactly the clients most worth chasing. `coalesce` turns
     * that absence into the enum's own 'not_started', so the column is TOTAL —
     * every client carries one of the six values and never a null.
     */
    const columns = {
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      type: DERIVED_CLIENT_TYPE,
      status: users.status,
      emailVerified: users.emailVerified,
      verificationLevel: users.verificationLevel,
      kycStatus: sql<string>`coalesce(${kycSubmissions.status}::text, 'not_started')`,
      country: users.country,
      /*
       * PHONE rides the list projection so the CSV can carry it. It is a
       * maskable field in `client-fields.json`, and `applyMaskAll` runs over
       * these rows on both the screen and the export — so a role that hides
       * it hides it in both places, which is the only way adding a column
       * here is safe.
       */
      phone: users.phone,
      createdAt: users.createdAt,
    };

    // OFFSET is kept for one release so both frontends can move at their own
    // pace (R-8.2, additive-for-a-cycle). It is the path to delete, not to
    // extend: a `page` deep into 219,000 rows makes Postgres walk and discard
    // everything before it.
    const usingCursor = Boolean(filter.cursor) || filter.page <= 1;

    /*
     * Both keys in the SAME direction, matching the seek and matching migration
     * 0024's `(col DESC, id DESC)` indexes.
     *
     * A b-tree can be read backwards only when every column of the ORDER BY
     * agrees, so `(col DESC, id DESC)` serves DESC forwards and ASC backwards
     * with no sort node either way. A mixed `col DESC, id ASC` would serve
     * neither and would silently reintroduce a sort over 219,000 rows.
     */
    const orderBy = direction === 'asc' ? asc : desc;

    const rows = await db
      .select(columns)
      .from(users)
      /*
       * LEFT, not inner — `kyc_submissions` is keyed on `user_id` and only
       * exists once a client begins verification. An inner join would silently
       * drop every client who has not started, which is both the largest group
       * and the one an operator most wants to see.
       */
      .leftJoin(kycSubmissions, eq(kycSubmissions.userId, users.id))
      .where(where)
      .orderBy(orderBy(sortColumn), orderBy(users.id))
      // One extra row answers "is there a next page" with no second query and
      // no count.
      .limit(filter.limit + 1)
      .offset(usingCursor ? 0 : (filter.page - 1) * filter.limit);

    // Counted only on request: it is a full scan of the filtered set, run purely
    // to render "of 219,000", while `nextCursor !== null` answers "is there
    // more" for free.
    let total: number | undefined;
    if (filter.withTotal) {
      /*
       * The SAME join as the page query, and it is not optional.
       *
       * `where` may now contain a predicate on `kyc_submissions`, and a count
       * that omitted the join would fail outright rather than merely disagree.
       * It stays a LEFT join for the same reason as above, so the count matches
       * the rows exactly — a total that counted a different set than the one it
       * paginates is the bug this kind of duplication usually causes.
       *
       * The join costs nothing here: `kyc_submissions.user_id` is the primary
       * key, so it is a unique index lookup and cannot multiply rows.
       */
      const [countRow] = await db
        .select({ value: sql<number>`count(*)::int` })
        .from(users)
        .leftJoin(kycSubmissions, eq(kycSubmissions.userId, users.id))
        .where(where);
      total = countRow.value;
    }

    return { rows, total };
  }

  async count(): Promise<number> {
    const [{ value }] = await this.db.select({ value: count() }).from(users);
    return value;
  }
}
