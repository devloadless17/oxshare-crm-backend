/**
 * THE one answer to "is this step done, and if not, what is missing?" — a pure
 * seam, beside `kyc-profile.ts` and `kyc-document-rules.ts`.
 *
 * ## Why this exists: two judges disagreed, and the client paid for it
 *
 * The portal decided whether a step was complete with its own copy of the
 * rules — for Continue, for where a returning client resumes, for the review
 * screen — and `submit` decided with another. Every copy drifted from the
 * other at some point, and each drift reached a client as a contradiction:
 * Continue let them through and the last screen refused ("custom1 is
 * incomplete: natID, drivL…"); the review said "Passport — Missing" beside a
 * complete national ID; a required upload blocked nothing because the only
 * check for it was in a place that could not see it (reported from local
 * testing, 23–25 Sep 2026).
 *
 * So there is one judge now. `submit` refuses what this says is incomplete,
 * `GET /kyc/status` and `POST /kyc/step` carry what it says for every step, and
 * the portal renders that verdict instead of re-deriving it.
 *
 * ## What each step owes
 *
 *   document · address  a CHOICE of document, then every required page of it
 *   selfie              the selfie, always — the step is there to take one
 *   personal            the client's IDENTITY, by the platform's rules
 *                       (`identityProblems` — the profile writer's own checks:
 *                       every missing field, every unacceptable one), then the
 *                       broker's own questions
 *   every step          the broker's own fields: a required answer must be given
 *                       (a required checkbox ticked, a drop-down answered from
 *                       its list), a required upload present
 *
 * Nothing the builder configures decides the identity rules (26 Sep 2026): the
 * required set and the minimum age used to be read from the personal step's
 * fields, so deleting the date-of-birth field switched the age check off.
 *
 * ## Returned by the reviewer
 *
 * A flag the client has not answered is listed on the step that holds it. A
 * DOCUMENT flag blocks until a new file arrives; a typed answer's flag is shown
 * but does not block — `kyc-document-rules.ts` says why.
 */
import { catalogueDocument } from '../../common/kyc/document-catalogue';
import {
  documentFlagLabel,
  isPageOfStored,
  missingRequiredPages,
  outstandingDocumentFlags,
} from './kyc-document-rules';
import { isPlatformField } from '../../common/kyc/identity-core';
import { identityProblems, isAnswered } from './kyc-profile';
import { isStoredFile } from './step-slugs';

/** What is owed — each kind reads differently to the client. */
export type OwedKind = 'choice' | 'page' | 'upload' | 'answer' | 'invalid' | 'returned';

export interface Owed {
  /**
   * What the portal matches it to: a field's name, a canonical page slot
   * (`doc_back`), or `docType` for the choice of document.
   */
  id: string;
  /** Ready to print: "Phone Number", "National ID: Back Side". */
  label: string;
  kind: OwedKind;
  /** For `invalid`: why, ready to print, and the machine-readable reason. */
  message?: string;
  code?: string;
  /** For `returned`: whether it stops the step (documents) or only asks (answers). */
  blocking?: boolean;
}

export interface StepState {
  slug: string;
  complete: boolean;
  /** What the client still owes, in the order the step shows it. */
  missing: Owed[];
  /** What the reviewer returned here that the client has not answered yet. */
  returned: Owed[];
}

/** The part of a configured field read here — structural, so fixtures stay small. */
export interface StateField {
  name: string;
  label: string;
  type: string;
  required: boolean;
  options?: readonly string[];
}

export interface StateStep {
  slug: string;
  title: string;
  enabled: boolean;
  fields: readonly StateField[];
}

/** The part of a submission read here. */
export interface StateSubmission {
  /** A typed interface where it is stored, read here as the answers it holds. */
  personalInfo?: object | null;
  document?: { docType?: string; frontFilePath?: string; backFilePath?: string } | null;
  selfie?: { filePath?: string } | null;
  addressProof?: { docType?: string; filePath?: string; page2FilePath?: string } | null;
  stepData?: Record<string, Record<string, unknown>> | null;
  rejectedFields?: readonly string[] | null;
}

