import { and, asc, eq, ilike, inArray, or, sql, SQL, type SQLWrapper } from 'drizzle-orm';
import { escapeLike } from './users.store';
import { Inject, Injectable } from '@nestjs/common';
import { orderTerms, type SortOrder } from '../common/sorting';
import { DRIZZLE_DB } from '../database/database.module';
import { StoredObjectsStore } from './stored-objects.store';
import type { Db, Executor } from '../database/db';
import { kycSubmissionAttempts, kycSubmissions, users } from '../database/schema';
import {
  clientScopePredicate,
  UNRESTRICTED,
  type ClientScope,
} from '../common/security/client-scope';

export type KycStatus =
  'not_started' | 'in_progress' | 'submitted' | 'under_review' | 'approved' | 'rejected';

/**
 * The columns the KYC review queue may be ordered by — R-2.5.
 *
 * ## `submittedAt` stays the BARE nullable column, deliberately
 *
 * A submission row exists from the moment a client starts one and is stamped
 * only when they finish, so `submitted_at` is null for every in-progress
 * applicant. The client index coalesces its nullable sort column to `''`
 * because a keyset SEEK over null is UNKNOWN and silently drops those rows —
 * but this queue pages by OFFSET, not by a row comparison, so that failure mode
 * does not arise here and a coalesce would only change which end the
 * unsubmitted rows sort to.
 *
 * That matters because this is the DEFAULT ordering and it is not being
 * changed: `ORDER BY submitted_at DESC` puts nulls first under Postgres'
 * default (`DESC` implies `NULLS FIRST`), and the ORDER BY below pins
 * `NULLS LAST`/`NULLS FIRST` explicitly per direction so the two directions are
 * mirrors of each other rather than one of them being arbitrary.
 *
 * The applicant columns come from the `users` INNER JOIN the queue already does
 * for its name and email display, so sorting by them costs no extra join.
 */
export const KYC_SORT_COLUMNS = {
  submittedAt: kycSubmissions.submittedAt,
  status: kycSubmissions.status,
  createdAt: kycSubmissions.createdAt,
  userEmail: users.email,
  userFirstName: users.firstName,
} as const;

export type KycSortKey = keyof typeof KYC_SORT_COLUMNS;

/** Most recently submitted first — what the queue showed before it was sortable. */
export const DEFAULT_KYC_SORT: KycSortKey = 'submittedAt';

/**
 * The QUEUE, as a filter value: everything a reviewer still has to act on.
 *
 * Not a column value — `kyc_status` has no such member. It exists because the
 * dashboard tile and the sidebar badge count `submitted + under_review` and
 * used to link to `submitted` alone, so the number and the list disagreed by
 * exactly the submissions somebody had already picked up.
 */
export const NEEDS_REVIEW = 'needs_review';
export const NEEDS_REVIEW_STATUSES = [
  'submitted',
  'under_review',
] as const satisfies readonly KycStatus[];

export interface PersonalInfo {
  firstName: string;
  lastName: string;
  dateOfBirth?: string;
  nationality?: string;
  country?: string;
  phone?: string;
  address?: string;
}

export interface DocumentInfo {
  docType: 'passport' | 'national_id' | 'driving_license';
  frontFilePath?: string;
  backFilePath?: string;
  frontFileName?: string;
  backFileName?: string;
}

export interface SelfieInfo {
  filePath?: string;
  fileName?: string;
}

export interface AddressInfo {
  docType: string;
  filePath?: string;
  fileName?: string;
  page2FilePath?: string;
  page2FileName?: string;
}

/**
 * A decided attempt, as it stood when the decision was made.
 *
 * Deliberately NOT `KycSubmission & { attemptNo }`: this is a historical record,
 * so it carries no `updatedAt` (nothing updates it) and no `userId` on the shape
 * the caller sees (it is always read for one client at a time).
 */
export interface KycAttempt {
  attemptNo: number;
  status: KycStatus;
  personalInfo?: PersonalInfo;
  document?: DocumentInfo;
  selfie?: SelfieInfo;
  addressProof?: AddressInfo;
  rejectionReason?: string;
  rejectedFields?: string[];
  submittedAt?: Date;
  reviewedAt?: Date;
  reviewedBy?: string;
  archivedAt: Date;
}

