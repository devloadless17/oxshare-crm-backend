import { basename } from 'path';
import { Inject, Injectable } from '@nestjs/common';
import { KYC_BUCKET, StoredFilesService } from '../../common/uploads/stored-files.service';
import { filenameFromStored } from '../../common/uploads/storage/storage-key';
import { collectsAnswers, isDataBearingStep } from './step-slugs';
import { documentTypeFor, typedAnswersFor } from './kyc-answers';
import { catalogueDocument } from '../../common/kyc/document-catalogue';
import {
  documentFlagLabel,
  flagsSettledByUpload,
  outstandingDocumentFlags,
} from './kyc-document-rules';
import {
  answersInPlace,
  isPlainUpload,
  stepStates,
  type ChosenDocument,
  type Owed,
  type StepState,
} from './kyc-step-state';
import {
  KycStore,
  stepDataFilePaths,
  type KycFormSnapshot,
  type KycStatus,
  type KycSubmission,
} from '../../store/kyc.store';
import { UsersStore } from '../../store/users.store';
import { KycConfigStore, type KycStepConfig } from '../../store/kyc-config.store';
import {
  AuthorizationError,
  FieldValidationError,
  ValidationError,
} from '../../common/errors/domain-errors';
import {
  acceptedDocuments,
  coreStepOf,
  DOCUMENT_PAGE_SLOTS,
  evidenceStepOfSlot,
  isPlatformField,
  pageIndexOfSlot,
  policyOf,
} from '../../common/kyc/identity-core';
import { DRIZZLE_DB } from '../../database/database.module';
import {
  NOTIFICATION_DISPATCH,
  type NotificationDispatchPort,
} from '../../common/provisioning/notification-dispatch.port';
import type { Db } from '../../database/db';
import { isProfileKey, type ProfileKey } from '../../common/profile/client-profile';
import { ClientProfileService, profileOf } from '../profile/client-profile.service';
import { customAnswersOf, withPersonalView } from './kyc-personal-view';

/** The answers that ARE profile fields — written to the profile, never stored here. */
function profileAnswersOf(answers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(answers).filter(([key]) => isProfileKey(key)));
}

/**
 * Every document path a submission references.
 *
 * One list, in one place, because three things need it and they must not drift:
 * `resetKyc` deletes these files, `UploadsController.submissionReferencesFile`
 * decides ownership from the same set, and a future retention job will want it.
 * A path missed here is a document that outlives its record.
 */
function documentPathsOf(submission: KycSubmission): string[] {
  return [
    submission.document?.frontFilePath,
    submission.document?.backFilePath,
    submission.selfie?.filePath,
    submission.addressProof?.filePath,
    submission.addressProof?.page2FilePath,
    // A custom step's uploads — left out, they outlived every reset.
    ...stepDataFilePaths(submission.stepData),
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);
}

/**
 * Uploads are the client's to make until the submission leaves their hands —
 * see the note in `attachFile` for the two attacks the guard closes.
 */
/**
 * May the client still change their answers? The same two refusals `saveStep`
 * has always given — asked once as a cheap early answer, and again UNDER THE
 * LOCK, where the answer actually decides (see `saveStep`).
 */
function assertOpenForAnswers(submission: { status: KycStatus }): void {
  if (submission.status === 'approved') {
    throw new AuthorizationError('KYC already approved.');
  }
  if (submission.status === 'under_review' || submission.status === 'submitted') {
    throw new AuthorizationError('KYC is under review. You cannot edit it now.');
  }
}

function assertOpenForUploads(submission: { status: KycStatus }): void {
  if (submission.status === 'approved') {
    throw new AuthorizationError('KYC already approved.');
  }
  if (submission.status === 'under_review' || submission.status === 'submitted') {
    throw new AuthorizationError('KYC is under review. You cannot change your documents now.');
  }
}

type StoredPage = { filePath: string } | undefined;

function pageOf(filePath: string | undefined): StoredPage {
  return filePath ? { filePath } : undefined;
}

/**
 * One canonical document after a page is placed in it.
 *
 * ## The pages belong to ONE document, and the upload now says which
 *
 * Every identity document stores its first page in the same column, and the
 * upload never said which document a page was. So the type was guessed —
 * `docType ?? 'passport'` — and recorded only when the client pressed Continue.
 * Upload a national ID's front, leave, come back: the server said "passport",
 * the portal selected Passport, and the ID's front sat in the passport's slot as
 * if it were one. Switch the choice the other way and a passport stood in for a
 * national ID. Reported from production.
 *
 * The type now arrives WITH the page. A page of a DIFFERENT document starts the
 * column afresh: the other pages belonged to the document the client moved
 * away from, and keeping them is how a passport's photo page and a national
 * ID's back ended up in one submission.
 *
 * An upload without a type (a portal predating it) keeps the stored type and
 * never invents one — the invented `'passport'` was the bug.
 */
function placePage(
  storedType: string | undefined,
  pages: readonly StoredPage[],
  page: number,
  file: { filePath: string },
  type: string | undefined,
): { docType?: string; pages: StoredPage[]; replaced: boolean } {
  const switching = type !== undefined && storedType !== undefined && storedType !== type;
  const next = switching ? [] : [...pages];
  next[page] = file;
  // `replaced`: the document on file is gone whole, so every flag on its pages
  // is answered with it (`flagsSettledByUpload`).
  return { docType: type ?? storedType, pages: next, replaced: switching };
}

