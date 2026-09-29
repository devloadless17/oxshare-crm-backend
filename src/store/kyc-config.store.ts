import { createHash } from 'crypto';
import { documentForFieldType } from '../common/kyc/document-catalogue';
import { KYC_COUNTRY_OPTIONS, KYC_NATIONALITY_OPTIONS } from '../common/kyc/country-options';
import {
  CORE_STEPS,
  DEFAULT_IDENTITY_PLACEMENTS,
  DOCUMENT_CATALOGUE_BY_CATEGORY,
  documentField,
  inFormOrder,
  isPlatformField,
  platformStep,
  storedStep,
} from '../common/kyc/identity-core';
import { asc, inArray, sql } from 'drizzle-orm';
import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE_DB } from '../database/database.module';
import type { Db, Executor } from '../database/db';
import { kycConfigSteps, kycFieldLabels } from '../database/schema';

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
  /**
   * The PLATFORM's field — an identity field, or the selfie camera. Served on
   * every read, never stored, never editable (`common/kyc/identity-core.ts`).
   */
  system?: boolean;
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
  /** One of the four built-in steps. Served on read, never stored. */
  core?: boolean;
  /** A built-in step that cannot be switched off. Served on read, never stored. */
  alwaysOn?: boolean;
  /** Identity document, selfie, proof of address: must the client provide it. */
  evidenceRequired?: boolean;
}

/*
 * ── `MANDATORY_KYC_SLUGS` IS GONE, AND THE RULE IT NAMED IS BACK — PARTLY ────
 *
 * The constant listed personal/document/selfie/address and its docblock said,
 * at length, that it was NOT enforced: the owner retired the mandatory-step rule
 * on 15 Aug 2026, and the list survived as a default and a test fixture.
 *
 * On 26 Sep 2026 the owner ruled again, after a broker's edit silently removed a
 * client's first name from the form: the four built-in steps exist exactly
 * once, Personal Information and Identity Document are always on, and Selfie
 * and Proof of Address may be switched off. That model lives in
 * `common/kyc/identity-core.ts` (`CORE_STEPS`) and is ENFORCED — by the store
 * below on every read and write, and by `kyc-config-integrity.ts` on every
 * save. Nothing here restates it.
 */

/**
 * The default flow, as the TABLE holds it. Seeded idempotently at bootstrap
 * (src/database/seed.ts); the builder edits the table from there.
 *
 * Not what a reader SEES: the identity fields and the selfie camera are the
 * platform's and are never stored, so `getSteps` adds them on the way out
 * (`platformStep`). What is written here is only what the broker could change —
 * which documents each document step accepts, whether a step is on, and its
 * description.
 */
const identityDocuments = DOCUMENT_CATALOGUE_BY_CATEGORY.identity.map(documentField);
const addressDocuments = DOCUMENT_CATALOGUE_BY_CATEGORY.address.map(documentField);

export const DEFAULT_KYC_STEPS: KycStepConfig[] = CORE_STEPS.map((core, index) => ({
  id: `step-${index + 1}`,
  stepNumber: index + 1,
  slug: core.slug,
  title: core.title,
  description: core.description,
  icon: core.icon,
  enabled: true,
  evidenceRequired: core.slug === 'personal' ? undefined : true,
  fields:
    core.slug === 'personal'
      ? DEFAULT_IDENTITY_PLACEMENTS.map((field) => ({ ...field }))
      : core.documents === 'identity'
        ? identityDocuments
        : core.documents === 'address'
          ? addressDocuments
          : [],
}));

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
 * Field names whose options are a SYSTEM LIST rather than an operator's typing.
 *
 * Nobody is going to hand-enter 250 countries into the builder, and a list that
 * was typed once would then drift from the `countries-list` package. So these
 * two resolve from `common/kyc/country-options.ts`.
 *
 * Matched on the field NAME, which is deliberate: `nationality` and `country`
 * are profile fields (0139), and the name IS the profile column.
 *
 * ⚠️ **ALWAYS the system list — stored options are ignored, not deferred to.**
 * The answer lands in the client's profile, which accepts exactly the system
 * list (`client-profile.ts`), and a "strip it back out" that compared by
 * IDENTITY — which a JSON round trip never preserves — once baked the whole list
 * into the row (found on the dev database: 187 nationalities, 251 countries).
 * Since the identity core, those two fields are never stored at all; the strip
 * below still runs, for the rows written before.
 */
