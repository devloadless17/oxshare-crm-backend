import {
  and,
  asc,
  eq,
  getTableColumns,
  inArray,
  isNull,
  ne,
  or,
  sql,
  SQL,
  type SQLWrapper,
} from 'drizzle-orm';
import type { FormPolicy } from '../common/kyc/identity-core';
import { clientIdentitySearch } from './users.store';
import { Inject, Injectable } from '@nestjs/common';
import { orderTerms, type SortOrder } from '../common/sorting';
import { DRIZZLE_DB } from '../database/database.module';
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

/**
 * The personal step's answers.
 *
 * STORED (`kyc_submissions.personal_info`), it holds ONLY answers to fields a
 * broker invented: the client's identity — name, date of birth, nationality,
 * phone, residence and address — lives on the profile (`users`, 0139), and
 * nothing may write it here. READ through `KycService`, the profile's values
 * are merged in for the fields the step asks for, so a screen sees one record.
 */
export type PersonalInfo = Record<string, string>;

export interface DocumentInfo {
  /**
   * A catalogue value (`common/kyc/document-catalogue.ts`), so any identity
   * document the catalogue offers — it was typed as three of them while the
   * catalogue held four. Optional because a page can arrive before the client
   * has said which document it belongs to (a portal predating typed uploads).
   */
  docType?: string;
  frontFilePath?: string;
  backFilePath?: string;
}

export interface SelfieInfo {
  filePath?: string;
}

export interface AddressInfo {
  docType?: string;
  filePath?: string;
  page2FilePath?: string;
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
  /**
   * Answers for steps outside the four canonical ones, keyed by slug.
   *
   * Always an object — the column is `NOT NULL DEFAULT '{}'` (migration 0130) —
   * so consumers never branch on null, only on whether a slug is present.
   */
  stepData: Record<string, Record<string, string | { filePath: string }>>;
  rejectionReason?: string;
  /** The reason in Arabic as written with the decision (0179). */
  rejectionReasonAr?: string;
  rejectedFields?: string[];
  submittedAt?: Date;
  reviewedAt?: Date;
  reviewedBy?: string;
  archivedAt: Date;
}

export interface KycSubmission {
  userId: number;
  status: KycStatus;
  rejectionReason?: string;
  /**
   * The reason as an Arabic reader is shown it, written with the decision (0179):
   * the reviewer's own Arabic, or the configured reason's Arabic as it read then.
   */
  rejectionReasonAr?: string;
  rejectedFields?: string[];
  reviewedBy?: string;
  reviewedAt?: Date;
  submittedAt?: Date;
  personalInfo?: PersonalInfo;
  document?: DocumentInfo;
  selfie?: SelfieInfo;
  addressProof?: AddressInfo;
  /**
   * Answers for steps outside the four canonical ones, keyed by slug.
   *
   * Always an object — the column is `NOT NULL DEFAULT '{}'` (migration 0130) —
   * so consumers never branch on null, only on whether a slug is present.
   */
  stepData: Record<string, Record<string, string | { filePath: string }>>;
  /**
   * When a reviewer returned an APPROVED verification for the client to redo
   * (0147). Cleared by the approval that follows.
   */
  reverificationRequestedAt?: Date;
  /**
   * What the broker's own steps asked when the client submitted (0147) — the
   * review labels their answers from it. Internal: never part of a client's
   * view of their own submission.
   */
  formSnapshot?: KycFormSnapshot;
  /** The requirements in force when the client submitted (0158) — what approval re-checks. */
  formPolicy?: FormPolicy;
  createdAt: Date;
  updatedAt: Date;
}

/** The broker's own questions as a client answered them — see `KycSubmission.formSnapshot`. */
export type KycFormSnapshot = {
  slug: string;
  title: string;
  /** The Arabic as asked (0179). Absent on snapshots taken before, and when untranslated. */
  titleAr?: string;
  fields: {
    name: string;
    label: string;
    type: string;
    labelAr?: string;
    optionsAr?: Record<string, string>;
  }[];
}[];