/**
 * The refusal `submit` gives for a step that still owes something — read off
 * the one judgement (`kyc-step-state.ts`), every item under the field it is
 * about, and named as the client reads it: "Date of Birth", never `dateOfBirth`.
 */
function refusalFor(step: KycStepConfig, missing: readonly Owed[]): ValidationError {
  const first = missing[0];
  if (first.kind === 'choice' || first.kind === 'page') {
    const identity = step.slug === 'document';
    const firstPage = DOCUMENT_PAGE_SLOTS[identity ? 'document' : 'address'][0];
    const primary = first.kind === 'choice' || first.id === firstPage;
    const message = primary
      ? identity
        ? 'ID document front is required.'
        : 'Proof of address is required.'
      : `${first.label} is required.`;
    return new FieldValidationError(message, { [primary ? firstPage : first.id]: message });
  }
  if (step.slug === 'selfie' && first.id === 'selfie') {
    return new FieldValidationError('Selfie is required.', { selfie: 'Selfie is required.' });
  }
  const fields = Object.fromEntries(
    missing.map((item) => [item.id, item.message ?? `${item.label} is required.`]),
  );
  // One problem says itself; several are listed by what the client sees.
  const message =
    missing.length === 1
      ? (first.message ?? `${first.label} is required.`)
      : `${step.title || step.slug} is incomplete: ${missing.map((item) => item.label).join(', ')}.`;
  return new FieldValidationError(message, fields);
}

/**
 * What the broker's own steps asked — every field that is not the platform's —
 * recorded with the submission, so the reviewer reads each answer under the
 * question the client actually saw, whatever the builder changes afterwards.
 */
function formSnapshotOf(steps: readonly KycStepConfig[]): KycFormSnapshot {
  return steps
    .filter((step) => step.enabled)
    .map((step) => ({
      slug: step.slug,
      title: step.title,
      fields: step.fields
        .filter((field) => !isPlatformField(step.slug, field))
        .map(({ name, label, type }) => ({ name, label, type })),
    }))
    .filter((step) => step.fields.length > 0);
}

/**
 * The CLIENT's side of KYC — status, saving a step, attaching a file,
 * submitting, and resetting. The desk's decisions are `KycReviewService`.
 */
@Injectable()
export class KycClientService {
  constructor(
    private readonly files: StoredFilesService,
    private readonly kycStore: KycStore,
    private readonly users: UsersStore,
    private readonly kycConfig: KycConfigStore,
    /*
     * The db handle, used ONLY to open a transaction — every read and write
     * still goes through a store.
     */
    @Inject(DRIZZLE_DB) private readonly db: Db,
    /** The submission to the reviewers' bells (post-write). */
    @Inject(NOTIFICATION_DISPATCH) private readonly notifications: NotificationDispatchPort,
    /**
     * The one write path for the client's identity (0139): the personal step's
     * profile fields are the PROFILE, read and written here, never a copy in
     * `personal_info`.
     */
    private readonly profile: ClientProfileService,
  ) {}

  // ─── Get status ────────────────────────────────────────────────────────────
  async getStatus(userId: number) {
    const submission = await this.kycStore.getOrCreate(userId);
    return this.statusView(userId, submission, await this.kycConfig.getSteps());
  }

  /**
   * The submission as the client reads it, WITH every step's state — the one
   * judgement `submit` also applies, so the portal renders a verdict rather
   * than re-deriving one (`kyc-step-state.ts`).
   */
  private async statusView(
    userId: number,
    submission: KycSubmission,
    steps: readonly KycStepConfig[],
    chosen?: ChosenDocument,
  ): Promise<
    Omit<KycSubmission, 'formSnapshot' | 'formPolicy' | 'reviewedBy' | 'updatedAt'> & {
      steps: StepState[];
    }
  > {
    const user = await this.users.findById(userId);
    /*
     * Two fields are the desk's, not the client's: the form snapshot (the
     * reviewer's record of what was asked) and `reviewedBy` — an ADMIN's
     * internal id, which also names whoever currently holds a claim. It went
     * to every client until 28 Sep 2026; the portal never read it.
     *
     * Nor does this carry `updatedAt` or the verification level, which
     * `KycStatusDto` never declared: the portal reads the level from
     * `/auth/me` (lib/kyc-access.ts) and neither from here.
     */
    const {
      formSnapshot: _internal,
      formPolicy: _policy,
      reviewedBy: _desk,
      updatedAt: _written,
      ...asStored
    } = withPersonalView(submission, user);
    // A question the broker moved shows its answer where it is asked now.
    const view = answersInPlace(steps, asStored);
    return {
      ...view,
      steps: stepStates(steps, view, new Date(), chosen),
    };
  }