export interface KycSubmission {
  userId: string;
  status: KycStatus;
  rejectionReason?: string;
  rejectedFields?: string[];
  reviewedBy?: string;
  reviewedAt?: Date;
  submittedAt?: Date;
  personalInfo?: PersonalInfo;
  document?: DocumentInfo;
  selfie?: SelfieInfo;
  addressProof?: AddressInfo;
  createdAt: Date;
  updatedAt: Date;
}

type Row = typeof kycSubmissions.$inferSelect;

const toSubmission = (r: Row): KycSubmission => ({
  userId: r.userId,
  status: r.status,
  rejectionReason: r.rejectionReason ?? undefined,
  rejectedFields: r.rejectedFields ?? undefined,
  reviewedBy: r.reviewedBy ?? undefined,
  reviewedAt: r.reviewedAt ?? undefined,
  submittedAt: r.submittedAt ?? undefined,
  personalInfo: (r.personalInfo as unknown as PersonalInfo) ?? undefined,
  document: (r.document as unknown as DocumentInfo) ?? undefined,
  selfie: (r.selfie as unknown as SelfieInfo) ?? undefined,
  addressProof: (r.addressProof as unknown as AddressInfo) ?? undefined,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});

// Explicit nulls clear columns (e.g. resubmission clears rejection data);
// absent keys leave them untouched.
const toColumns = (
  patch: Partial<Omit<KycSubmission, 'reviewedBy'>> & { reviewedBy?: string | null },
) => {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  const map: Array<[keyof KycSubmission, string]> = [
    ['status', 'status'],
    ['rejectionReason', 'rejectionReason'],
    ['rejectedFields', 'rejectedFields'],
    ['reviewedBy', 'reviewedBy'],
    ['reviewedAt', 'reviewedAt'],
    ['submittedAt', 'submittedAt'],
    ['personalInfo', 'personalInfo'],
    ['document', 'document'],
    ['selfie', 'selfie'],
    ['addressProof', 'addressProof'],
  ];
  /*
   * `key in patch`, not a truthiness test: a key present with `null` MEANS
   * "clear this column", and a key that is absent means "leave it alone".
   * Collapsing the two would make `release` unable to detach a reviewer.
   */
  for (const [key, col] of map) {
    if (key in patch) set[col] = patch[key] ?? null;
  }
  return set;
};