/**
 * The document a client is PRESENTING on a document step when it is not the one
 * on file — they picked another card and pressed Continue. Its pages are not
 * the stored ones, which belong to the other document, so every required page
 * of it is owed. Judged, never stored: see `saveStep`.
 */
export interface ChosenDocument {
  slug: string;
  docType: string;
}

const PAGE_SLOTS: Readonly<Record<string, readonly [string, string]>> = {
  document: ['doc_front', 'doc_back'],
  address: ['address_proof', 'address_proof_2'],
};

/** The slots and category a step's catalogue document is filed under, if it has one. */
function documentSlotsOf(slug: string): readonly [string, string] | undefined {
  return Object.prototype.hasOwnProperty.call(PAGE_SLOTS, slug) ? PAGE_SLOTS[slug] : undefined;
}

/** An upload the client makes into a field of its own — not a catalogue document's page. */
export function isPlainUpload(field: { type?: string }): boolean {
  return field.type === 'file' || field.type === 'camera';
}

function isDocument(field: { type?: string }): boolean {
  return (field.type ?? '').startsWith('doc:');
}

/** The canonical selfie: the field the selfie step takes its one photo with. */
function isCanonicalSelfie(step: { slug: string }, field: { name: string }): boolean {
  return step.slug === 'selfie' && field.name === 'selfie';
}

/**
 * Every enabled step's state, in the configured order. `review` collects
 * nothing and has none.
 */
export function stepStates(
  steps: readonly StateStep[],
  submission: StateSubmission,
  now: Date,
  chosen?: ChosenDocument,
): StepState[] {
  const blocking = new Set(
    outstandingDocumentFlags(submission.rejectedFields ?? undefined, steps, storedOf(submission)),
  );
  return steps
    .filter((step) => step.enabled && step.slug !== 'review')
    .map((step) => {
      const missing = [
        ...documentOwed(step, submission, chosen),
        ...fieldsOwed(step, submission, now),
      ];
      const returned = returnedOn(step, steps, submission, blocking);
      return {
        slug: step.slug,
        complete: missing.length === 0 && !returned.some((item) => item.blocking),
        missing,
        returned,
      };
    });
}

/**
 * What APPROVAL re-asks (the owner's plan, 26 Sep 2026): the evidence a
 * verification rests on — a complete, adult identity, the identity document's
 * required pages, and the proof of address and the selfie when they are asked
 * for. Everything `stepStates` owes, less the broker's own questions and uploads.
 *
 * Those were judged when the client submitted. Re-asked at approval, a question
 * a broker adds on a Tuesday would strand every submission already waiting —
 * none of them could be approved until each client came back to answer
 * something the verification does not rest on.
 */
export function approvalBlockers(
  steps: readonly StateStep[],
  submission: StateSubmission,
  now: Date,
): Owed[] {
  const brokersOwn = new Set(
    steps.flatMap((step) =>
      step.fields
        .filter((field) => !isDocument(field) && !isPlatformField(step.slug, field))
        .map((field) => `${step.slug}:${field.name}`),
    ),
  );
  return stepStates(steps, submission, now).flatMap((state) =>
    state.missing.filter((item) => !brokersOwn.has(`${state.slug}:${item.id}`)),
  );
}

