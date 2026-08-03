import { v4 as uuidv4 } from 'uuid';
import { asc, eq } from 'drizzle-orm';
import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE_DB } from '../database/database.module';
import type { Db } from '../database/db';
import { kycConfigSteps } from '../database/schema';

export interface KycFieldConfig {
  id: string;
  name: string;
  label: string;
  type: 'text' | 'date' | 'phone' | 'select' | 'file' | 'camera' | 'checkbox';
  required: boolean;
  options?: string[]; // for select type
  hint?: string;
}

export interface KycStepConfig {
  id: string;
  stepNumber: number;
  slug: string;
  title: string;
  description: string;
  icon: string;
  enabled: boolean;
  fields: KycFieldConfig[];
}

// The five default onboarding steps. Seeded idempotently at bootstrap
// (src/database/seed.ts); the builder edits the table from there.
export const DEFAULT_KYC_STEPS: KycStepConfig[] = [
  {
    id: 'step-1',
    stepNumber: 1,
    slug: 'personal',
    title: 'Personal Information',
    description: 'Legal identity details exactly as they appear on your government ID.',
    icon: 'User',
    enabled: true,
    fields: [
      {
        id: 'f-1',
        name: 'firstName',
        label: 'First Name',
        type: 'text',
        required: true,
        hint: 'As on your ID',
      },
      {
        id: 'f-2',
        name: 'lastName',
        label: 'Last Name',
        type: 'text',
        required: true,
        hint: 'As on your ID',
      },
      {
        id: 'f-3',
        name: 'dateOfBirth',
        label: 'Date of Birth',
        type: 'date',
        required: true,
        hint: 'Must be 18+',
      },
      {
        id: 'f-4',
        name: 'phone',
        label: 'Phone Number',
        type: 'phone',
        required: true,
        hint: 'International format',
      },
      {
        id: 'f-5',
        name: 'nationality',
        label: 'Nationality',
        type: 'select',
        required: true,
      },
      {
        id: 'f-6',
        name: 'country',
        label: 'Country of Residence',
        type: 'select',
        required: true,
      },
      {
        id: 'f-7',
        name: 'address',
        label: 'Residential Address',
        type: 'text',
        required: false,
      },
    ],
  },
  {
    id: 'step-2',
    stepNumber: 2,
    slug: 'document',
    title: 'Identity Document',
    description: 'Upload a valid Passport, National ID, or Driving License.',
    icon: 'FileText',
    enabled: true,
    fields: [
      {
        id: 'f-9',
        name: 'doc_front',
        label: 'Front Side',
        type: 'file',
        required: true,
      },
      {
        id: 'f-10',
        name: 'doc_back',
        label: 'Back Side',
        type: 'file',
        required: false,
        hint: 'Required for National ID & Driving License',
      },
    ],
  },
  {
    id: 'step-3',
    stepNumber: 3,
    slug: 'selfie',
    title: 'Selfie Verification',
    description: 'Live selfie photo matching your identity document.',
    icon: 'Camera',
    enabled: true,
    fields: [
      {
        id: 'f-11',
        name: 'selfie',
        label: 'Selfie Photo',
        type: 'camera',
        required: true,
      },
    ],
  },
  {
    id: 'step-4',
    stepNumber: 4,
    slug: 'address',
    title: 'Proof of Address',
    description: 'Document dated within the last 3 months showing your residential address.',
    icon: 'Home',
    enabled: true,
    fields: [
      {
        id: 'f-13',
        name: 'address_proof',
        label: 'Primary Page (Page 1)',
        type: 'file',
        required: true,
      },
      {
        id: 'f-14',
        name: 'address_proof_2',
        label: 'Page 2 / Supporting Document',
        type: 'file',
        required: false,
      },
    ],
  },
  {
    id: 'step-5',
    stepNumber: 5,
    slug: 'review',
    title: 'Review & Submit',
    description: 'Confirm all details and submit your application for compliance review.',
    icon: 'CheckSquare',
    enabled: true,
    fields: [],
  },
];

type Row = typeof kycConfigSteps.$inferSelect;

const toStep = (r: Row): KycStepConfig => ({
  id: r.id,
  stepNumber: r.stepNumber,
  slug: r.slug,
  title: r.title,
  description: r.description ?? '',
  icon: r.icon ?? 'FileText',
  enabled: r.enabled,
  fields: (r.fields as unknown as KycFieldConfig[]) ?? [],
});

const toRow = (s: KycStepConfig) => ({
  id: s.id,
  stepNumber: s.stepNumber,
  slug: s.slug,
  title: s.title,
  description: s.description,
  icon: s.icon,
  enabled: s.enabled,
  fields: s.fields as unknown as Record<string, unknown>[],
});

@Injectable()
export class KycConfigStore {
  constructor(@Inject(DRIZZLE_DB) private readonly db: Db) {}

  async getSteps(): Promise<KycStepConfig[]> {
    const rows = await this.db
      .select()
      .from(kycConfigSteps)
      .orderBy(asc(kycConfigSteps.stepNumber));
    return rows.map(toStep);
  }

  async setSteps(steps: KycStepConfig[]): Promise<KycStepConfig[]> {
    const reindexed = steps.map((s, idx) => ({ ...s, stepNumber: idx + 1 }));
    const db = this.db;
    await db.transaction(async (tx) => {
      await tx.delete(kycConfigSteps);
      if (reindexed.length > 0) await tx.insert(kycConfigSteps).values(reindexed.map(toRow));
    });
    return this.getSteps();
  }

  async addStep(stepData: Omit<KycStepConfig, 'id' | 'stepNumber'>): Promise<KycStepConfig> {
    const existing = await this.getSteps();
    const newStep: KycStepConfig = {
      ...stepData,
      id: `step-${uuidv4()}`,
      stepNumber: existing.length + 1,
    };
    await this.db.insert(kycConfigSteps).values(toRow(newStep));
    return newStep;
  }

  async updateStep(id: string, patch: Partial<KycStepConfig>): Promise<KycStepConfig | undefined> {
    const [existing] = await this.db
      .select()
      .from(kycConfigSteps)
      .where(eq(kycConfigSteps.id, id))
      .limit(1);
    if (!existing) return undefined;
    const merged = { ...toStep(existing), ...patch, id };
    const [row] = await this.db
      .update(kycConfigSteps)
      .set(toRow(merged))
      .where(eq(kycConfigSteps.id, id))
      .returning();
    return toStep(row);
  }

  async deleteStep(id: string): Promise<boolean> {
    const deleted = await this.db
      .delete(kycConfigSteps)
      .where(eq(kycConfigSteps.id, id))
      .returning();
    if (deleted.length === 0) return false;
    // Re-index the remaining steps
    const remaining = await this.getSteps();
    await this.setSteps(remaining);
    return true;
  }

  resetDefaults(): Promise<KycStepConfig[]> {
    return this.setSteps([...DEFAULT_KYC_STEPS]);
  }
}