/** A row with its three documents rebuilt from the record (`identity_evidence`). */
type Evidence = {
  document: Record<string, string> | null;
  selfie: Record<string, string> | null;
  addressProof: Record<string, string> | null;
};
type Row = typeof kycSubmissions.$inferSelect & Evidence;

/**
 * A submission as READ: the platform's three documents come from the client's
 * identity RECORD — the version each pointer names, rebuilt in the KYC shape by
 * `identity_evidence` (0152). There are no document columns to read any more
 * (0171): the record is the only copy, written by `recordEvidence` below.
 *
 * The same shape every reader always had, each path in its one spelling
 * (`uploads/kyc/<name>`). A broker's own uploads stay in `stepData`, the
 * answers, and are versioned on the record from there.
 */
const submissionRead = {
  ...getTableColumns(kycSubmissions),
  document: sql<
    Evidence['document']
  >`identity_evidence(${kycSubmissions.identityDocumentId}, 'identity')`,
  selfie: sql<Evidence['selfie']>`identity_evidence(${kycSubmissions.selfieDocumentId}, 'selfie')`,
  addressProof: sql<
    Evidence['addressProof']
  >`identity_evidence(${kycSubmissions.addressDocumentId}, 'address')`,
};

/** An archived attempt as READ — its evidence from the record, as `submissionRead`. */
const attemptRead = {
  ...getTableColumns(kycSubmissionAttempts),
  document: sql<
    Evidence['document']
  >`identity_evidence(${kycSubmissionAttempts.identityDocumentId}, 'identity')`,
  selfie: sql<
    Evidence['selfie']
  >`identity_evidence(${kycSubmissionAttempts.selfieDocumentId}, 'selfie')`,
  addressProof: sql<
    Evidence['addressProof']
  >`identity_evidence(${kycSubmissionAttempts.addressDocumentId}, 'address')`,
};

/** The patch keys that change what the record holds for the live submission. */
const EVIDENCE_KEYS = ['document', 'selfie', 'addressProof', 'stepData', 'status'] as const;

