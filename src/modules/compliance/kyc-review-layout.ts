/**
 * HOW A SUBMISSION IS PRESENTED TO A REVIEWER — its structure and its labels,
 * and nothing of the client's. A pure seam, beside `kyc-step-state.ts`.
 *
 * ## Why the server says it (26 Sep 2026)
 *
 * The review screen built its sections from the builder's configuration, which
 * made it wrong in three ways at once:
 *
 *  - a reviewer whose role reads submissions but not the builder (`kyc.review`
 *    alone) got a degraded screen — the configuration answered 403;
 *  - a question the broker relabelled or removed after the client answered was
 *    shown under the new label, or not at all, beside an answer to something
 *    else — the review was a function of today's form, not of what was asked;
 *  - identity, documents and the broker's own questions were mixed in one list,
 *    and a document was labelled `?? 'passport'` when its type was unknown.
 *
 * So the server states the layout: the platform's identity fields in their
 * order, the identity document by its exact name with each page, the proof of
 * address and the selfie when they were asked for, and the broker's own
 * questions grouped by step — as they were ASKED (`formSnapshot`, written at
 * submission), with any answer to a question no longer on the form listed
 * rather than lost — under the name it was last given (`kyc_field_labels`,
 * 0148), never its key. The VALUES stay where they are in the response, under the
 * masks that already govern them; this carries labels only, so it can never be
 * the route a masked value leaks by.
 *
 * `flags` names each item a reviewer returned the way every screen and the
 * email must name it: one label per flag, from one function.
 */
import { catalogueDocument } from '../../common/kyc/document-catalogue';
import {
  IDENTITY_FIELDS,
  identityField,
  isPlatformField,
  REVIEW_SLUG,
} from '../../common/kyc/identity-core';
import { isProfileKey, type ProfileKey } from '../../common/profile/client-profile';
import type { KycStepConfig } from '../../store/kyc-config.store';
import type { KycFormSnapshot, KycSubmission } from '../../store/kyc.store';
import { documentFlagLabel } from './kyc-document-rules';
import { isStoredFile } from './step-slugs';

export interface KycReviewPage {
  /** Where the file is stored: `doc_front`, `doc_back`, `address_proof`, `address_proof_2`. */
  slot: string;
  label: string;
  required: boolean;
}

export interface KycReviewDocument {
  /** The catalogue value on file, or null when none was chosen. */
  type: string | null;
  /** "Passport", "National ID" — never a guess. */
  label: string;
  pages: KycReviewPage[];
}

export interface KycReviewField {
  name: string;
  label: string;
  type: string;
  /** The step the answer is filed under — `personal` reads `personalInfo`, any other `stepData[step]`. */
  step: string;
}

export interface KycReviewSection {
  /** The step the questions were asked on, or `unlisted` for answers to removed questions. */
  slug: string;
  title: string;
  fields: KycReviewField[];
}

export interface KycReviewLayout {
  identity: { key: ProfileKey; label: string; required: boolean }[];
  identityDocument: KycReviewDocument;
  proofOfAddress: KycReviewDocument & { asked: boolean };
  selfie: { asked: boolean; label: string };
  additional: KycReviewSection[];
  flags: { id: string; label: string }[];
}

const IDENTITY_SLOTS = ['doc_front', 'doc_back'] as const;
const ADDRESS_SLOTS = ['address_proof', 'address_proof_2'] as const;

/**
 * The name each key was last given, kept after its question left the form
 * (`kyc_field_labels`, 0148; read by `KycConfigStore.recordedLabels`).
 */
export type RecordedLabels = ReadonlyMap<string, { label: string; type: string }>;

/**
 * What a removed question is called when nothing ever recorded its name — said
 * as it is, never its key: "Custom Field 1790263641710" told a reviewer nothing
 * and looked like a bug (reported 26 Sep 2026).
 */
export const UNRECORDED_QUESTION = 'Question name not on record';

/** Every key a client answered with a question of the broker's — what to look names up for. */
export function answerKeysOf(
  submission: Pick<KycSubmission, 'personalInfo' | 'stepData'>,
): string[] {
  const keys = Object.keys(submission.personalInfo ?? {}).filter((key) => !isProfileKey(key));
  for (const answers of Object.values(submission.stepData ?? {})) {
    keys.push(...Object.keys(answers ?? {}));
  }
  return [...new Set(keys)];
}