  // ─── Save step data ────────────────────────────────────────────────────────
  async saveStep(userId: number, step: string, data: Record<string, unknown>) {
    const submission = await this.kycStore.getOrCreate(userId);
    // The early answer; the deciding one is re-asked under the lock below.
    assertOpenForAnswers(submission);

    /*
     * ── A CUSTOM STEP NOW HAS SOMEWHERE TO PUT ITS ANSWERS ──────────────────
     *
     * This used to refuse anything but the four canonical slugs with
     * `Unknown step`, which contradicted the screen that produced it: the
     * builder has always offered Add Step and the API has always accepted any
     * slug. So a broker's fifth step rendered in the portal, accepted what the
     * client typed, and failed the instant they pressed Continue — the
     * capability was offered and the storage could not honour it.
     *
     * The four keep their own columns because the rest of the system reads them
     * by name; everything else lands under its slug in `step_data` (migration
     * 0130). `review` is the one slug that stores nothing, because it collects
     * nothing — it renders answers already given.
     *
     * Merged, not replaced, on both paths: steps are resumable and a client is
     * expected to fill half a step, leave, and come back to it.
     */
    if (!collectsAnswers(step)) {
      throw new ValidationError(`The ${step} step does not collect answers.`);
    }

    /*
     * A custom slug must be one the CONFIGURATION names, not merely one that is
     * not canonical.
     *
     * Accepting any slug would have re-opened what the old `Unknown step` guard
     * was protecting: `saveStep` is a client-facing route, so an arbitrary slug
     * is arbitrary client-controlled keys written into a jsonb column that
     * nothing displays and nothing bounds. `test/kyc-service.spec.ts` had a case
     * named "rejects an unknown step rather than silently dropping the data"
     * and it failed the moment this became permissive, which is the test doing
     * exactly its job.
     *
     * The four canonical slugs skip the lookup: they have columns of their own
     * and are storable whether or not a broker currently offers them, so a
     * client finishing a step that was disabled mid-flow still saves.
     */
    const steps = await this.kycConfig.getSteps();
    if (!isDataBearingStep(step) && !steps.some((s) => s.slug === step && s.enabled)) {
      throw new ValidationError(`Unknown step: ${step}`);
    }

    /*
     * ── ONLY WHAT THE STEP ASKS FOR, AND NEVER A FILE ────────────────────────
     *
     * This merged whatever `data` held into the stored step. The portal's review
     * screen re-posted its whole form as `personal` on submit, so every custom
     * step's answers, the document-choice keys and each upload stringified to
     * "[object Object]" landed in `personal_info` — and the reviewer read them
     * as "Custom Field 1790263652846: [object Object]" (reported from
     * production). Worse, `document`, `selfie` and `address_proof` hold FILE
     * PATHS, so the same merge let a client point their submission at any
     * stored file. `kyc-answers.ts` holds the rule and the whole argument.
     */
    /*
     * ── WHICH DOCUMENT, on the two document steps ────────────────────────────
     *
     * The pages arrive by upload, each naming its document (`attachFile`); this
     * records the choice. It used to overwrite the stored type whatever was on
     * file, so a client who had uploaded a passport, clicked National ID and
     * pressed Continue had their PASSPORT's photo page relabelled as a national
     * ID's front. Now a different document is only recorded while nothing is
     * on file for the one stored; otherwise the choice is JUDGED — every page of
     * it is owed, since the stored ones belong to the other document — and the
     * pages already on file are left alone until one of the new document's
     * arrives (which starts it afresh, in `placePage`).
     */
    /*
     * ── THE STEP'S TYPED ANSWERS, on every step ──────────────────────────────
     *
     * The personal step's IDENTITY fields — name, date of birth, nationality,
     * phone, residence, address — are the client's PROFILE (0139): they are
     * written there, through `ClientProfileService`, and never stored here.
     * `personal_info` keeps only answers to fields a broker invented. Every
     * other step's answers — an added step's, and the extra questions a broker
     * puts on a built-in step — go to `step_data` under the step's slug.
     */
    const fields = steps.find((s) => s.slug === step)?.fields ?? [];
    const { answers, problems } = typedAnswersFor(fields, data);
    if (problems.length > 0) {
      // Every problem, under the field it is about — not one sentence for the lot.
      throw new FieldValidationError(
        problems[0].message,
        Object.fromEntries(problems.map((problem) => [problem.field, problem.message])),
      );
    }

    /*
     * ── THE IDENTITY: only what CHANGED ─────────────────────────────────────
     *
     * Validating every value on every save refused a client for a field they
     * had not touched — a phone stored before today's rules, say — so only
     * values that differ from the profile go to the writer.
     *
     * A blank IS a change the client may make, deliberately: refusing it would
     * leave the screen empty and the old value on file, and a submission from
     * there would send what the client removed. The judge asks for the field
     * again at Continue and at submission. What must never happen is an
     * ACCIDENTAL blank — the phone input emitting its bare dial code while a
     * client picks a country, autosaved over the number on file — and that is
     * the portal's rule: it never autosaves a half-typed number, nor an
     * identity field the client did not edit (`use-step-autosave.ts`).
     */
    const user = step === 'personal' ? await this.users.findById(userId) : undefined;
    const onFile = user ? profileOf(user) : {};
    const identity = Object.fromEntries(
      Object.entries(step === 'personal' ? profileAnswersOf(answers) : {}).filter(
        ([key, value]) => value.trim() !== (onFile[key as ProfileKey] ?? ''),
      ),
    );
    const custom = step === 'personal' ? customAnswersOf(answers) : answers;

    let chosen: ChosenDocument | undefined;
    const saved = await this.db.transaction(async (tx) => {
      /*
       * ── RE-READ UNDER THE LOCK, and build the write from THAT row ─────────
       *
       * The status was checked above, before this transaction — and a
       * submission sent from another tab in between used to be pulled straight
       * back to `in_progress` by the write below: out of the review queue, the
       * reviewer's row vanishing under them. Two saves racing each other
       * merged into the same stale copy, and the second erased the first's
       * answers. Locking the row first settles both: whatever committed before
       * us is what we read, and nothing commits in between.
       *
       * The KYC row is locked BEFORE the profile's (inside `profile.update`) —
       * the order every writer takes them in, so two of them cannot deadlock.
       */
      const locked = (await this.kycStore.lockForUpdate(userId, tx)) ?? submission;
      assertOpenForAnswers(locked);

      const patch: Record<string, unknown> = { status: 'in_progress' };
      if (step === 'document' || step === 'address') {
        const docType = documentTypeFor(
          step === 'document' ? 'identity' : 'address',
          data['docType'],
        );
        const stored = step === 'document' ? locked.document : locked.addressProof;
        const onFile =
          step === 'document'
            ? Boolean(locked.document?.frontFilePath || locked.document?.backFilePath)
            : Boolean(locked.addressProof?.filePath || locked.addressProof?.page2FilePath);
        if (docType && docType !== stored?.docType) {
          if (onFile) chosen = { slug: step, docType };
          else if (step === 'document') patch['document'] = { ...locked.document, docType };
          else patch['addressProof'] = { ...locked.addressProof, docType };
        }
      }

      const current = (step === 'personal' ? locked.personalInfo : locked.stepData?.[step]) as
        Record<string, unknown> | undefined;
      const changed: string[] = Object.keys(custom).filter((key) => current?.[key] !== custom[key]);

      if (step === 'personal') {
        // Only invented fields, and never a profile key — even one stored by an
        // older build, which is dropped here rather than carried forward.
        patch['personalInfo'] = { ...customAnswersOf(locked.personalInfo), ...custom };
      } else if (!isDataBearingStep(step) || Object.keys(answers).length > 0) {
        patch['stepData'] = {
          ...locked.stepData,
          [step]: { ...(locked.stepData?.[step] ?? {}), ...answers },
        };
      }

      if (user && Object.keys(identity).length > 0) {
        /*
         * The profile and the step land together or not at all. What CHANGED
         * is judged after normalisation, so re-typing the same phone number
         * differently does not answer a reviewer who returned it.
         */
        const written = await this.profile.update(
          userId,
          identity,
          { kind: 'client', id: userId, email: user.email },
          { executor: tx, audit: { via: 'kyc' } },
        );
        changed.push(...written.changed);
      }

      /*
       * An answer the reviewer returned is settled by CHANGING it. Kept when the
       * value is the same, so the portal goes on showing it red — a client who
       * re-saves an untouched step has not answered the reviewer.
       */
      const flagged = locked.rejectedFields ?? [];
      const remaining = flagged.filter((id) => !changed.includes(id));
      if (remaining.length !== flagged.length) patch['rejectedFields'] = remaining;

      const updated = await this.kycStore.update(userId, patch, tx);
      return updated;
    });

    /*
     * Answered with every step's state — this step's judged against the
     * document the client says they are presenting — so Continue can ask the
     * server rather than guess.
     */
    return this.statusView(userId, saved, steps, chosen);
  }