const toSubmission = (r: Row): KycSubmission => ({
  userId: r.userId,
  status: r.status,
  rejectionReason: r.rejectionReason ?? undefined,
  rejectionReasonAr: r.rejectionReasonAr ?? undefined,
  rejectedFields: r.rejectedFields ?? undefined,
  reviewedBy: r.reviewedBy ?? undefined,
  reviewedAt: r.reviewedAt ?? undefined,
  submittedAt: r.submittedAt ?? undefined,
  personalInfo: (r.personalInfo as unknown as PersonalInfo) ?? undefined,
  document: (r.document as unknown as DocumentInfo) ?? undefined,
  selfie: (r.selfie as unknown as SelfieInfo) ?? undefined,
  addressProof: (r.addressProof as unknown as AddressInfo) ?? undefined,
  stepData: r.stepData ?? {},
  reverificationRequestedAt: r.reverificationRequestedAt ?? undefined,
  formSnapshot: r.formSnapshot ?? undefined,
  formPolicy: r.formPolicy ?? undefined,
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
    ['rejectionReasonAr', 'rejectionReasonAr'],
    ['rejectedFields', 'rejectedFields'],
    ['reviewedBy', 'reviewedBy'],
    ['reviewedAt', 'reviewedAt'],
    ['submittedAt', 'submittedAt'],
    ['personalInfo', 'personalInfo'],
    ['stepData', 'stepData'],
    ['reverificationRequestedAt', 'reverificationRequestedAt'],
    ['formSnapshot', 'formSnapshot'],
    ['formPolicy', 'formPolicy'],
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

/** Every stored file a `step_data` object references — a custom step's uploads. */
export function stepDataFilePaths(stepData: KycSubmission['stepData'] | undefined): string[] {
  return Object.values(stepData ?? {}).flatMap((answers) =>
    Object.values(answers ?? {}).flatMap((answer) =>
      typeof answer === 'object' && answer !== null && typeof answer.filePath === 'string'
        ? [answer.filePath]
        : [],
    ),
  );
}

@Injectable()
export class KycStore {
  constructor(@Inject(DRIZZLE_DB) private readonly db: Db) {}

  async getOrCreate(userId: number): Promise<KycSubmission> {
    const existing = await this.findByUserId(userId);
    if (existing) return existing;
    const [row] = await this.db
      .insert(kycSubmissions)
      .values({ userId, status: 'not_started' })
      .onConflictDoNothing({ target: kycSubmissions.userId })
      .returning({ userId: kycSubmissions.userId });
    // Either way the row exists now (a conflict means a concurrent create won).
    void row;
    return (await this.findByUserId(userId))!;
  }

  async findByUserId(userId: number): Promise<KycSubmission | undefined> {
    const [row] = await this.db
      .select(submissionRead)
      .from(kycSubmissions)
      .where(eq(kycSubmissions.userId, userId))
      .limit(1);
    return row ? toSubmission(row) : undefined;
  }

  /**
   * The row, locked until the caller's transaction ends.
   *
   * For writes that MERGE into a document column. An upload reads the column,
   * places one page and writes the column back, and a client confirming the
   * front and the back of an ID a moment apart sends two of them at once: each
   * read the column before the other wrote, and the second write erased the
   * first page. The lock makes the second read wait for the first write.
   */
  async lockForUpdate(userId: number, executor: Executor): Promise<KycSubmission | undefined> {
    const [row] = await executor
      .select(submissionRead)
      .from(kycSubmissions)
      .where(eq(kycSubmissions.userId, userId))
      .for('update')
      .limit(1);
    return row ? toSubmission(row) : undefined;
  }

  async update(
    userId: number,
    patch: Partial<KycSubmission>,
    executor?: Executor,
  ): Promise<KycSubmission> {
    await this.getOrCreate(userId);
    return this.within(executor, async (tx) => {
      await tx
        .update(kycSubmissions)
        .set(toColumns(patch))
        .where(eq(kycSubmissions.userId, userId));
      await this.recordEvidence(userId, patch, tx);
      return (await this.readIn(userId, tx))!;
    });
  }

  /**
   * Record on the client's identity record what a write changed (0171): a
   * document, the selfie, a broker's upload, or the status that freezes them.
   * The values come from the patch; a document the patch does not name keeps
   * what the record already holds. In the caller's transaction, after the row
   * write — one implementation (`identity_record_evidence`) for every path.
   */
  private async recordEvidence(
    userId: number,
    patch: { [K in (typeof EVIDENCE_KEYS)[number]]?: unknown },
    tx: Executor,
  ): Promise<void> {
    if (!EVIDENCE_KEYS.some((key) => key in patch)) return;
    const value = (key: 'document' | 'selfie' | 'addressProof', column: SQL, slot: string) =>
      key in patch
        ? sql`${patch[key] ? JSON.stringify(patch[key]) : null}::jsonb`
        : sql`identity_evidence(${column}, ${slot})`;
    await tx.execute(sql`
      SELECT identity_record_evidence(
        k.user_id, k.status::text,
        ${value('document', sql`k.identity_document_id`, 'identity')},
        ${value('addressProof', sql`k.address_document_id`, 'address')},
        ${value('selfie', sql`k.selfie_document_id`, 'selfie')},
        k.step_data,
        coalesce(k.submitted_at, k.updated_at))
        FROM kyc_submissions k
       WHERE k.user_id = ${userId}::integer`);
  }

  private async readIn(userId: number, executor: Executor): Promise<KycSubmission | undefined> {
    const [row] = await executor
      .select(submissionRead)
      .from(kycSubmissions)
      .where(eq(kycSubmissions.userId, userId))
      .limit(1);
    return row ? toSubmission(row) : undefined;
  }

  /** Run in the caller's transaction, or in one of its own: row and record move together. */
  private within<T>(executor: Executor | undefined, work: (tx: Executor) => Promise<T>) {
    return executor ? work(executor) : this.db.transaction((tx) => work(tx));
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
    userId: number,
    from: readonly KycStatus[],
    patch: Partial<Omit<KycSubmission, 'reviewedBy'>> & { reviewedBy?: string | null },
    executor?: Executor,
    /**
     * Additionally require the row to be UNCLAIMED, or claimed by this admin.
     *
     * ## Why this belongs in the WHERE and not in the service
     *
     * A claim was advisory: `approve` transitioned from `under_review` without
     * looking at WHO held it, so a second reviewer could decide a submission a
     * colleague had open — silently, taking the claim with it. The colleague's
     * screen showed a submission they believed was theirs.
     *
     * The obvious fix, reading the row in the service and comparing
     * `reviewedBy`, is the bug wearing a check: two reviewers who read before
     * either writes both see a claim they are allowed to take, and the last
     * write still wins. It is the same TOCTOU this method's `from` argument
     * already exists to close, which is the argument for closing it the same
     * way — the condition goes in the statement that does the write, so the
     * database picks one winner.
     *
     * The service still reads first, and that read is still worth doing: it is
     * what produces a message naming the holder. The WHERE is what makes the
     * message true.
     */
    unheldOrHeldBy?: string,
  ): Promise<KycSubmission | undefined> {
    return this.within(executor, async (tx) => {
      const [row] = await tx
        .update(kycSubmissions)
        .set(toColumns(patch))
        .where(
          and(
            eq(kycSubmissions.userId, userId),
            inArray(kycSubmissions.status, [...from]),
            /*
             * ⚠️ SCOPED TO `under_review`, AND THE FIRST VERSION WAS NOT.
             *
             * It read `reviewed_by IS NULL OR = me`, which is right for a claim
             * and wrong for everything else: EVERY DECIDED ROW CARRIES A REVIEWER.
             * So once admin A approved, `reviewed_by` was A for good and admin B's
             * rejection matched nothing — silently removing the ability to reject
             * a mistaken approval, which `reject`'s wider `from` list exists to
             * allow and which `kyc-decision-adversarial.spec.ts` drives on purpose.
             *
             * The rule is about a CLAIM, so it has to name one. A claim reserves
             * the submission; a completed decision reserves nothing — it is a fact
             * a later decision may correct.
             *
             * `IS NULL OR = me` on top, not `= me` alone: a `submitted` row nobody
             * has claimed carries no reviewer, and refusing those would put a
             * mandatory claim in front of every decision — friction on the
             * ordinary path to fix a problem that only exists on the contested one.
             */
            ...(unheldOrHeldBy
              ? [
                  or(
                    ne(kycSubmissions.status, 'under_review'),
                    isNull(kycSubmissions.reviewedBy),
                    eq(kycSubmissions.reviewedBy, unheldOrHeldBy),
                  ),
                ]
              : []),
          ),
        )
        .returning({ userId: kycSubmissions.userId });
      if (!row) return undefined;
      await this.recordEvidence(userId, patch, tx);
      return this.readIn(userId, tx);
    });
  }

  async findAll(): Promise<KycSubmission[]> {
    const rows = await this.db.select(submissionRead).from(kycSubmissions);
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
    if (filter.q?.trim()) {
      // A Portal ID or a name/email — the one definition every client search
      // shares, including why its text expression must match migration 0010.
      visibility.push(clientIdentitySearch(filter.q));
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
          // The PROFILE's country of residence — its one home since 0139.
          country: users.country,
          user: {
            id: users.id,
            portalId: users.id,
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
      .select(submissionRead)
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
  async archiveAttempt(
    submission: KycSubmission,
    executor?: Executor,
    options: {
      /** A re-verification request, archived as what it is rather than a plain rejection. */
      reverification?: boolean;
      /** The configured reason the reviewer chose, kept beside the words the client read. */
      reasonId?: string;
      /**
       * A correction of a return decides what the LAST decision covered, never
       * the drafts the client has uploaded since (`KycService.reject`).
       */
      sameEvidenceAsLast?: boolean;
    } = {},
  ): Promise<void> {
    const pointer = (
      column: 'identity_document_id' | 'address_document_id' | 'selfie_document_id',
    ) =>
      options.sameEvidenceAsLast
        ? sql`(SELECT ${sql.raw(column)} FROM kyc_submission_attempts WHERE user_id = ${submission.userId}::integer ORDER BY attempt_no DESC LIMIT 1)`
        : sql`(SELECT ${sql.raw(column)} FROM kyc_submissions WHERE user_id = ${submission.userId}::integer)`;
    await this.within(executor, async (tx) => {
      const [attempt] = await tx
        .insert(kycSubmissionAttempts)
        .values({
          userId: submission.userId,
          attemptNo: sql<number>`(
          SELECT COALESCE(MAX(${kycSubmissionAttempts.attemptNo}), 0) + 1
          FROM ${kycSubmissionAttempts}
          WHERE ${kycSubmissionAttempts.userId} = ${submission.userId}
        )`,
          status: submission.status,
          personalInfo: submission.personalInfo,
          /*
           * The versions the live row names as it is decided — already frozen,
           * because a decision follows a submission. `identity_record_decision`
           * below freezes any that is not, and records what the decision covered.
           */
          identityDocumentId: pointer('identity_document_id'),
          addressDocumentId: pointer('address_document_id'),
          selfieDocumentId: pointer('selfie_document_id'),
          // An archived attempt missing the custom answers would show a reviewer a
          // partial record of what they decided on.
          stepData: submission.stepData,
          rejectionReason: submission.rejectionReason ?? null,
          rejectionReasonAr: submission.rejectionReasonAr ?? null,
          rejectedFields: submission.rejectedFields ?? null,
          submittedAt: submission.submittedAt ?? null,
          reviewedAt: submission.reviewedAt ?? null,
          reviewedBy: submission.reviewedBy ?? null,
          reverification: options.reverification ?? false,
          reasonId: options.reasonId ?? null,
          // What the broker's own steps asked, kept with the attempt it labels.
          formSnapshot: submission.formSnapshot ?? null,
        })
        .onConflictDoNothing()
        .returning({ id: kycSubmissionAttempts.id });
      // The decision, on the client's record, in the same transaction (0171).
      if (attempt) await tx.execute(sql`SELECT identity_record_decision(${attempt.id}::uuid)`);
    });
  }

  /** This client's decided attempts, oldest first. */
  async listAttempts(userId: number): Promise<KycAttempt[]> {
    const rows = await this.db
      .select(attemptRead)
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
      stepData: r.stepData ?? {},
      rejectionReason: r.rejectionReason ?? undefined,
      rejectionReasonAr: r.rejectionReasonAr ?? undefined,
      rejectedFields: r.rejectedFields ?? undefined,
      submittedAt: r.submittedAt ?? undefined,
      reviewedAt: r.reviewedAt ?? undefined,
      reviewedBy: r.reviewedBy ?? undefined,
      archivedAt: r.archivedAt,
    }));
  }

  /**
   * Every document path this client has ever had archived.
   *
   * Two callers need it and both would otherwise be wrong: `resetKyc` must not
   * delete a file that an archived attempt still points at (it is evidence now,
   * not an orphan), and the uploads controller must let a client fetch a
   * document from their own history rather than 403 them on their own passport.
   */
  async archivedDocumentPaths(userId: number): Promise<string[]> {
    const attempts = await this.listAttempts(userId);
    return attempts.flatMap((a) =>
      [
        a.document?.frontFilePath,
        a.document?.backFilePath,
        a.selfie?.filePath,
        a.addressProof?.filePath,
        a.addressProof?.page2FilePath,
        /*
         * A custom step's uploads, which an archived attempt keeps too. Without
         * them a client who replaced a returned custom document could no longer
         * open the one the reviewer refused, and `resetKyc` would delete a file
         * that is evidence of a decided attempt.
         */
        ...stepDataFilePaths(a.stepData),
      ].filter((p): p is string => typeof p === 'string' && p.length > 0),
    );
  }

  // REMOVED: `clearAll()` — an unguarded `DELETE FROM kyc_submissions` with no
  // caller once `KycService.resetAllKyc()` was deleted. See the note there.

  /**
   * The live submission goes, and with it the client's DRAFTS — work never
   * presented. What was presented stays on their record, frozen, with the
   * decisions about it (0171; `identity_adopt` did this until then).
   */
  async resetUser(userId: number, executor: Executor = this.db): Promise<void> {
    await executor.delete(kycSubmissions).where(eq(kycSubmissions.userId, userId));
    await executor.execute(
      sql`DELETE FROM client_documents WHERE user_id = ${userId}::integer AND frozen_at IS NULL`,
    );
  }
}
