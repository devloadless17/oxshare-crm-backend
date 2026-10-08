import type { KycFieldConfig, KycStepConfig } from '../../store/kyc-config.store';
import type { KycStatus, KycSubmission } from '../../store/kyc.store';
import {
  acceptedDocuments,
  DOCUMENT_PAGE_SLOTS,
  isDocumentField,
} from '../../common/kyc/identity-core';
import { isPlainUpload, type Owed, type StepState } from './kyc-step-state';

/**
 * "COMPLETE KYC" — the page staff fill a client's KYC on, laid out by the
 * SERVER (0210, 8 Oct 2026).
 *
 * Non-technical clients (elderly people, anyone who struggles) sign up and then
 * cannot do the KYC. Staff now do it FOR them through the client's own actions
 * (`KycClientService`), so every rule is the client's. This file decides only
 * how the page LOOKS, and it decides it here rather than in the console for the
 * reason the review page is laid out here (`kyc-review-layout.ts`): the rules
 * that decide which document has which pages, which upload slot a page goes to
 * and what is still owed broke in production more than once while they were
 * written separately in the portal and the console. The console renders this;
 * it never derives a slot, a page or a verdict.
 *
 * PURE: no Nest, no database. Values are NOT here — the answers stay in the
 * masked maps beside it (`personalInfo`, `stepData`), so RBAC-03 hides them
 * exactly as it hides them on the review page. What is here is structure, the
 * judge's verdict, and the references of the pages on file.
 */

/** The statuses in which the KYC is still open — the client's, and so staff's on their behalf. */
export const OPEN_FOR_CHANGES: readonly KycStatus[] = ['not_started', 'in_progress', 'rejected'];

/** Where an upload goes — sent back exactly as given (`POST …/assist/upload`). */
export interface AssistTarget {
  field: string;
  docType?: string;
}

/** One upload slot: where it goes, the file on file, and whether the reviewer returned it. */
export interface AssistUpload {
  target: AssistTarget;
  filePath?: string;
  returned: boolean;
}

/** One page of a catalogue document ("Front", "Back"). */
export interface AssistPage extends AssistUpload {
  key: string;
  label: string;
  required: boolean;
  hint?: string;
}

export interface AssistDocumentType {
  value: string;
  label: string;
  pages: AssistPage[];
}

/** A document step's evidence: the types the broker accepts, and the one on file. */
export interface AssistDocument {
  category: 'identity' | 'address';
  /** The document on file — or chosen with nothing uploaded yet. */
  docType?: string;
  /** The broker made this step's evidence optional (Phase 2). */
  optional: boolean;
  types: AssistDocumentType[];
}

/** A question on the form. Its VALUE is read from the masked maps, never from here. */
export interface AssistField {
  name: string;
  label: string;
  type: string;
  required: boolean;
  options?: string[];
  hint?: string;
  /** One of the client's identity details — its value IS the client's profile. */
  system?: boolean;
  /** Hidden from this reader by their role (RBAC-03): shown as hidden, never sent. */
  hidden: boolean;
  /** For an upload question: its slot. */
  upload?: AssistUpload;
}

export interface AssistStep {
  slug: string;
  title: string;
  description?: string;
  complete: boolean;
  missing: Owed[];
  returned: Owed[];
  fields: AssistField[];
  document?: AssistDocument;
  selfie?: AssistUpload & { optional: boolean };
}

export interface AssistLayout {
  /** The KYC may still be changed — not waiting for review, not approved. */
  editable: boolean;
  /** Every step has everything it needs: Submit would be accepted. */
  complete: boolean;
  steps: AssistStep[];
}

function filePathOf(answer: unknown): string | undefined {
  return typeof answer === 'object' && answer !== null && 'filePath' in answer
    ? typeof answer.filePath === 'string'
      ? answer.filePath
      : undefined
    : undefined;
}

/** The pages on file of a document step, in page order. */
function storedPages(slug: 'document' | 'address', view: KycSubmission) {
  if (slug === 'document') {
    return {
      docType: view.document?.docType,
      pages: [view.document?.frontFilePath, view.document?.backFilePath],
    };
  }
  return {
    docType: view.addressProof?.docType,
    pages: [view.addressProof?.filePath, view.addressProof?.page2FilePath],
  };
}