/** The choice of document and its pages, on the two document steps. */
function documentOwed(
  step: StateStep,
  submission: StateSubmission,
  chosen: ChosenDocument | undefined,
): Owed[] {
  const slots = documentSlotsOf(step.slug);
  if (!slots) return [];
  const category = step.slug === 'document' ? 'identity' : 'address';
  const stored = category === 'identity' ? submission.document : submission.addressProof;
  const files =
    category === 'identity'
      ? [submission.document?.frontFilePath, submission.document?.backFilePath]
      : [submission.addressProof?.filePath, submission.addressProof?.page2FilePath];

  const presenting = chosen?.slug === step.slug ? chosen.docType : stored?.docType;
  // A submission from before a type was recorded: its first page stands for it,
  // as `missingRequiredPage` has always read it.
  if (!presenting) {
    return files[0] ? [] : [{ id: 'docType', label: step.title, kind: 'choice' }];
  }
  // Pages on file belong to the stored document — never to another one.
  const own = presenting === stored?.docType ? files : [];
  const fallback = category === 'identity' ? 'Identity document' : 'Proof of address';
  const entry = catalogueDocument(presenting);
  return missingRequiredPages({ docType: presenting, files: own }, category).map((page) => ({
    id: slots[page.index] ?? slots[0],
    label: page.label ?? entry?.label ?? fallback,
    kind: 'page' as const,
  }));
}

/** The step's own fields: required answers and uploads, and unacceptable answers. */
function fieldsOwed(step: StateStep, submission: StateSubmission, now: Date): Owed[] {
  const typed = (
    step.slug === 'personal' ? submission.personalInfo : submission.stepData?.[step.slug]
  ) as Record<string, unknown> | null | undefined;
  const files = submission.stepData?.[step.slug];
  const owed: Owed[] = [];

  /*
   * The selfie is owed whenever the step is ENABLED — whatever its fields say,
   * even with none. The step exists to take it, and `submit` has always asked
   * for it on exactly that condition.
   */
  if (step.slug === 'selfie' && !submission.selfie?.filePath) {
    const label = step.fields.find((field) => isCanonicalSelfie(step, field))?.label;
    owed.push({ id: 'selfie', label: label || 'Selfie', kind: 'upload' });
  }

  /*
   * THE IDENTITY, by the platform's rules and nothing the builder configures:
   * every required field that is missing, and every value the profile writer
   * would refuse — all of them, in the order the form shows them.
   */
  if (step.slug === 'personal') {
    for (const problem of identityProblems(typed ?? undefined, now)) {
      owed.push(
        problem.kind === 'missing'
          ? { id: problem.key, label: problem.label, kind: 'answer' }
          : {
              id: problem.key,
              label: problem.label,
              kind: 'invalid',
              message: problem.message,
              code: problem.code,
            },
      );
    }
  }

  for (const field of step.fields) {
    // The platform's own — the identity above, the documents and the selfie
    // camera by their own rules — never by a flag the builder set.
    if (isDocument(field) || isPlatformField(step.slug, field)) continue;
    if (!field.required) continue;
    if (isPlainUpload(field)) {
      if (!isStoredFile(files?.[field.name])) {
        owed.push({ id: field.name, label: field.label || field.name, kind: 'upload' });
      }
    } else if (!isAnswered(field, typed?.[field.name])) {
      owed.push({ id: field.name, label: field.label || field.name, kind: 'answer' });
    }
  }

  return owed;
}

/** The documents on file, as the flag rules read them. */
function storedOf(submission: StateSubmission) {
  return {
    document: submission.document ?? undefined,
    addressProof: submission.addressProof ?? undefined,
  };
}

/** The reviewer's unanswered flags that belong to this step. */
function returnedOn(
  step: StateStep,
  steps: readonly StateStep[],
  submission: StateSubmission,
  blocking: ReadonlySet<string>,
): Owed[] {
  const ids = new Set(step.fields.map((field) => field.name));
  for (const slot of documentSlotsOf(step.slug) ?? []) ids.add(slot);
  if (step.slug === 'selfie') ids.add('selfie');

  const stored = storedOf(submission);
  return (
    (submission.rejectedFields ?? [])
      // A page the document on file does not have belonged to one the client
      // replaced — not "returned" to them any more, in any sense.
      .filter((id) => ids.has(id) && isPageOfStored(id, stored))
      .map((id) => ({
        id,
        label: documentFlagLabel(id, steps, stored),
        kind: 'returned' as const,
        blocking: blocking.has(id),
      }))
  );
}
