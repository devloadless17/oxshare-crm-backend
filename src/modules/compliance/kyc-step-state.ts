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
import {
  identityField,
  isPlatformField,
  withPolicy,
  type FormPolicy,
} from '../../common/kyc/identity-core';
import { pickLocalized } from '../../common/i18n/locale';
import { isProfileKey } from '../../common/profile/client-profile';
import { identityProblems, isAnswered } from './kyc-profile';
import { isStoredFile } from './step-slugs';
import { localizeMessage } from '../../common/i18n/localize-message';
import { requestLocale } from '../../common/i18n/locale';

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
  /** The label in Arabic (0179) — what an Arabic reader is told is owed. */
  labelAr?: string;
  type: string;
  required: boolean;
  options?: readonly string[];
}

export interface StateStep {
  slug: string;
  title: string;
  titleAr?: string;
  enabled: boolean;
  fields: readonly StateField[];
  /** An evidence step whose evidence the client may skip (Phase 2). */
  evidenceRequired?: boolean;
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
  /** The requirements the submission was made under (0158) — approval re-checks these. */
  formPolicy?: FormPolicy | null;
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
  // The form AS SUBMITTED: a broker who tightened it since (a detail made
  // required, evidence no longer optional) must not strand what already waits.
  const asSubmitted = submission.formPolicy ? withPolicy(steps, submission.formPolicy) : steps;
  const brokersOwn = new Set(
    asSubmitted.flatMap((step) =>
      step.fields
        .filter((field) => !isDocument(field) && !isPlatformField(step.slug, field))
        .map((field) => `${step.slug}:${field.name}`),
    ),
  );
  return stepStates(asSubmitted, submission, now).flatMap((state) =>
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
    // Optional evidence (Phase 2): not started is skipped, and owes nothing.
    if (step.evidenceRequired === false) return [];
    return files[0]
      ? []
      : [{ id: 'docType', label: pickLocalized(step.title, step.titleAr), kind: 'choice' }];
  }
  // Pages on file belong to the stored document — never to another one.
  const own = presenting === stored?.docType ? files : [];
  // A document merely CHOSEN, with no page yet, is not started either.
  if (step.evidenceRequired === false && !own.some(Boolean)) return [];
  const fallback = category === 'identity' ? 'Identity document' : 'Proof of address';
  const entry = catalogueDocument(presenting);
  // The same name in Arabic (0179), from the catalogue: "بطاقة الهوية الوطنية: الوجه الخلفي".
  const arabic = (page: { index: number; label?: string }) => {
    const part = page.label ? entry?.parts[page.index] : undefined;
    if (entry && part) return `${entry.labelAr}: ${part.labelAr}`;
    return entry?.labelAr ?? (category === 'identity' ? 'وثيقة الهوية' : 'إثبات العنوان');
  };
  const locale = requestLocale();
  return missingRequiredPages({ docType: presenting, files: own }, category).map((page) => ({
    id: slots[page.index] ?? slots[0],
    label: pickLocalized(page.label ?? entry?.label ?? fallback, arabic(page), locale),
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
   * The selfie is owed whenever the step is ENABLED and its evidence required —
   * whatever its fields say, even with none. The step exists to take it; since
   * Phase 2 the broker may make it optional.
   */
  if (step.slug === 'selfie' && step.evidenceRequired !== false && !submission.selfie?.filePath) {
    const camera = step.fields.find((field) => isCanonicalSelfie(step, field));
    owed.push({
      id: 'selfie',
      label: pickLocalized(camera?.label || 'Selfie', camera?.labelAr || 'صورة سيلفي'),
      kind: 'upload',
    });
  }

  /*
   * THE IDENTITY, by the platform's rules and nothing the builder configures:
   * every required field that is missing, and every value the profile writer
   * would refuse — all of them, in the order the form shows them.
   */
  if (step.slug === 'personal') {
    const asked = step.fields
      .filter((field) => isProfileKey(field.name))
      .map((field) => ({ name: field.name, required: field.required }));
    for (const problem of identityProblems(typed ?? undefined, now, asked)) {
      // The platform's own name for the detail, in the reader's language (0179).
      const label = pickLocalized(problem.label, identityField(problem.key)?.labelAr);
      owed.push(
        problem.kind === 'missing'
          ? { id: problem.key, label, kind: 'answer' }
          : {
              id: problem.key,
              label,
              kind: 'invalid',
              // Printed as is by the portal, so in the client's language.
              message: localizeMessage(problem.message, requestLocale()),
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
      if (!isStoredFile(files?.[field.name] ?? answerElsewhere(submission, field.name))) {
        owed.push({ id: field.name, label: ownLabel(field), kind: 'upload' });
      }
    } else if (!isAnswered(field, typed?.[field.name] ?? answerElsewhere(submission, field.name))) {
      owed.push({ id: field.name, label: ownLabel(field), kind: 'answer' });
    }
  }

  return owed;
}

/** A broker's field as the client reads it: its Arabic label when asked in Arabic (0179). */
function ownLabel(field: StateField): string {
  return pickLocalized(field.label || field.name, field.labelAr);
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
        label: documentFlagLabel(id, steps, stored, requestLocale()),
        kind: 'returned' as const,
        blocking: blocking.has(id),
      }))
  );
}

/**
 * An answer given where a question USED to be. The broker may move a question of
 * theirs to another step (Phase 2); keys are unique across the form, so the
 * answer the client already gave is still theirs, found by its key.
 */
export function answerElsewhere(submission: StateSubmission, name: string): unknown {
  for (const answers of Object.values(submission.stepData ?? {})) {
    if (answers && Object.prototype.hasOwnProperty.call(answers, name)) return answers[name];
  }
  const personal = submission.personalInfo as Record<string, unknown> | null | undefined;
  return personal && Object.prototype.hasOwnProperty.call(personal, name)
    ? personal[name]
    : undefined;
}

/**
 * The submission with every answer where the form asks for it NOW — a moved
 * question's answer copied to its new step — so the client finds it filled in.
 */
export function answersInPlace<S extends StateSubmission>(
  steps: readonly StateStep[],
  submission: S,
): S {
  const stepData = { ...(submission.stepData ?? {}) };
  const personalInfo = { ...((submission.personalInfo as Record<string, unknown> | null) ?? {}) };
  for (const step of steps) {
    for (const field of step.fields) {
      if (isDocument(field) || isPlatformField(step.slug, field)) continue;
      const inPersonal = step.slug === 'personal' && !isPlainUpload(field);
      const home = inPersonal ? personalInfo : (stepData[step.slug] ?? {});
      if (Object.prototype.hasOwnProperty.call(home, field.name)) continue;
      const found = answerElsewhere(submission, field.name);
      if (found === undefined) continue;
      if (inPersonal) personalInfo[field.name] = found;
      else stepData[step.slug] = { ...(stepData[step.slug] ?? {}), [field.name]: found };
    }
  }
  return { ...submission, stepData, personalInfo };
}
