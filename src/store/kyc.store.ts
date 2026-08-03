import { eq } from 'drizzle-orm';
import { getDb } from '../database/db';
import { kycSubmissions } from '../database/schema';

export type KycStatus =
  | 'not_started'
  | 'in_progress'
  | 'submitted'
  | 'under_review'
  | 'approved'
  | 'rejected';

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

export const KycStore = {
  async getOrCreate(userId: string): Promise<KycSubmission> {
    const existing = await this.findByUserId(userId);
    if (existing) return existing;
    const [row] = await getDb()
      .insert(kycSubmissions)
      .values({ userId, status: 'not_started' })
      .onConflictDoNothing({ target: kycSubmissions.userId })
      .returning();
    // Conflict means a concurrent create won — read it back.
    return row ? toSubmission(row) : (await this.findByUserId(userId))!;
  },

  async findByUserId(userId: string): Promise<KycSubmission | undefined> {
    const [row] = await getDb()
      .select()
      .from(kycSubmissions)
      .where(eq(kycSubmissions.userId, userId))
      .limit(1);
    return row ? toSubmission(row) : undefined;
  },

  async update(userId: string, patch: Partial<KycSubmission>): Promise<KycSubmission> {
    await this.getOrCreate(userId);
    const [row] = await getDb()
      .update(kycSubmissions)
      .set(toColumns(patch))
      .where(eq(kycSubmissions.userId, userId))
      .returning();
    return toSubmission(row);
  },

  async findAll(): Promise<KycSubmission[]> {
    const rows = await getDb().select().from(kycSubmissions);
    return rows.map(toSubmission);
  },

  async findByStatus(status: KycStatus): Promise<KycSubmission[]> {
    const rows = await getDb()
      .select()
      .from(kycSubmissions)
      .where(eq(kycSubmissions.status, status));
    return rows.map(toSubmission);
  },

  async clearAll(): Promise<void> {
    await getDb().delete(kycSubmissions);
  },

  async resetUser(userId: string): Promise<void> {
    await getDb().delete(kycSubmissions).where(eq(kycSubmissions.userId, userId));
  },
};