  // ─── Attach uploaded file to a step ────────────────────────────────────────
  async attachFile(
    userId: number,
    field: string,
    filePath: string,
    /**
     * Which catalogue document this page belongs to (`passport`,
     * `national_id`, `utility_bill`…). Optional only because a portal predating
     * it sends none — see the note on `placePage`.
     */
    docType?: string,
  ) {
    const submission = await this.kycStore.getOrCreate(userId);

    /*
     * THE SAME GUARD `saveStep` HAS, and its absence here was the hole.
     *
     * `saveStep` refused an approved or in-review submission from the day it
     * was written; this method never did, and `POST /kyc/upload` reaches it
     * with only the auth guards. So a client could:
     *
     *   · swap evidence mid-review — upload a clean passport, submit, then
     *     re-upload a forged one while the reviewer had the row open, so the
     *     approval was recorded against bytes nobody inspected; or
     *   · replace documents AFTER approval, leaving status `approved` and
     *     `verificationLevel` 1 while the files behind them changed.
     *
     * Neither left a trace: `archiveAttempt` snapshots at DECISION time, so an
     * overwrite before the decision erased the original with no record it had
     * existed. `schema.ts` already identified `attachFile` overwriting
     * `frontFilePath` as the danger — it was only ever solved for the
     * post-decision case.
     */
    assertOpenForUploads(submission);

    const steps = await this.kycConfig.getSteps();
    const canonical = evidenceStepOfSlot(field);

    /*
     * A canonical slot belongs to its built-in step, and only while that step
     * is part of the verification: a proof of address uploaded while the broker
     * has switched the step off is a document nobody asked for, and nobody
     * would review.
     */
    const home = canonical ? steps.find((step) => step.slug === canonical) : undefined;
    if (canonical && !home?.enabled) {
      throw new ValidationError(
        `${coreStepOf(canonical)?.title ?? 'That step'} is not part of this verification.`,
      );
    }

    /*
     * ── A CUSTOM STEP'S DOCUMENT HAD NOWHERE TO GO ───────────────────────────
     *
     * The canonical slots are the four steps' own columns. A step the BROKER
     * added names its fields through the builder, which generates
     * `customField_<timestamp>` — so a custom step containing a File or Camera
     * field rendered an uploader in the portal, took the client's passport, and
     * answered `Unknown file field` on submit. The same shape as the text half
     * before migration 0130: the capability was offered by one screen and
     * refused by the storage behind it.
     *
     * Resolved by the CONFIGURATION rather than by a name, because there is no
     * name to recognise. The field must be a File or Camera field of an enabled
     * step — otherwise this route would accept an arbitrary key from a
     * client-facing endpoint and write it into an unbounded jsonb column, which
     * is precisely what `saveStep`'s own guard exists to prevent.
     *
     * ANY step, built-in or added. It used to be added steps only, so a File
     * field a broker put on Proof of Address rendered an uploader this refused
     * — and "required" on it blocked nothing (reported from local testing). A
     * catalogue document's pages never arrive here: they have canonical slots.
     */
    const owner = canonical
      ? undefined
      : steps.find(
          (step) =>
            step.enabled &&
            collectsAnswers(step.slug) &&
            (step.fields ?? []).some((f) => f.name === field && isPlainUpload(f)),
        );
    if (!canonical && !owner) throw new ValidationError(`Unknown file field: ${field}`);

    /*
     * The document a canonical page belongs to, checked against its CATEGORY:
     * an identity slot takes an identity document, an address slot an address
     * one. Refused rather than ignored when it is wrong — a page recorded under
     * the wrong document is exactly the mismatch this parameter exists to end.
     */
    const category =
      canonical === 'document' ? 'identity' : canonical === 'address' ? 'address' : undefined;
    const type = category ? documentTypeFor(category, docType) : undefined;
    if (category && docType && !type) {
      throw new ValidationError(`${docType} is not a document this step accepts.`);
    }
    /*
     * Only a document the broker ACCEPTS. The catalogue knows seven; a step
     * offers the ones ticked in the builder, and a page of another — from a tab
     * opened before the broker changed the list, or sent by hand — is a
     * document the broker's own policy does not accept.
     */
    if (
      category &&
      type &&
      home &&
      !acceptedDocuments(home.fields, category).some((doc) => doc.value === type)
    ) {
      throw new ValidationError(
        `${catalogueDocument(type)?.label ?? type} is not a document this verification accepts.`,
      );
    }

    // The path alone: what the client called the file is not kept (0160, D-84).
    const file = { filePath };
    let replaced: string[] = [];
    await this.db.transaction(async (tx) => {
      /*
       * Locked, and re-checked under the lock. An upload MERGES a page into a
       * column, and the front and back of an ID confirmed a moment apart arrive
       * together: each read the column before the other wrote, and the second
       * write erased the first page. The status is read again because a
       * submission may have gone to review since the check above.
       */
      const current = (await this.kycStore.lockForUpdate(userId, tx)) ?? submission;
      assertOpenForUploads(current);

      const patch: Partial<KycSubmission> = {};
      let replacesDocument = false;
      if (canonical === 'document') {
        const page = pageIndexOfSlot(field);
        const doc = placePage(
          current.document?.docType,
          [pageOf(current.document?.frontFilePath), pageOf(current.document?.backFilePath)],
          page,
          file,
          type,
        );
        replacesDocument = doc.replaced;
        patch.document = {
          ...(doc.docType ? { docType: doc.docType } : {}),
          frontFilePath: doc.pages[0]?.filePath,
          backFilePath: doc.pages[1]?.filePath,
        };
      } else if (canonical === 'address') {
        const page = pageIndexOfSlot(field);
        const doc = placePage(
          current.addressProof?.docType,
          [pageOf(current.addressProof?.filePath), pageOf(current.addressProof?.page2FilePath)],
          page,
          file,
          type,
        );
        replacesDocument = doc.replaced;
        patch.addressProof = {
          ...(doc.docType ? { docType: doc.docType } : {}),
          filePath: doc.pages[0]?.filePath,
          page2FilePath: doc.pages[1]?.filePath,
        };
      } else if (canonical === 'selfie') {
        patch.selfie = file;
      } else {
        patch.stepData = {
          ...current.stepData,
          [owner!.slug]: { ...(current.stepData?.[owner!.slug] ?? {}), [field]: file },
        };
      }

      /*
       * A new file is the answer to a returned one. Settling the flag here is
       * what lets the portal stop drawing it red on the client's next visit, and
       * what lets `submit` accept the submission back. A page of ANOTHER document
       * answers every page flag of the one it replaced — the passport the client
       * switched to answers the returned back of their national ID.
       */
      const settled = flagsSettledByUpload(field, steps, replacesDocument);
      const flagged = current.rejectedFields ?? [];
      const remaining = flagged.filter((id) => !settled.includes(id));
      if (remaining.length !== flagged.length) patch.rejectedFields = remaining;

      // The files this write stops referencing: a page replaced, or the pages of
      // the document the client moved away from.
      const kept = new Set(documentPathsOf({ ...current, ...patch }));
      replaced = documentPathsOf(current).filter((path) => !kept.has(path));

      await this.kycStore.update(userId, patch, tx);
    });

    /*
     * ── A REPLACED FILE IS DELETED, NOT ORPHANED ────────────────────────────
     *
     * A client who re-took a blurry photo left the first one in the bucket,
     * referenced by nothing — unservable, unreviewable, and an identity document
     * kept for no reason. After the commit it goes, unless an archived attempt
     * still holds it: a document a reviewer decided on is EVIDENCE (the same
     * subtraction `resetKyc` makes).
     */
    if (replaced.length > 0) {
      const archived = new Set(
        (await this.kycStore.archivedDocumentPaths(userId)).map((path) => basename(path)),
      );
      await this.deleteDocuments(replaced.filter((path) => !archived.has(basename(path))));
    }

    return { message: 'File uploaded.', field };
  }

