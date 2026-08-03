import { and, desc, eq, ilike, or, sql, SQL } from 'drizzle-orm';
import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE_DB } from '../database/database.module';
import type { Db } from '../database/db';
import { kycSubmissions, users } from '../database/schema';

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

  async update(userId: string, patch: Partial<KycSubmission>): Promise<KycSubmission> {
    await this.getOrCreate(userId);
    const [row] = await this.db
      .update(kycSubmissions)
      .set(toColumns(patch))
      .where(eq(kycSubmissions.userId, userId))
      .returning();
    return toSubmission(row);
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
      db
        .select({
          submission: kycSubmissions,
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
      items: rows.map((r) => ({ ...toSubmission(r.submission), user: r.user })),
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

  async clearAll(): Promise<void> {
    await this.db.delete(kycSubmissions);
  }

  async resetUser(userId: string): Promise<void> {
    await this.db.delete(kycSubmissions).where(eq(kycSubmissions.userId, userId));
  }
}
