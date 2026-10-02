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
 * ## Replacing the whole document is an answer too (28 Sep 2026)
 *
 * A page flag names a SLOT, and another document may not have that slot: a
 * passport has no back, a utility bill no second page. Reported: return a
 * national ID's back, or a tenancy agreement's additional page, and let the
 * client switch to a passport or a utility bill. The upload replaced the
 * document, deleting every old page, yet only its own slot's flag was settled.
 * The other flag stood on a page the new document does not have, nothing could
 * settle it, and it was named after the NEW document ("Please upload a new
 * Passport — the reviewer returned the one on file"). The only way on was to
 * re-send the very document the client had moved away from. So a page of
 * another document settles every page flag of the one it replaces, and a flag
 * on a page the document on file does not have is owed by nobody.
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
import {
  DOCUMENT_PAGE_SLOTS,
  evidenceStepOfSlot,
  pageIndexOfSlot,
  type EvidenceStep,
} from '../../common/kyc/identity-core';
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

/** A canonical upload slot's step — the one definition in identity-core. */
const canonicalStepOf = evidenceStepOfSlot;

/**
 * The flags an upload into `field` settles.
 *
 * The slot itself, and — for a canonical slot — any flag naming a whole
 * document of that step (`nationalId`, `utilityBill`), because a new page of the
 * document is the reply to "this document is not acceptable". A custom step's
 * file field IS its own flag.
 *
 * `replacesDocument`: the page is of a DIFFERENT document than the one on file,
 * so the upload replaces that document whole (`placePage` starts it afresh and
 * its old pages are deleted). Every page flag on the step goes with it — the
 * returned file no longer exists, and the new document is judged on its own
 * pages. See "Replacing the whole document" above.
 */
export function flagsSettledByUpload(
  field: string,
  steps: readonly RuleStep[],
  replacesDocument = false,
): string[] {
  const slug = canonicalStepOf(field);
  if (!slug) return [field];
  const wholeDocuments = steps
    .filter((step) => step.slug === slug)
    .flatMap((step) => step.fields.filter(isFileField).map((f) => f.name));
  if (!replacesDocument) return [field, ...wholeDocuments];
  return [...new Set([field, ...pageSlotsOf(slug), ...wholeDocuments])];
}

/**
 * The flags in `rejectedFields` that name a document the client still owes.
 *
 * Only for a step that is still ENABLED: a flag on a document the broker has
 * since stopped asking for could never be settled, and would leave the client
 * unable to resubmit at all.
 *
 * And only for a PAGE the document on file has (`isPageOfStored`), for the same
 * reason: the back of a national ID the client has replaced with a passport can
 * never be uploaded again. An upload of another document settles those flags
 * now; this is also what frees a submission flagged before that.
 */
export function outstandingDocumentFlags(
  rejectedFields: readonly string[] | undefined,
  steps: readonly RuleStep[],
  stored: StoredDocumentTypes = {},
): string[] {
  const enabled = steps.filter((step) => step.enabled);
  const enabledSlugs = new Set(enabled.map((step) => step.slug));
  const fileFields = new Set(
    enabled.flatMap((step) => step.fields.filter(isFileField).map((f) => f.name)),
  );
  return (rejectedFields ?? []).filter((id) => {
    const slug = canonicalStepOf(id);
    if (!slug) return fileFields.has(id);
    return enabledSlugs.has(slug) && isPageOfStored(id, stored);
  });
}

/**
 * Whether a canonical page slot is a page of the document ON FILE — `doc_back`
 * is not a page of a passport, `address_proof_2` not a page of a utility bill.
 *
 * A type the catalogue does not know, or none recorded, keeps every slot: only a
 * catalogue document says how many pages it has, and forgiving a flag on a
 * guess would let a returned file go back unanswered.
 */
export function isPageOfStored(id: string, stored: StoredDocumentTypes): boolean {
  const slug = canonicalStepOf(id);
  if (slug !== 'document' && slug !== 'address') return true;
  const type = slug === 'document' ? stored.document?.docType : stored.addressProof?.docType;
  const entry = type ? catalogueDocument(type) : undefined;
  if (!entry) return true;
  return pageIndexOfSlot(id) < entry.parts.length;
}

/**
 * A reviewer's flags, with a WHOLE document named as its PAGES.
 *
 * The reject dialog names a canonical document's page by its slot
 * (`doc_back`), and a whole document by its field name (`nationalId`) when it
 * could not see which pages were sent. A whole-document flag was then settled
 * by ANY upload on the step — replace the back of a refused national ID and
 * the flag on its front went with it, unanswered. As pages, each flag is
 * settled by its own new file, and "this document is not acceptable" means
 * what it says: every page of it again.
 */
export function asPageFlags(flags: readonly string[], steps: readonly RuleStep[]): string[] {
  const pages = flags.flatMap((id) => {
    for (const step of steps) {
      const slots =
        step.slug === 'document' || step.slug === 'address'
          ? DOCUMENT_PAGE_SLOTS[step.slug]
          : undefined;
      const field = slots && step.fields.find((f) => f.name === id && f.type.startsWith('doc:'));
      if (!slots || !field) continue;
      const entry = catalogueDocument(field.type.slice('doc:'.length));
      return entry ? entry.parts.map((_, index) => slots[index]).filter(Boolean) : [slots[0]];
    }
    return [id];
  });
  return [...new Set(pages)];
}

/** Every page slot of a document step's document; none for the selfie. */
function pageSlotsOf(slug: EvidenceStep): readonly string[] {
  return slug === 'selfie' ? [] : DOCUMENT_PAGE_SLOTS[slug];
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
    const page = pageIndexOfSlot(id);
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
  return missingRequiredPages(stored, category)[0];
}

/** Every required page with no file, in page order — `missingRequiredPage` is the first. */
export function missingRequiredPages(
  stored: StoredDocument,
  category: 'identity' | 'address',
): MissingPage[] {
  const entry = stored.docType ? catalogueDocument(stored.docType) : undefined;
  if (!entry || entry.category !== category) {
    return stored.files[0] ? [] : [{ index: 0 }];
  }
  return entry.parts.flatMap((part, index) =>
    part.required && !stored.files[index]
      ? [{ index, label: `${entry.label}: ${part.label}` }]
      : [],
  );
}