  // ─── Submit KYC ────────────────────────────────────────────────────────────
  async submit(userId: number) {
    /*
     * The personal step is judged on the PROFILE's values (0139). This used to
     * copy the account's name INTO `personal_info` when the blob was empty — one
     * of the two paths that let the two copies drift apart — and then refuse a
     * submission whose blob was absent. The one record below replaces both.
     */
    await this.kycStore.getOrCreate(userId);

    /*
     * The profile's CONTENTS, not just its presence — FR-IND-03.
     *
     * The check above tests an object for truthiness, and `{}` is truthy. So a
     * caller could `POST /kyc/step {"step":"personal","data":{}}`, upload three
     * genuine images, submit, and reach the review queue with no name, no date
     * of birth and no address. Nothing else validated it: `SaveKycStepDto`
     * declares `data` as an untyped object on purpose (the step set is
     * configurable), and `saveStep` never consulted the configured `required`
     * flags, so they were decoration.
     *
     * The age rule had the same shape and worse consequences. `Must be 18+` was
     * a hint string in the seeded config, and the only check was in the client
     * portal — enforced by a form, bypassed by curl. A broker onboarding a minor
     * is a licensing matter.
     *
     * Enforced HERE rather than in `saveStep` deliberately: the steps are
     * resumable and a client is expected to save a half-filled profile and come
     * back to it. Submission is the point at which the profile is claimed to be
     * complete, so it is the point at which completeness is a rule.
     */
    /*
     * Read ONCE and shared: `profileRules` needs the personal step's fields and
     * the upload checks below need the enabled set, and two reads of the same
     * configuration inside one submission is a window where they could disagree.
     */
    const steps = await this.kycConfig.getSteps();

    /*
     * ── JUDGED AND MOVED UNDER ONE LOCK ─────────────────────────────────────
     *
     * The judgement below reads the PROFILE, and the profile has writers of its
     * own — the client in another tab, the support desk. Read outside a lock,
     * one of them could land between "this is complete" and `submitted`, and
     * the reviewer would open a submission that was never judged in the shape
     * they see. Every profile write takes this same row lock first
     * (`ClientProfileService.update`), so here nothing moves between the
     * judgement and the transition.
     */
    const { submitted, wasRejected } = await this.db.transaction(async (tx) => {
      const finalSub = (await this.kycStore.lockForUpdate(userId, tx))!;
      const user = await this.users.findById(userId, tx);

      /*
       * ── ONE JUDGE: `stepStates` ─────────────────────────────────────────────
       *
       * Everything a submission must hold — the profile's required answers and
       * its age rule, every required page of the chosen documents, the selfie,
       * every required answer and upload on every step, built-in or added — is
       * decided in `kyc-step-state.ts`. It is the same judgement
       * `GET /kyc/status` serves, so the portal and this refusal cannot
       * disagree: this used to be six hand-written checks here and another set in
       * the browser, and their disagreements were a week of bug reports.
       *
       * Steps whose broker has disabled them owe nothing: a step that is present
       * and enabled is a promise the client was asked for that; one that is not
       * is a promise nobody made. Refused at the FIRST step that still owes
       * something, in the order the client meets them, with the message that
       * kind of gap has always produced (`refusalFor`).
       */
      const view = withPersonalView(finalSub, user);
      for (const state of stepStates(steps, view, new Date())) {
        if (state.missing.length === 0) continue;
        throw refusalFor(
          steps.find((step) => step.slug === state.slug)!,
          state.missing,
        );
      }

      /*
       * A DOCUMENT THE REVIEWER RETURNED MUST BE REPLACED before it goes back.
       *
       * It was not: the flag drew a typed field red and did nothing for a file,
       * and resubmitting the very passport the reviewer had refused went straight
       * back into the queue. Each upload into a flagged slot settles its flag
       * (`attachFile`), so what is left here is what the client has not answered.
       * Typed fields are highlighted but not enforced — `kyc-document-rules.ts`
       * says why.
       */
      const owed = outstandingDocumentFlags(finalSub.rejectedFields, steps, finalSub);
      if (owed.length > 0) {
        const names = [...new Set(owed.map((id) => documentFlagLabel(id, steps, finalSub)))];
        throw new ValidationError(
          `Please replace the documents the reviewer returned: ${names.join(', ')}.`,
          { kind: 'returned_documents', fields: owed },
        );
      }

      /*
       * Read BEFORE the transition below overwrites it — this is what tells a
       * first submission from a client returning to fix one.
       *
       * The REASON as well as the status: saving any step moves a returned
       * submission to `in_progress`, so a client who corrected one field before
       * resubmitting was announced to the reviewers as a brand-new submission —
       * the resubmission the reviewer is waiting on, filed as a stranger's. The
       * reason survives until this transition clears it.
       */
      const rejectedBefore = finalSub.status === 'rejected' || Boolean(finalSub.rejectionReason);

      /*
       * `transition`, NOT `update`, and the difference was a real bug.
       *
       * This wrote `status: 'submitted'` unconditionally, with no check on what
       * the status already was. Nothing here touches `verificationLevel`, so an
       * approved client calling `POST /kyc/submit` again landed on `submitted`
       * WITH level 1 still granted — in the review queue and able to withdraw at
       * the same time. That is exactly the divergence `reject()` claws the level
       * back to prevent, reached by a route neither it nor `approve` covers.
       *
       * It also let a client bounce a claimed row out of `under_review` from
       * under the reviewer holding it.
       *
       * The `from` list is the set of states a submission may legitimately be
       * sent from: never started, part-filled, or returned for correction. A
       * resubmission after rejection starts a fresh review, so stale rejection
       * data must not follow it into the admin queue.
       */
      const moved = await this.kycStore.transition(
        userId,
        ['not_started', 'in_progress', 'rejected'],
        {
          status: 'submitted',
          submittedAt: new Date(),
          rejectionReason: undefined,
          rejectedFields: undefined,
          /*
           * A new submission has not been reviewed. The previous decision is
           * archived in the attempt history; left here, the review screen read
           * "Reviewed · <last reviewer> · <time>" over a submission awaiting
           * review (found live, 3 Oct 2026).
           */
          reviewedBy: null,
          reviewedAt: undefined,
          // What the broker's own steps asked, as the client answered them — the
          // review labels their answers from this, whatever the builder does next.
          formSnapshot: formSnapshotOf(steps),
          // The requirements it is made under — what approval will re-check (0158).
          formPolicy: policyOf(steps),
        },
        tx,
      );

      if (!moved) {
        // No row matched: the status is not one a submission may be sent
        // from — already submitted, in review, or approved. Reporting the
        // current state beats a generic 500.
        throw new AuthorizationError(
          finalSub.status === 'approved'
            ? 'KYC already approved.'
            : 'KYC has already been submitted and is awaiting review.',
        );
      }
      return { submitted: moved, wasRejected: rejectedBefore };
    });

    /*
     * Ring the reviewers' bells — post-write, never-throws, scope-filtered at
     * write time so a territoried reviewer is not told about a client outside
     * it. The polled queue badge remains the durable signal; this is the
     * per-item ping. No dedupe key: submission is client-driven, not retried
     * by any machine, and a genuine resubmission after rejection SHOULD ring
     * again.
     *
     * A RESUBMISSION says so, as a distinct kind. The two are different pieces
     * of work: a first submission is an unknown client to assess from scratch,
     * while a resubmission is a review already done once where a reviewer needs
     * only to check the fields they themselves asked to be corrected — and it
     * carries an expectation the client is waiting on, having already been
     * refused once. A queue that renders both identically hides that, and the
     * resubmissions are the ones that go stale.
     */
    void this.notifications.notifyAdmins({
      kind: wasRejected ? 'admin.kyc.resubmitted' : 'admin.kyc.submitted',
      params: { userId },
      // The submission is keyed on its client, so the item IS the client.
      subject: { id: String(userId), clientId: userId },
    });

    return submitted;
  }