const SYSTEM_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  nationality: KYC_NATIONALITY_OPTIONS,
  country: KYC_COUNTRY_OPTIONS,
};

const hasSystemOptions = (name: string): boolean =>
  Object.prototype.hasOwnProperty.call(SYSTEM_OPTIONS, name);

/**
 * Resolves each document field's catalogue entry, and each system list, on the
 * way OUT.
 *
 * The row stores the TYPE only, so a step configured last year cannot hold a
 * stale copy of what a passport requires — change the catalogue and every step
 * that accepts one follows on the next read. Storing the resolved shape would
 * mean a migration each time a document's slots changed.
 */
const withResolvedDocuments = (fields: KycFieldConfig[]): KycFieldConfig[] =>
  fields.map((field) => {
    const document = documentForFieldType(field.type);
    // A base type (`text`, `date`, …) resolves to nothing and passes through.
    if (document) return { ...field, document };
    if (field.type === 'select' && hasSystemOptions(field.name)) {
      return { ...field, options: [...SYSTEM_OPTIONS[field.name]] };
    }
    return field;
  });

/**
 * A row as every reader sees it: the platform's parts rebuilt from code
 * (`platformStep`), then the catalogue and the system lists resolved.
 */
const toStep = (r: Row): KycStepConfig => {
  const step = platformStep<KycStepConfig>({
    id: r.id,
    stepNumber: r.stepNumber,
    slug: r.slug,
    title: r.title,
    description: r.description ?? '',
    icon: r.icon ?? 'FileText',
    enabled: r.enabled,
    evidenceRequired: r.evidenceRequired,
    fields: (r.fields as unknown as KycFieldConfig[]) ?? [],
  });
  return { ...step, fields: withResolvedDocuments(step.fields) };
};

/*
 * What is resolved on the way out is stripped on the way in. `document` is
 * derived from the catalogue, so persisting it would create a second copy that
 * drifts — and a client posting a hand-crafted one could otherwise declare a
 * passport needs no upload at all. A system list is stripped by NAME, whatever
 * arrived.
 */
const stripResolved = (fields: KycFieldConfig[]): KycFieldConfig[] =>
  fields.map(({ document: _resolved, ...field }) => {
    if (field.type === 'select' && hasSystemOptions(field.name)) {
      const { options: _system, ...rest } = field;
      return rest;
    }
    return field;
  });

/** A step as it is STORED — the platform's parts removed (`storedStep`). */
const toRow = (s: KycStepConfig) => {
  const stored = storedStep(s);
  return {
    id: stored.id,
    stepNumber: stored.stepNumber,
    slug: stored.slug,
    title: stored.title,
    description: stored.description,
    icon: stored.icon,
    enabled: stored.enabled,
    evidenceRequired: stored.evidenceRequired !== false,
    fields: stripResolved(stored.fields) as unknown as Record<string, unknown>[],
  };
};

/**
 * THE CONFIGURATION'S VERSION, as the builder's save must name it.
 *
 * A digest of the form exactly as `getSteps` serves it. Two operators editing
 * the form at once used to be settled by whoever pressed Save last, silently
 * discarding the other's work; the save now states the version it was edited
 * from (`If-Match`), and a version that no longer matches is refused (409).
 *
 * A digest rather than a counter because it needs no column and cannot fall
 * out of step with what it describes: it IS what it describes.
 */
export function kycConfigVersion(steps: readonly KycStepConfig[]): string {
  return createHash('sha256').update(JSON.stringify(steps)).digest('hex');
}

@Injectable()
export class KycConfigStore {
  constructor(@Inject(DRIZZLE_DB) private readonly db: Db) {}

  /** The form as every reader sees it: Personal Information first, then the rest in order. */
  async getSteps(executor: Executor = this.db): Promise<KycStepConfig[]> {
    const rows = await executor
      .select()
      .from(kycConfigSteps)
      .orderBy(asc(kycConfigSteps.stepNumber));
    return inFormOrder(rows.map(toStep));
  }

