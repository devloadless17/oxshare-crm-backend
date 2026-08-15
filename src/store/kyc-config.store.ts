import { documentForFieldType } from '../common/kyc/document-catalogue';
import { KYC_COUNTRY_OPTIONS, KYC_NATIONALITY_OPTIONS } from '../common/kyc/country-options';
import { v4 as uuidv4 } from 'uuid';
import { asc, eq } from 'drizzle-orm';
import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE_DB } from '../database/database.module';
import type { Db } from '../database/db';
import { kycConfigSteps } from '../database/schema';

/** One upload slot a document type asks for. See `KycDocumentType`. */
export interface KycDocumentPart {
  key: string;
  label: string;
  required: boolean;
  hint?: string;
}

/**
 * A document the client may choose, and what uploading it involves.
 *
 * The parts live on the TYPE because that is where the requirement actually
 * belongs: a passport is one page, a national ID is two, a utility bill is one,
 * a tenancy agreement may be several. Every KYC provider surveyed (Sumsub,
 * Onfido, Persona, Veriff, Jumio, Stripe Identity, Trulioo — Aug 2026) models
 * the side as an axis orthogonal to the type rather than baking it into an
 * enum, and only Sumsub and Jumio publish it as data. This does, which is what
 * lets the portal render the right number of slots without knowing any document
 * name.
 */
export interface KycDocumentType {
  value: string;
  label: string;
  category: 'identity' | 'address';
  parts: KycDocumentPart[];
}

export interface KycFieldConfig {
  id: string;
  name: string;
  label: string;
  /**
   * A base type, or `doc:<value>` for a document — see `documentFieldType`.
   * Left as a string because the catalogue defines the document half, so a
   * union here would have to be regenerated every time one is added.
   */
  type: string;
  required: boolean;
  options?: string[]; // for select type
  hint?: string;
  /**
   * The catalogue entry this field collects, resolved from its `type` when
   * serving. NOT persisted — the type is the only stored fact, so a field can
   * never hold a stale copy of what a passport requires.
   */
  document?: KycDocumentType;
}

/**
 * Steps the KYC flow cannot be configured without.
 *
 * FR-CORE-15 mandates the identity document, selfie and proof-of-address steps;
 * FR-IND-03 mandates the profile step. The client portal submits by slug and the
 * FSD's §14 acceptance criteria depend on all four existing and being enabled, so
 * removing or disabling one silently breaks onboarding for every new client
 * (DECISIONS D-29).
 *
 * The admin UI has always blocked this. The API did not — verified against a
 * running server: `PUT /admin/kyc-config` accepted a config with `personal`
 * disabled (200), and `DELETE /admin/kyc-config/steps/step-2` removed the identity
 * document step (200). So the rule held only for users of one screen, and any
 * script, integration or future admin client bypassed it. It is enforced in
 * AdminComplianceService now, with this as the single definition.
 */
export const MANDATORY_KYC_SLUGS: readonly string[] = ['personal', 'document', 'selfie', 'address'];

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
      /*
       * THREE FIELDS, one per accepted document — the alternatives the client
       * chooses between, written the way they read.
       *
       * The type IS the document (`doc:passport`), so how many photos each
       * needs is a fact in `common/kyc/document-catalogue.ts` rather than
       * something re-entered per step.
       */
      {
        id: 'f-doc-passport',
        name: 'passport',
        label: 'Passport',
        type: 'doc:passport',
        required: false,
      },
      {
        id: 'f-doc-national-id',
        name: 'nationalId',
        label: 'National ID',
        type: 'doc:national_id',
        required: false,
      },
      {
        id: 'f-doc-driving-license',
        name: 'drivingLicense',
        label: 'Driving License',
        type: 'doc:driving_license',
        required: false,
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
        id: 'f-addr-utility',
        name: 'utilityBill',
        label: 'Utility Bill',
        type: 'doc:utility_bill',
        required: false,
      },
      {
        id: 'f-addr-bank',
        name: 'bankStatement',
        label: 'Bank Statement',
        type: 'doc:bank_statement',
        required: false,
      },
      {
        id: 'f-addr-tenancy',
        name: 'tenancyAgreement',
        label: 'Tenancy Agreement',
        type: 'doc:tenancy_agreement',
        required: false,
      },
    ],
  },
];