  /**
   * Discard an in-progress submission and start again.
   *
   * Reachable by the CLIENT (`POST /kyc/reset`), which is what makes the two
   * guards below necessary rather than tidy.
   *
   * ## What this used to do
   *
   * `DELETE FROM kyc_submissions WHERE user_id = …`, unconditionally, touching
   * neither `verificationLevel` nor the files. Two consequences, both bad:
   *
   *  1. **An APPROVED client could delete the evidence behind their own
   *     verification and stay at level 1.** The submission row is the only
   *     record of the documents an admin approved; the level is what opens
   *     withdrawals. Resetting left the account verified with nothing behind it
   *     — which is precisely the state `approve()`'s ordering comment calls the
   *     one that costs money, reachable by a different route and by the client
   *     themselves.
   *  2. **Every referenced document was orphaned on disk.** The submission JSON
   *     held the only reference to those UUID filenames, so once the row was
   *     gone the files could never be served (`submissionReferencesFile` returns
   *     false), never be reviewed, and never be cleaned up by anything. They
   *     simply accumulated on the volume that holds every identity document.
   *
   * ## What it does now
   *
   * Refuses once the submission has left the client's hands, and takes the files
   * with the row when it does delete. Deleting the row while an admin is mid-review
   * is the same problem in a smaller form: the reviewer's screen empties and the
   * queue entry vanishes under them.
   */
  async resetKyc(userId: number) {
    /*
     * Judged and deleted under the submission's row lock (the lock submit takes),
     * so a reset racing a submit either sees the submission or runs before it.
     * An unlocked pre-read once let a reset delete a submission that had just
     * gone to review, along with the bytes of its newly frozen pages.
     */
    const deletable = await this.db.transaction(async (tx) => {
      const submission = await this.kycStore.lockForUpdate(userId, tx);
      if (!submission) return [];
      this.assertResettable(submission.status);
      const archived = new Set(
        (await this.kycStore.archivedDocumentPaths(userId)).map((p) => basename(p)),
      );
      const paths = documentPathsOf(submission).filter((p) => !archived.has(basename(p)));
      await this.kycStore.resetUser(userId, tx);
      return paths;
    });
    await this.deleteDocuments(deletable);
    return { message: 'KYC data reset successfully.' };
  }

