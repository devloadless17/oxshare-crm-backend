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
  dateOfBirth: string;
  nationality: string;
  country: string;
  phone: string;
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
  docType: 'utility_bill' | 'bank_statement' | 'tenancy_agreement';
  filePath?: string;
  fileName?: string;
}

export interface KycSubmission {
  userId: string;
  status: KycStatus;
  rejectionReason?: string;
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

const submissions = new Map<string, KycSubmission>();

export const KycStore = {
  getOrCreate(userId: string): KycSubmission {
    if (!submissions.has(userId)) {
      submissions.set(userId, {
        userId,
        status: 'not_started',
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
    return submissions.get(userId)!;
  },

  findByUserId(userId: string): KycSubmission | undefined {
    return submissions.get(userId);
  },

  update(userId: string, patch: Partial<KycSubmission>): KycSubmission {
    const existing = this.getOrCreate(userId);
    const updated: KycSubmission = { ...existing, ...patch, updatedAt: new Date() };
    submissions.set(userId, updated);
    return updated;
  },

  findAll(): KycSubmission[] {
    return [...submissions.values()];
  },

  findByStatus(status: KycStatus): KycSubmission[] {
    return [...submissions.values()].filter((s) => s.status === status);
  },
};