/*
 * ── THERE IS NO `review` STEP IN HERE, DELIBERATELY ───────────────────────
 *
 * It used to be seeded as step 5 like any other, which made it configurable —
 * and it is the one step that must not be. "Review & Submit" is where the
 * client presses the button that submits the whole application: an operator who
 * disabled or deleted it left a flow with no way to finish, and one who dragged
 * it to position 2 left a flow that submits before it collects anything.
 *
 * The portal appends it after whatever this config returns, so it is always
 * last and always present. See `dynamic-step-renderer.tsx`.
 */

type Row = typeof kycConfigSteps.$inferSelect;

/**
 * Resolves `acceptedDocuments` into the full catalogue entries on the way OUT.
 *
 * The row stores values only, so a step configured last year cannot hold a
 * stale copy of what a passport requires — change the catalogue and every step
 * that accepts one follows on the next read. Storing the resolved shape would
 * mean a migration each time a document's slots changed.
 */
/**
 * Field names whose options are a SYSTEM LIST rather than an operator's typing.
 *
 * Nobody is going to hand-enter 250 countries into the builder, and a list that
 * was typed once would then drift from the `countries-list` package. So these
 * two resolve from `common/kyc/country-options.ts` when the field carries no
 * options of its own.
 *
 * Matched on the field NAME, which is the one piece of name-coupling left and
 * is deliberate: `nationality` and `country` are the names the portal has
 * always submitted and the columns are keyed on them. An operator who wants a
 * different list gives the field its own `options`, and this defers.
 */
const SYSTEM_OPTIONS: Record<string, string[]> = {
  nationality: KYC_NATIONALITY_OPTIONS,
  country: KYC_COUNTRY_OPTIONS,
};

const withResolvedDocuments = (fields: KycFieldConfig[]): KycFieldConfig[] =>
  fields.map((field) => {
    const document = documentForFieldType(field.type);
    // A base type (`text`, `date`, …) resolves to nothing and passes through.
    if (document) return { ...field, document };

    /*
     * A `select` with no options of its own gets the system list, if one exists
     * for its name. The admin builder showed both of these as "Dropdown with no
     * choices" because that is exactly what they were — the portal filled them
     * in locally, so the config never knew.
     */
    if (field.type === 'select' && !field.options?.length) {
      const system = SYSTEM_OPTIONS[field.name];
      if (system) return { ...field, options: system };
    }
    return field;
  });

const toStep = (r: Row): KycStepConfig => ({
  id: r.id,
  stepNumber: r.stepNumber,
  slug: r.slug,
  title: r.title,
  description: r.description ?? '',
  icon: r.icon ?? 'FileText',
  enabled: r.enabled,
  fields: withResolvedDocuments((r.fields as unknown as KycFieldConfig[]) ?? []),
});

/*
 * `documentTypes` is stripped on the way IN. It is derived from the catalogue,
 * so persisting it would create a second copy that drifts — and a client
 * posting a hand-crafted one could otherwise declare a passport needs no
 * upload at all.
 */
const stripResolved = (fields: KycFieldConfig[]): KycFieldConfig[] =>
  fields.map(({ document: _resolved, ...field }) => {
    /*
     * A system list is stripped back out on the way IN, or the first save from
     * the builder would bake 250 country names into the row — a snapshot that
     * stops tracking the package the moment it is written.
     *
     * Compared by identity: an operator who edits the list is holding a
     * different array, and theirs is kept.
     */
    const system = SYSTEM_OPTIONS[field.name];
    if (system && field.options === system) {
      const { options: _system, ...rest } = field;
      return rest;
    }
    return field;
  });

const toRow = (s: KycStepConfig) => ({
  id: s.id,
  stepNumber: s.stepNumber,
  slug: s.slug,
  title: s.title,
  description: s.description,
  icon: s.icon,
  enabled: s.enabled,
  fields: stripResolved(s.fields) as unknown as Record<string, unknown>[],
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