@Injectable()
export class KycStore {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Db,
    private readonly storedObjects: StoredObjectsStore,
  ) {}

  async getOrCreate(userId: string): Promise<KycSubmission> {
    const existing = await this.findByUserId(userId);
    if (existing) return existing;
    const [row] = await this.db
      .insert(kycSubmissions)
      .values({ userId, status: 'not_started' })
      .onConflictDoNothing({ target: kycSubmissions.userId })
      .returning();
    // Conflict means a concurrent create won — read it back.
    return row ? toSubmission(row) : (await this.findByUserId(userId))!;
  }

  async findByUserId(userId: string): Promise<KycSubmission | undefined> {
    const [row] = await this.db
      .select()
      .from(kycSubmissions)
      .where(eq(kycSubmissions.userId, userId))
      .limit(1);
    return row ? toSubmission(row) : undefined;
  }

  async update(
    userId: string,
    patch: Partial<KycSubmission>,
    executor?: Executor,
  ): Promise<KycSubmission> {
    await this.getOrCreate(userId);
    const [row] = await (executor ?? this.db)
      .update(kycSubmissions)
      .set(toColumns(patch))
      .where(eq(kycSubmissions.userId, userId))
      .returning();
    return toSubmission(row);
  }

  /**
   * Move a submission from one of `from` to a new state, or refuse.
   *
   * The expected status goes into the `WHERE`, so the check and the write are
   * ONE statement and the database decides. `undefined` means the row was not in
   * an acceptable state — either it never was, or another request changed it
   * between this caller reading it and writing.
   *
   * ## Why this exists
   *
   * `approve`, `claim` and `reject` were all read-then-write:
   *
   *     const s = await findByUserId(userId);       // SELECT
   *     if (s.status !== 'submitted') throw …       // check
   *     await update(userId, { status: 'approved' })// UPDATE, unconditional
   *
   * `update()` matches on `user_id` alone and checks no rowcount, so two admins
   * hitting approve and reject in the same tick both passed their check against
   * the same `submitted` row and both wrote. Last writer won, and which one that
   * was depended on scheduling. Because the status and the verification level
   * are separate statements, the interleaving could land as
   * `status: 'rejected'` + `verification_level: 1` — a client refused on paper
   * and able to withdraw in fact, which is the exact state the reject-reversal
   * fix exists to prevent, reached by another route.
   *
   * This is the same shape ARCHITECTURE §6 rule 3 mandates on the money path
   * ("`UPDATE … WHERE state='approved'` with a rowcount check"). KYC is not
   * `ledger_entries`, but it is what GATES `ledger_entries`.
   */
  /**
   * @param patch `reviewedBy: null` CLEARS the reviewer; omitting the key
   *   leaves it alone. The distinction matters — `release` has to put a
   *   submission back in the pool with nobody's name on it, and a patch that
   *   could only ever SET an id would leave the previous holder attached to a
   *   row that is once again unclaimed.
   */
  async transition(
    userId: string,
    from: readonly KycStatus[],
    patch: Partial<Omit<KycSubmission, 'reviewedBy'>> & { reviewedBy?: string | null },
    executor?: Executor,
  ): Promise<KycSubmission | undefined> {
    const [row] = await (executor ?? this.db)
      .update(kycSubmissions)
      .set(toColumns(patch))
      .where(and(eq(kycSubmissions.userId, userId), inArray(kycSubmissions.status, [...from])))
      .returning();
    return row ? toSubmission(row) : undefined;
  }

  async findAll(): Promise<KycSubmission[]> {
    const rows = await this.db.select().from(kycSubmissions);
    return rows.map(toSubmission);
  }

  /**
   * Admin queue: submissions joined to their user, filtered and paginated in
   * SQL, with per-status counts computed by the database in one grouped query.
   */
  async findPageWithUsers(filter: {
    status?: KycStatus;
    /** Any-of. Takes precedence over `status` — see the WHERE below. */
    statuses?: KycStatus[];
    q?: string;
    page: number;
    limit: number;
    /** Row-level visibility. Defaults to unrestricted; admin callers pass the actor's. */
    scope?: ClientScope;
    /** R-2.5 server-side sort. Validated by `sortKey` before it gets here. */
    sort?: KycSortKey;
    order?: SortOrder;
  }) {
    const db = this.db;
    const conditions: SQL[] = [];

    const sortKey: KycSortKey = filter.sort ?? DEFAULT_KYC_SORT;
    const direction = filter.order ?? 'desc';
    const sortColumn: SQLWrapper = KYC_SORT_COLUMNS[sortKey];

    /*
     * One status, or the SET that means "a reviewer has to look at this".
     *
     * The dashboard tile and the sidebar badge both count `submitted +
     * under_review` — deliberately, because both mean unfinished work, and the
     * tile's own comment says counting only `submitted` understates the queue.
     * The link they carried resolved to `submitted` alone, so clicking a badge
     * reading 17 opened a list of 12 and the five a reviewer had already
     * picked up fell off the daily sweep. `needs_review` is that set, so the
     * number and the destination finally mean the same thing.
     */
    if (filter.statuses?.length) {
      conditions.push(inArray(kycSubmissions.status, filter.statuses));
    } else if (filter.status) {
      conditions.push(eq(kycSubmissions.status, filter.status));
    }

    /*
     * ⚠️ EVERYTHING EXCEPT THE STATUS, kept separately — the tab counts need
     * these and must not be narrowed to one status.
     *
     * The counts query used to carry NO predicate at all, on the reasoning
     * below that they should span every status. They did, and they also spanned
     * every CLIENT: a reviewer scoped to two tags, with no intake grant, saw a
     * sidebar badge of 15 and tabs reading 12 / 3 / 89 / 111 above a queue with
     * nothing in it. Reported from the running console.
     *
     * Two things wrong with that, in rising order. The badge is a promise about
     * the reader's own work and it was counting somebody else's — a number you
     * cannot act on, on the one control that exists to say "there is something
     * to do". And it disclosed platform-wide volumes to an admin whose whole
     * configuration says they may not see them; RBAC-08 territory is meant to
     * bound what a reviewer learns, not just what they can open.
     */
    const visibility: SQL[] = [];
    // In the WHERE clause, so an out-of-scope submission never enters the
    // result set — and therefore cannot be missed by a later projection, count
    // or export that forgot to filter. See common/security/client-scope.ts.
    const scoped = clientScopePredicate(filter.scope ?? UNRESTRICTED, kycSubmissions.userId);
    if (scoped) visibility.push(scoped);
    if (filter.q) {
      const term = `%${escapeLike(filter.q)}%`;
      visibility.push(
        or(ilike(users.email, term), ilike(users.firstName, term), ilike(users.lastName, term))!,
      );
    }
    conditions.push(...visibility);
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    /** Scope and search, without the status narrowing — for the tab counts. */
    const countsWhere = visibility.length > 0 ? and(...visibility) : undefined;

    const [rows, [countRow], statusCounts] = await Promise.all([
      /*
       * Only the columns the QUEUE renders — R-2.5 data minimisation.
       *
       * This used to select `kycSubmissions` whole, so every page of 25 rows
       * carried each client's date of birth, address, nationality, phone and
       * document paths to a screen that renders a name, an email, a status, a
       * country and two dates. Not a hole — the caller already holds
       * `kyc.review` — but it is the difference between a compromised or
       * over-broad admin session leaking a page of names and leaking a page of
       * full identity profiles, and it is the first question a compliance
       * reviewer asks about a list endpoint.
       *
       * `country` is extracted from the jsonb rather than the blob being sent,
       * because it is the one field of `personalInfo` the queue displays. The
       * detail endpoint still returns everything; that is where a reviewer is
       * meant to read it, and where reading it is an audited act.
       */
      db
        .select({
          userId: kycSubmissions.userId,
          status: kycSubmissions.status,
          submittedAt: kycSubmissions.submittedAt,
          reviewedAt: kycSubmissions.reviewedAt,
          /*
           * WHO holds it. An ADMIN id, not client data — so it costs the
           * minimisation above nothing, and without it a claim communicates
           * only "somebody has this", which is the half that helps nobody:
           * the Claim button disappears for every colleague and there is no
           * name to ask. The service resolves it to a name.
           */
          reviewedBy: kycSubmissions.reviewedBy,
          createdAt: kycSubmissions.createdAt,
          updatedAt: kycSubmissions.updatedAt,
          country: sql<string | null>`${kycSubmissions.personalInfo}->>'country'`,
          user: {
            id: users.id,
            email: users.email,
            firstName: users.firstName,
            lastName: users.lastName,
          },
        })
        .from(kycSubmissions)
        .innerJoin(users, eq(kycSubmissions.userId, users.id))
        .where(where)
        /*
         * The sort key, then `user_id` as a TOTAL-ORDER tiebreak.
         *
         * `user_id` rather than `id`: this table has no `id` column — one
         * submission per client, so the client IS the key. The tiebreak is not
         * decoration. Every sortable column here has ties by construction (a
         * status has six values; two clients submit in the same second during a
         * campaign), and rows sharing a sort value sit either side of an OFFSET
         * boundary in an order Postgres is free to change between queries. That
         * is a reviewer paging through the queue and never being shown a
         * submission, with nothing to indicate it.
         *
         * Both keys in the SAME direction, matching migration 0035's
         * `(col DESC, user_id DESC)` composites — a b-tree is readable backwards
         * only when every column of the ORDER BY agrees.
         */
        .orderBy(
          ...orderTerms(sortColumn, kycSubmissions.userId, direction, {
            // Only `submittedAt` is nullable here — null for every application
            // still being filled in, which must not lead the queue.
            nullsLast: sortKey === 'submittedAt',
          }),
        )
        .limit(filter.limit)
        .offset((filter.page - 1) * filter.limit),
      db
        .select({ value: sql<number>`count(*)::int` })
        .from(kycSubmissions)
        .innerJoin(users, eq(kycSubmissions.userId, users.id))
        .where(where),
      /*
       * Every STATUS this reader may see — so a tab count stays right while a
       * status filter is applied, without ever reaching past their territory.
       *
       * The join matches the total query above: `q` filters on `users`, and an
       * inner join cannot change the count because `user_id` is NOT NULL with
       * a foreign key.
       */
      db
        .select({
          status: kycSubmissions.status,
          value: sql<number>`count(*)::int`,
        })
        .from(kycSubmissions)
        .innerJoin(users, eq(kycSubmissions.userId, users.id))
        .where(countsWhere)
        .groupBy(kycSubmissions.status),
    ]);

    const counts: Record<string, number> = { all: 0 };
    for (const row of statusCounts) {
      counts[row.status] = row.value;
      counts['all'] += row.value;
    }
    /*
     * The pseudo-status, counted HERE so it has one definition.
     *
     * `needs_review` is a filter value the API already accepts and resolves to
     * submitted + under_review, but it was never a KEY in this object — those
     * come from a GROUP BY over a column, and no row's status is ever
     * `needs_review`. So the console's "Needs review" tab read
     * `counts['needs_review'] ?? 0` and displayed **0 for ever**, on the one
     * tab that means "work waiting for a human", above a list that was not
     * empty.
     *
     * The sidebar badge got the same number right by summing the two itself —
     * which is the deeper problem: the definition of "needs review" lived in
     * the backend filter, in the badge, and nowhere the tab could reach.
     * Computed once, from `NEEDS_REVIEW_STATUSES`, so all three agree by
     * construction rather than by three authors remembering the same pair.
     */
    counts[NEEDS_REVIEW] = NEEDS_REVIEW_STATUSES.reduce(
      (sum, status) => sum + (counts[status] ?? 0),
      0,
    );

    return {
      items: rows.map((r) => ({
        userId: r.userId,
        status: r.status,
        submittedAt: r.submittedAt ?? undefined,
        reviewedAt: r.reviewedAt ?? undefined,
        reviewedBy: r.reviewedBy ?? undefined,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        // The queue's country column, and nothing else from the profile.
        personalInfo: r.country ? { country: r.country } : undefined,
        user: r.user,
      })),
      total: countRow.value,
      page: filter.page,
      limit: filter.limit,
      counts,
    };
  }

  async findByStatus(status: KycStatus): Promise<KycSubmission[]> {
    const rows = await this.db
      .select()
      .from(kycSubmissions)
      .where(eq(kycSubmissions.status, status));
    return rows.map(toSubmission);
  }

  /**
   * Snapshot a decided attempt, so the next one cannot overwrite it.
   *
   * Called at the moment a decision lands, because that is the last instant the
   * evidence is intact: the next `submit()` clears the rejection data and the
   * next `attachFile()` overwrites the document paths.
   *
   * The attempt number is computed inside the INSERT rather than read first and
   * written second — a read-then-write would let two concurrent decisions pick
   * the same number, and the unique index would then reject one of them at
   * random. `ON CONFLICT DO NOTHING` covers the remaining race: archiving the
   * same attempt twice is a no-op, not an error, because losing a decision to a
   * duplicate-key failure would be far worse than a missing duplicate.
   */
  async archiveAttempt(submission: KycSubmission, executor?: Executor): Promise<void> {
    await (executor ?? this.db)
      .insert(kycSubmissionAttempts)
      .values({
        userId: submission.userId,
        attemptNo: sql<number>`(
          SELECT COALESCE(MAX(${kycSubmissionAttempts.attemptNo}), 0) + 1
          FROM ${kycSubmissionAttempts}
          WHERE ${kycSubmissionAttempts.userId} = ${submission.userId}
        )`,
        status: submission.status,
        personalInfo: submission.personalInfo as unknown as Record<string, string>,
        document: submission.document as unknown as Record<string, string>,
        selfie: submission.selfie as unknown as Record<string, string>,
        addressProof: submission.addressProof as unknown as Record<string, string>,
        rejectionReason: submission.rejectionReason ?? null,
        rejectedFields: submission.rejectedFields ?? null,
        submittedAt: submission.submittedAt ?? null,
        reviewedAt: submission.reviewedAt ?? null,
        reviewedBy: submission.reviewedBy ?? null,
      })
      .onConflictDoNothing();
  }

  /** This client's decided attempts, oldest first. */
  async listAttempts(userId: string): Promise<KycAttempt[]> {
    const rows = await this.db
      .select()
      .from(kycSubmissionAttempts)
      .where(eq(kycSubmissionAttempts.userId, userId))
      .orderBy(asc(kycSubmissionAttempts.attemptNo));
    return rows.map((r) => ({
      attemptNo: r.attemptNo,
      status: r.status,
      personalInfo: (r.personalInfo as unknown as PersonalInfo) ?? undefined,
      document: (r.document as unknown as DocumentInfo) ?? undefined,
      selfie: (r.selfie as unknown as SelfieInfo) ?? undefined,
      addressProof: (r.addressProof as unknown as AddressInfo) ?? undefined,
      rejectionReason: r.rejectionReason ?? undefined,
      rejectedFields: r.rejectedFields ?? undefined,
      submittedAt: r.submittedAt ?? undefined,
      reviewedAt: r.reviewedAt ?? undefined,
      reviewedBy: r.reviewedBy ?? undefined,
      archivedAt: r.archivedAt,
    }));
  }

  /**
   * The client a KYC document belongs to, live submission or archived attempt.
   *
   * Exists so the uploads controller can apply the CLIENT SCOPE to an admin's
   * document read. That route takes a filename, not a client id, so there was
   * nothing to scope against: a scoped administrator who held a filename from a
   * screenshot, a stale tab or a shared ticket could fetch the passport of a
   * client they are not allowed to see, and the read would even be audited as
   * legitimate.
   *
   * Matched with a jsonb containment test rather than by loading submissions and
   * comparing in JavaScript — the filename is caller-supplied and the answer
   * decides whether PII is served, so the comparison belongs in the query where
   * a later code path cannot skip it.
   *
   * Both tables are searched, and the second is not optional: an archived
   * attempt keeps the documents it was decided on, so a rejected-and-replaced
   * passport is still that client's. Checking only the live row would make an
   * out-of-scope admin's read of a superseded document fall through to
   * "unowned" and be allowed.
   */
  async ownerOfDocument(fileName: string): Promise<string | undefined> {
    /*
     * The registry first — an indexed lookup on `stored_objects.storage_key`.
     *
     * The scan below is what this replaces: three JSONB columns cast to text and
     * matched with a leading-wildcard ILIKE, twice, on a route that serves identity
     * documents. It is correct and it does not scale, and it was the only reverse
     * lookup the system had.
     *
     * It is KEPT as the fallback rather than deleted, because there is no backfill
     * migration: documents uploaded before `stored_objects` existed have no row, and
     * the client-scope check that calls this must keep working for them. A miss here
     * means "not in the registry", not "not ours".
     */
    const registered = await this.storedObjects.ownerOfFilename(fileName);
    if (registered) return registered;

    const needle = `%${fileName}%`;

    const [live] = await this.db
      .select({ userId: kycSubmissions.userId })
      .from(kycSubmissions)
      .where(
        or(
          sql`${kycSubmissions.document}::text ILIKE ${needle}`,
          sql`${kycSubmissions.selfie}::text ILIKE ${needle}`,
          sql`${kycSubmissions.addressProof}::text ILIKE ${needle}`,
        ),
      )
      .limit(1);
    if (live) return live.userId;

    const [archived] = await this.db
      .select({ userId: kycSubmissionAttempts.userId })
      .from(kycSubmissionAttempts)
      .where(
        or(
          sql`${kycSubmissionAttempts.document}::text ILIKE ${needle}`,
          sql`${kycSubmissionAttempts.selfie}::text ILIKE ${needle}`,
          sql`${kycSubmissionAttempts.addressProof}::text ILIKE ${needle}`,
        ),
      )
      .limit(1);
    return archived?.userId;
  }

  /**
   * Every document path this client has ever had archived.
   *
   * Two callers need it and both would otherwise be wrong: `resetKyc` must not
   * delete a file that an archived attempt still points at (it is evidence now,
   * not an orphan), and the uploads controller must let a client fetch a
   * document from their own history rather than 403 them on their own passport.
   */
  async archivedDocumentPaths(userId: string): Promise<string[]> {
    const attempts = await this.listAttempts(userId);
    return attempts.flatMap((a) =>
      [
        a.document?.frontFilePath,
        a.document?.backFilePath,
        a.selfie?.filePath,
        a.addressProof?.filePath,
        a.addressProof?.page2FilePath,
      ].filter((p): p is string => typeof p === 'string' && p.length > 0),
    );
  }

  // REMOVED: `clearAll()` — an unguarded `DELETE FROM kyc_submissions` with no
  // caller once `KycService.resetAllKyc()` was deleted. See the note there.

  async resetUser(userId: string): Promise<void> {
    await this.db.delete(kycSubmissions).where(eq(kycSubmissions.userId, userId));
  }
}