function documentOf(
  step: KycStepConfig,
  slug: 'document' | 'address',
  view: KycSubmission,
  returned: ReadonlySet<string>,
): AssistDocument | undefined {
  const category = slug === 'document' ? 'identity' : 'address';
  const accepted = acceptedDocuments(step.fields, category);
  if (accepted.length === 0) return undefined;
  const slots = DOCUMENT_PAGE_SLOTS[slug];
  const stored = storedPages(slug, view);
  return {
    category,
    docType: stored.docType,
    optional: step.evidenceRequired === false,
    types: accepted.map((doc) => {
      const onFile = stored.docType === doc.value;
      return {
        value: doc.value,
        label: doc.label,
        pages: doc.parts.map((part, index) => ({
          key: part.key,
          label: part.label,
          required: part.required,
          ...(part.hint ? { hint: part.hint } : {}),
          target: { field: slots[index], docType: doc.value },
          ...(onFile && stored.pages[index] ? { filePath: stored.pages[index] } : {}),
          returned: onFile && returned.has(slots[index]),
        })),
      };
    }),
  };
}

function fieldOf(
  step: KycStepConfig,
  field: KycFieldConfig,
  view: KycSubmission,
  returned: ReadonlySet<string>,
  hidden: boolean,
): AssistField {
  const filePath = isPlainUpload(field)
    ? filePathOf(view.stepData?.[step.slug]?.[field.name])
    : undefined;
  return {
    name: field.name,
    label: field.label,
    type: field.type,
    required: field.required,
    ...(field.options?.length ? { options: [...field.options] } : {}),
    ...(field.hint ? { hint: field.hint } : {}),
    ...(field.system ? { system: true } : {}),
    hidden,
    ...(isPlainUpload(field)
      ? {
          upload: {
            target: { field: field.name },
            // An upload question's file is one of its ANSWERS, hidden with them.
            ...(filePath && !hidden ? { filePath } : {}),
            returned: returned.has(field.name),
          },
        }
      : {}),
  };
}

/**
 * The page for one client's KYC.
 *
 * @param steps the broker's form, as `KycConfigStore.getSteps` serves it.
 * @param view the submission as the client would read it — the profile merged
 *   in (`withPersonalView`) and every answer where its question is now
 *   (`answersInPlace`). An empty submission for a client who never started.
 * @param states the one judge's verdict (`stepStates`) on that same view.
 * @param hidden whether this reader's role hides a question's answer.
 */
export function assistLayout(
  steps: readonly KycStepConfig[],
  view: KycSubmission,
  states: readonly StepState[],
  hidden: (stepSlug: string, fieldName: string) => boolean,
): AssistLayout {
  const returned = new Set(view.rejectedFields ?? []);
  const laidOut: AssistStep[] = [];
  for (const step of steps) {
    // The judge's own list: enabled steps that collect something, in form order.
    const state = states.find((candidate) => candidate.slug === step.slug);
    if (!step.enabled || !state) continue;
    const slug = step.slug;
    const evidence = slug === 'document' || slug === 'address' ? slug : undefined;
    laidOut.push({
      slug,
      title: step.title,
      ...(step.description ? { description: step.description } : {}),
      complete: state.complete,
      missing: state.missing,
      returned: state.returned,
      fields: step.fields
        .filter((field) => !isDocumentField(field))
        .filter((field) => !(slug === 'selfie' && field.name === 'selfie'))
        .map((field) => fieldOf(step, field, view, returned, hidden(slug, field.name))),
      ...(evidence ? { document: documentOf(step, evidence, view, returned) } : {}),
      ...(slug === 'selfie'
        ? {
            selfie: {
              target: { field: 'selfie' },
              ...(view.selfie?.filePath ? { filePath: view.selfie.filePath } : {}),
              returned: returned.has('selfie'),
              optional: step.evidenceRequired === false,
            },
          }
        : {}),
    });
  }
  return {
    editable: OPEN_FOR_CHANGES.includes(view.status),
    complete: states.every((state) => state.complete),
    steps: laidOut,
  };
}