  /**
   * Serialise every change to the form behind one transaction-scoped lock, so
   * "read the version, check it, write" is one act. Transaction-scoped rather
   * than session-scoped, because behind a pool a session lock can be released
   * on a different connection than took it (see `JobLeaseService`).
   */
  async lockForChange(executor: Executor): Promise<void> {
    await executor.execute(sql`SELECT pg_advisory_xact_lock(hashtext('kyc_config_steps'))`);
  }

  /**
   * Replace the whole form. Joins the caller's transaction when given one —
   * the service locks, checks and writes as one act.
   */
  async setSteps(steps: KycStepConfig[], executor?: Executor): Promise<KycStepConfig[]> {
    /*
     * ⚠️ `id` IS ASSIGNED HERE WHEN THE CALLER OMITS IT, AND THAT IS NOT COSMETIC.
     *
     * `kyc_config_steps.id` is `text().primaryKey()` with NO database default,
     * while `KycStepDto.id` is declared OPTIONAL. A caller adding a step the way
     * the DTO invites — slug, title, fields, no id — once reached the insert
     * with `id: undefined` and got a 500 on a request the contract asked for.
     * Assigned rather than made required, because the id is the server's to
     * decide, like `stepNumber`; derived from the slug and de-duplicated
     * against ids already spoken for in this payload.
     */
    const taken = new Set(steps.map((s) => s.id).filter((id): id is string => Boolean(id)));
    const assignId = (s: KycStepConfig, idx: number): string => {
      if (s.id) return s.id;
      const base = `step-${s.slug || String(idx + 1)}`;
      let candidate = base;
      let n = 2;
      while (taken.has(candidate)) candidate = `${base}-${n++}`;
      taken.add(candidate);
      return candidate;
    };

    const ordered = inFormOrder(steps.map((s, idx) => ({ ...s, id: assignId(s, idx) })));
    const write = async (tx: Executor) => {
      await tx.delete(kycConfigSteps);
      if (ordered.length > 0) await tx.insert(kycConfigSteps).values(ordered.map(toRow));
      await recordLabels(tx, ordered);
      return this.getSteps(tx);
    };
    return executor ? write(executor) : this.db.transaction(write);
  }

  /**
   * The recorded name of each key asked for (`kyc_field_labels`, 0148) — for an
   * answer whose question is no longer on the form. A key never recorded is absent.
   */
  async recordedLabels(
    names: readonly string[],
    executor: Executor = this.db,
  ): Promise<Map<string, { label: string; type: string }>> {
    const unique = [...new Set(names)].filter(Boolean);
    if (unique.length === 0) return new Map();
    const rows = await executor
      .select({ name: kycFieldLabels.name, label: kycFieldLabels.label, type: kycFieldLabels.type })
      .from(kycFieldLabels)
      .where(inArray(kycFieldLabels.name, unique));
    return new Map(rows.map((row) => [row.name, { label: row.label, type: row.type }]));
  }
}

/**
 * KEEP THE NAME OF EVERY QUESTION THE FORM HOLDS (0148, reported 26 Sep 2026).
 *
 * In the same transaction as the form: a question cannot be saved without its
 * name outliving it, so deleting it later — or its step, or resetting the form —
 * never leaves the answers already given with nothing but a key to show. The
 * latest name wins; nothing is ever deleted. Only the broker's own fields: the
 * platform's identity, documents and selfie are named by the platform.
 */
async function recordLabels(tx: Executor, steps: readonly KycStepConfig[]): Promise<void> {
  const rows = new Map<string, { name: string; label: string; type: string }>();
  for (const step of steps) {
    for (const field of step.fields) {
      if (isPlatformField(step.slug, field) || field.type?.startsWith('doc:')) continue;
      const label = field.label?.trim();
      if (!field.name || !label) continue;
      rows.set(field.name, { name: field.name, label, type: field.type || 'text' });
    }
  }
  if (rows.size === 0) return;
  await tx
    .insert(kycFieldLabels)
    .values([...rows.values()])
    .onConflictDoUpdate({
      target: kycFieldLabels.name,
      set: { label: sql`excluded.label`, type: sql`excluded.type`, recordedAt: sql`now()` },
      setWhere: sql`${kycFieldLabels.label} IS DISTINCT FROM excluded.label OR ${kycFieldLabels.type} IS DISTINCT FROM excluded.type`,
    });
}