/** The reviewer's layout of one submission. */
export function reviewLayout(
  steps: readonly KycStepConfig[],
  submission: Pick<
    KycSubmission,
    'document' | 'addressProof' | 'personalInfo' | 'stepData' | 'formSnapshot' | 'rejectedFields'
  >,
  recorded: RecordedLabels = new Map(),
): KycReviewLayout {
  const asked = (slug: string) => steps.some((step) => step.slug === slug && step.enabled);
  const additional = additionalSections(steps, submission, recorded);
  return {
    identity: IDENTITY_FIELDS.map((field) => ({
      key: field.name,
      label: field.label,
      required: field.required,
    })),
    identityDocument: documentOf(submission.document?.docType, 'identity', 'Identity document'),
    proofOfAddress: {
      asked: asked('address'),
      ...documentOf(submission.addressProof?.docType, 'address', 'Proof of address'),
    },
    selfie: { asked: asked('selfie'), label: 'Selfie' },
    additional,
    flags: (submission.rejectedFields ?? []).map((id) => ({
      id,
      label: flagLabel(id, steps, submission, additional),
    })),
  };
}

/** The document on file, by its exact name and its catalogue pages. */
function documentOf(
  type: string | undefined,
  category: 'identity' | 'address',
  fallback: string,
): KycReviewDocument {
  const slots = category === 'identity' ? IDENTITY_SLOTS : ADDRESS_SLOTS;
  const entry = type ? catalogueDocument(type) : undefined;
  if (entry && entry.category === category) {
    return {
      type: entry.value,
      label: entry.label,
      pages: entry.parts.map((part, index) => ({
        slot: slots[index],
        label: part.label,
        required: part.required,
      })),
    };
  }
  // Untyped (a submission from before types were recorded): both slots, named plainly.
  return {
    type: type ?? null,
    label: fallback,
    pages: [
      { slot: slots[0], label: 'First page', required: true },
      { slot: slots[1], label: 'Second page', required: false },
    ],
  };
}

/**
 * The broker's own questions, grouped by the step they were asked on — as
 * they were asked when the client submitted, else as the form asks them now —
 * then every answer the client gave to a question no longer listed.
 */
function additionalSections(
  steps: readonly KycStepConfig[],
  submission: Pick<KycSubmission, 'personalInfo' | 'stepData' | 'formSnapshot'>,
  recorded: RecordedLabels,
): KycReviewSection[] {
  const asked: KycFormSnapshot =
    submission.formSnapshot ??
    steps
      .filter((step) => step.enabled && step.slug !== REVIEW_SLUG)
      .map((step) => ({
        slug: step.slug,
        title: step.title,
        fields: step.fields
          .filter((field) => !isPlatformField(step.slug, field))
          .map(({ name, label, type }) => ({ name, label, type })),
      }))
      .filter((step) => step.fields.length > 0);

  const sections: KycReviewSection[] = asked.map((step) => ({
    slug: step.slug,
    title: step.title,
    fields: step.fields.map((field) => ({ ...field, step: step.slug })),
  }));

  const listed = new Set(sections.flatMap((s) => s.fields.map((f) => `${f.step}\u0000${f.name}`)));
  const unlisted: KycReviewField[] = [];
  // A removed question keeps the name it was last given (0148) — and its type, so
  // a checkbox still reads Yes/No and a date as a date.
  const consider = (step: string, name: string, value: unknown) => {
    if (listed.has(`${step}\u0000${name}`)) return;
    const known = recorded.get(name);
    unlisted.push({
      name,
      label: known?.label ?? UNRECORDED_QUESTION,
      type: isStoredFile(value) ? 'file' : (known?.type ?? 'text'),
      step,
    });
  };
  for (const [name, value] of Object.entries(submission.personalInfo ?? {})) {
    if (!isProfileKey(name)) consider('personal', name, value);
  }
  for (const [step, answers] of Object.entries(submission.stepData ?? {})) {
    for (const [name, value] of Object.entries(answers ?? {})) consider(step, name, value);
  }
  if (unlisted.length > 0) {
    sections.push({
      slug: 'unlisted',
      title: 'Answers to questions no longer on the form',
      fields: unlisted,
    });
  }
  return sections;
}

/**
 * A returned item as every screen and the email name it: "National ID (Back
 * Side)", "Date of Birth", the broker's own label — never `doc_back`.
 */
export function flagLabel(
  id: string,
  steps: readonly KycStepConfig[],
  submission: Pick<KycSubmission, 'document' | 'addressProof'>,
  additional: readonly KycReviewSection[] = [],
): string {
  const identity = identityField(id);
  if (identity) return identity.label;
  const own = additional.flatMap((section) => section.fields).find((field) => field.name === id);
  if (own) return own.label;
  const label = documentFlagLabel(id, steps, {
    document: submission.document ?? undefined,
    addressProof: submission.addressProof ?? undefined,
  });
  return label === id ? humanise(id) : label;
}

/** `customField_1790402959161` → "Custom Field 1790402959161"; `sourceOfFunds` → "Source Of Funds". */
function humanise(key: string): string {
  const words = key
    .replace(/_+/g, ' ')
    .replace(/([a-z])([A-Z0-9])/g, '$1 $2')
    .trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}