  private assertResettable(status: string) {
    if (status === 'approved') {
      /*
       * ⚠️ THIS SENTENCE NAMES A REMEDY, SO IT MUST NAME ONE THAT EXISTS.
       *
       * It used to end "Contact support if your details have changed", and
       * support could not: `UpdateClientProfileDto` carried firstName,
       * lastName, phone and country, and no admin route reset a client's
       * submission. The client was sent to a human who had neither the field
       * nor the route, and the only lever left was to REJECT the verification —
       * which `kyc-gates-money.spec.ts` proves drops verificationLevel to 0 and
       * shuts both money doors, for a typo.
       *
       * `PATCH /admin/kyc/:userId/personal-info` closes that — since 26 Sep
       * 2026 for EVERY identity field (the phone is the desk's own edit) — and
       * `POST /admin/kyc/:userId/reverify` returns the verification when the
       * change is material. So the sentence names both, and promises nothing
       * support cannot do.
       *
       * It does not say "rejected": that is the operator's mechanism, not the
       * client's outcome, and it reads as a threat to somebody who has done
       * nothing wrong. It does not name the permission either — that invites
       * "then ask them to use it" at a desk where nobody holds the key.
       *
       * ⚠️ If that route's accepted fields ever change, THIS STRING IS PART OF
       * THE CHANGE. A promise in user-facing copy outliving the thing it
       * describes is how this line became wrong the first time.
       */
      throw new AuthorizationError(
        'An approved verification cannot be reset. If your details have changed, contact ' +
          'support: they can correct them on your verification, or ask you to verify again.',
      );
    }
    if (status === 'submitted' || status === 'under_review') {
      throw new AuthorizationError(
        'Your submission is being reviewed and cannot be reset right now.',
      );
    }

    /*
     * Paths are read BEFORE the row goes (afterwards nothing knows them), less
     * anything an archived attempt still points at: a decided attempt's document
     * is EVIDENCE, not an orphan.
     */
  }

