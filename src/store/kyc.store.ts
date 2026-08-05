import { and, asc, desc, eq, ilike, inArray, or, sql, SQL } from 'drizzle-orm';
import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE_DB } from '../database/database.module';
import type { Db, Executor } from '../database/db';
import { kycSubmissionAttempts, kycSubmissions, users } from '../database/schema';

export type KycStatus =
  'not_started' | 'in_progress' | 'submitted' | 'under_review' | 'approved' | 'rejected';

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
const toColumns = (patch: Partial<KycSubmission>) => {
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
  for (const [key, col] of map) {
    if (key in patch) set[col] = patch[key] ?? null;
  }
  return set;
};

@Injectable()
export class KycStore {
  constructor(@Inject(DRIZZLE_DB) private readonly db: Db) {}

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
  async transition(
    userId: string,
    from: readonly KycStatus[],
    patch: Partial<KycSubmission>,
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
  async findPageWithUsers(filter: { status?: KycStatus; q?: string; page: number; limit: number }) {
    const db = this.db;
    const conditions: SQL[] = [];
    if (filter.status) conditions.push(eq(kycSubmissions.status, filter.status));
    if (filter.q) {
      const term = `%${filter.q}%`;
      conditions.push(
        or(ilike(users.email, term), ilike(users.firstName, term), ilike(users.lastName, term))!,
      );
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;

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
        .orderBy(desc(kycSubmissions.submittedAt))
        .limit(filter.limit)
        .offset((filter.page - 1) * filter.limit),
      db
        .select({ value: sql<number>`count(*)::int` })
        .from(kycSubmissions)
        .innerJoin(users, eq(kycSubmissions.userId, users.id))
        .where(where),
      // Counts over the FULL set so admin tab counts stay correct under a filter.
      db
        .select({
          status: kycSubmissions.status,
          value: sql<number>`count(*)::int`,
        })
        .from(kycSubmissions)
        .groupBy(kycSubmissions.status),
    ]);

    const counts: Record<string, number> = { all: 0 };
    for (const row of statusCounts) {
      counts[row.status] = row.value;
      counts['all'] += row.value;
    }

    return {
      items: rows.map((r) => ({
        userId: r.userId,
        status: r.status,
        submittedAt: r.submittedAt ?? undefined,
        reviewedAt: r.reviewedAt ?? undefined,
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
