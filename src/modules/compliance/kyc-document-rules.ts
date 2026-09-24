/**
 * Which documents a submission still owes, and which flags an upload settles —
 * a pure seam, beside `kyc-profile.ts` and `kyc-answers.ts`.
 *
 * ## A returned document had to be replaced, and nothing said so
 *
 * A reviewer can return a submission naming what is wrong (`rejectedFields`).
 * For a typed field the portal drew the box red. For a DOCUMENT it drew nothing
 * — the tile kept its green "uploaded" state — and the server accepted a
 * resubmission with the very file the reviewer had just refused. Reported from
 * production: reject a passport, and the client is never told it was the
 * passport.
 *
 * So a document flag now means what the reviewer meant by it: that file is not
 * acceptable, and the submission cannot go back until it is replaced. Uploading
 * into the flagged slot settles the flag (`flagsSettledByUpload`); submitting
 * with one still standing is refused, naming the documents
 * (`outstandingDocumentFlags` + `documentFlagLabel`).
 *
 * A TYPED field's flag is highlighted and settled when its value changes, but it
 * does not block: a reviewer who flagged a date of birth because the passport
 * was unreadable may be satisfied by a clearer passport and the SAME date, and
 * refusing that would leave a correct client with no way to resubmit.
 *
 * ## The two vocabularies of a flag
 *
 * The reject dialog names a canonical document's PAGE by its storage id
 * (`doc_front`, `address_proof_2`) and anything else by its configured field
 * name — a custom step's upload, or a whole document when the dialog could not
 * see which pages were sent. Both are live, so both are understood here.
 */
import { catalogueDocument } from '../../common/kyc/document-catalogue';
import { isFileField } from './step-slugs';

/** The part of a configured step these rules read — structural, so fixtures stay small. */
export interface RuleStep {
  slug: string;
  enabled: boolean;
  fields: readonly RuleField[];
}

export interface RuleField {
  name: string;
  label: string;
  type: string;
  /** Resolved from `doc:<value>` when the config is served. */
  document?: { value: string };
}

/** A canonical upload slot, and the step whose files it holds. */
export const CANONICAL_FILE_STEP: Readonly<Record<string, 'document' | 'selfie' | 'address'>> = {
  doc_front: 'document',
  doc_back: 'document',
  selfie: 'selfie',
  address_proof: 'address',
  address_proof_2: 'address',
};

function canonicalStepOf(id: string): 'document' | 'selfie' | 'address' | undefined {
  return Object.prototype.hasOwnProperty.call(CANONICAL_FILE_STEP, id)
    ? CANONICAL_FILE_STEP[id]
    : undefined;
}

/**
 * The flags an upload into `field` settles.
 *
 * The slot itself, and — for a canonical slot — any flag naming a whole
 * document of that step (`nationalId`, `utilityBill`), because a new page of the
 * document is the reply to "this document is not acceptable". A custom step's
 * file field IS its own flag.
 */
export function flagsSettledByUpload(field: string, steps: readonly RuleStep[]): string[] {
  const slug = canonicalStepOf(field);
  if (!slug) return [field];
  const wholeDocuments = steps
    .filter((step) => step.slug === slug)
    .flatMap((step) => step.fields.filter(isFileField).map((f) => f.name));
  return [field, ...wholeDocuments];
}

/**
 * The flags in `rejectedFields` that name a document the client still owes.
 *
 * Only for a step that is still ENABLED: a flag on a document the broker has
 * since stopped asking for could never be settled, and would leave the client
 * unable to resubmit at all.
 */
export function outstandingDocumentFlags(
  rejectedFields: readonly string[] | undefined,
  steps: readonly RuleStep[],
): string[] {
  const enabled = steps.filter((step) => step.enabled);
  const enabledSlugs = new Set(enabled.map((step) => step.slug));
  const fileFields = new Set(
    enabled.flatMap((step) => step.fields.filter(isFileField).map((f) => f.name)),
  );
  return (rejectedFields ?? []).filter((id) => {
    const slug = canonicalStepOf(id);
    return slug ? enabledSlugs.has(slug) : fileFields.has(id);
  });
}

/** The half of a submission `documentFlagLabel` reads. */
export interface StoredDocumentTypes {
  document?: { docType?: string };
  addressProof?: { docType?: string };
}

/**
 * A flag as the client should read it: "National ID (Back Side)", "Selfie
 * Photo", or a custom field's own label — never `doc_back`.
 */
export function documentFlagLabel(
  id: string,
  steps: readonly RuleStep[],
  stored: StoredDocumentTypes,
): string {
  const slug = canonicalStepOf(id);
  const fields = steps.flatMap((step) => step.fields);

  if (slug === 'selfie') {
    const selfie = steps.find((step) => step.slug === 'selfie')?.fields.find(isFileField);
    return selfie?.label ?? 'Selfie';
  }

  if (slug === 'document' || slug === 'address') {
    const type = slug === 'document' ? stored.document?.docType : stored.addressProof?.docType;
    const entry = type ? catalogueDocument(type) : undefined;
    // Only a DOCUMENT field can name it — with no stored type, `undefined ===
    // undefined` would otherwise pick the first typed field on the step.
    const configured = type
      ? steps.find((step) => step.slug === slug)?.fields.find((f) => f.document?.value === type)
      : undefined;
    const name =
      configured?.label ??
      entry?.label ??
      (slug === 'document' ? 'Identity document' : 'Proof of address');
    const page = id === 'doc_back' || id === 'address_proof_2' ? 1 : 0;
    const part = entry && entry.parts.length > 1 ? entry.parts[page] : undefined;
    return part ? `${name} (${part.label})` : name;
  }

  return fields.find((f) => f.name === id)?.label ?? id;
}

/** One canonical document as stored: its type and the files of its pages, in order. */
export interface StoredDocument {
  docType?: string;
  files: readonly (string | undefined)[];
}

/** A required page with no file: its position, and how to name it when it is not the first. */
export interface MissingPage {
  index: number;
  /** "National ID: Back Side". Absent for a document the catalogue does not know. */
  label?: string;
}

/**
 * The first REQUIRED page of a stored document that has no file, or `undefined`
 * when every required page is there.
 *
 * `submit` asked only for the first page, so a national ID with no back — a
 * two-sided card with half its data — went to the queue as complete. The pages
 * come from the catalogue, the same place the portal's upload slots come from,
 * so the two cannot disagree about how many a document has.
 *
 * A type the catalogue does not know (a submission from before it existed)
 * falls back to the old rule: the first page is required.
 */
export function missingRequiredPage(
  stored: StoredDocument,
  category: 'identity' | 'address',
): MissingPage | undefined {
  const entry = stored.docType ? catalogueDocument(stored.docType) : undefined;
  if (!entry || entry.category !== category) {
    return stored.files[0] ? undefined : { index: 0 };
  }
  const index = entry.parts.findIndex((part, i) => part.required && !stored.files[i]);
  if (index === -1) return undefined;
  return { index, label: `${entry.label}: ${entry.parts[index].label}` };
}