  /**
   * Best-effort unlink of documents whose owning record is already gone.
   *
   * Deliberately after the delete and deliberately not fatal: the row is the
   * thing that matters, and a file that cannot be removed is a disk problem to
   * be logged, not a reason to fail a request whose database work succeeded.
   * The alternative — unlink first — risks deleting documents and then failing
   * to delete the row, leaving a submission pointing at nothing.
   */
  private async deleteDocuments(paths: string[]): Promise<void> {
    for (const filePath of paths) {
      /*
       * Through `StoredFilesService`, not `fs`, so this reaches wherever the bytes
       * actually are — object storage for anything uploaded since the R2 move, and
       * the API host's disk for anything older. Unlinking a local path directly
       * would silently succeed at deleting nothing for every document written since
       * that move, and leave the client's identity documents in the bucket after
       * their submission was discarded.
       *
       * `remove` never throws and soft-deletes the registry row, which preserves
       * the same property this method already had: the database work is what
       * matters, and a file that cannot be removed is logged rather than fatal.
       */
      const name = filenameFromStored(filePath);
      if (!name) continue;
      await this.files.remove(KYC_BUCKET, name);
    }
  }

  /*
   * REMOVED: `resetAllKyc()`.
   *
   * It deleted every KYC submission in the database and unlinked every file in
   * ./uploads/kyc — system-wide, for every client — and nothing called it. Its
   * only route, `POST /kyc/reset-all`, was taken off the client-facing
   * controller when it was found to be reachable by any verified client
   * (kyc.controller.ts records that), and the method was left behind.
   *
   * A destructive maintenance operation with no caller is not dormant, it is
   * loaded: the next person who needs "clear the test data" finds a method that
   * looks sanctioned and wires a route to it. Deleting it means that person has
   * to write the operation deliberately, behind MasterAdminGuard and a
   * non-production check, which is where it belonged in the first place.
   *
   * `KycStore.clearAll()` went with it for the same reason.
   */
}
