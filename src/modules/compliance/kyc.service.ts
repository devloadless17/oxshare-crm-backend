import { basename } from 'path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { KYC_BUCKET, StoredFilesService } from '../../common/uploads/stored-files.service';
import { filenameFromStored } from '../../common/uploads/storage/storage-key';
import { AdminsStore } from '../../store/admins.store';
import { collectsAnswers, isDataBearingStep } from './step-slugs';
import { documentTypeFor, typedAnswersFor } from './kyc-answers';
import { catalogueDocument } from '../../common/kyc/document-catalogue';
import {
  CANONICAL_FILE_STEP,
  documentFlagLabel,
  flagsSettledByUpload,
  outstandingDocumentFlags,
} from './kyc-document-rules';
import {
  answerKeysOf,
  flagLabel,
  returnableItems,
  returnedFlags,
  reviewLayout,
} from './kyc-review-layout';
import {
  answersInPlace,
  approvalBlockers,
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
  type KycSortKey,
  type KycStatus,
  type KycSubmission,
} from '../../store/kyc.store';
import type { SortOrder } from '../../common/sorting';
import { User, UsersStore } from '../../store/users.store';
import { KycConfigStore, type KycStepConfig } from '../../store/kyc-config.store';
import { EmailService } from '../email/email.service';
import {
  AuthorizationError,
  ConflictError,
  FieldValidationError,
  NotFoundError,
  ValidationError,
} from '../../common/errors/domain-errors';
import {
  acceptedDocuments,
  coreStepOf,
  isPlatformField,
  policyOf,
} from '../../common/kyc/identity-core';
import { DRIZZLE_DB } from '../../database/database.module';
import {
  NOTIFICATION_DISPATCH,
  type NotificationDispatchPort,
} from '../../common/provisioning/notification-dispatch.port';
import type { Db } from '../../database/db';
import type { ClientScope } from '../../common/security/client-scope';
import { isProfileKey, type ProfileKey } from '../../common/profile/client-profile';
import { ClientIdentityService } from '../client-identity/client-identity.service';
import {
  ClientProfileService,
  profileOf,
  type ProfileActor,
} from '../profile/client-profile.service';

/** The answers that are NOT profile fields — what `personal_info` may store. */
function customAnswersOf(answers: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(answers ?? {}).filter(([key]) => !isProfileKey(key)));
}

/** The answers that ARE profile fields — written to the profile, never stored here. */
function profileAnswersOf(answers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(answers).filter(([key]) => isProfileKey(key)));
}

/**
 * The user, as a REVIEWER may see them.
 *
 * An allow-list, and it exists because spreading the whole record here sent the
 * client's `password_hash` to every admin opening a KYC submission — along with
 * their refresh-token hash and their password-reset hash. A reviewer needs to
 * know WHO they are looking at in order to match a name against a passport;
 * they never need that person's credentials.
 *
 * Same shape of defect as the portal's `sanitize()`, in a different file: what
 * leaves the API is decided by listing it, not by remembering to remove things.
 */
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

function reviewerView(user: User) {
  return {
    id: user.id,
    portalId: user.portalId,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    type: user.type,
    status: user.status,
    verificationLevel: user.verificationLevel,
    emailVerified: user.emailVerified,
    country: user.country,
    phone: user.phone,
    createdAt: user.createdAt,
  };
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
    const firstPage = identity ? 'doc_front' : 'address_proof';
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
 * The statuses a rejection may act on.
 *
 * Wider than approve's on purpose: a rejection is also the CORRECTION for a
 * mistaken approval, so `approved` and `rejected` are in the list. What it will
 * not do is reject a submission that was never submitted.
 *
 * Shared between the conditional write and the diagnosis of its failure, so
 * "which statuses count" cannot be answered two different ways by the same
 * method.
 */
const REJECTABLE_FROM: readonly KycStatus[] = ['submitted', 'under_review', 'approved', 'rejected'];

@Injectable()
export class KycService {
  private readonly logger = new Logger(KycService.name);

  constructor(
    private readonly email: EmailService,
    private readonly files: StoredFilesService,
    private readonly kycStore: KycStore,
    private readonly users: UsersStore,
    private readonly kycConfig: KycConfigStore,
    /*
     * The db handle, for the two decisions that must be atomic.
     *
     * Injected rather than reached for via a module-level singleton, matching
     * the four money services. It is used ONLY to open a transaction — every
     * read and write still goes through a store, so this does not become a
     * second data-access path.
     */
    @Inject(DRIZZLE_DB) private readonly db: Db,
    /*
     * Bell rows — the decision to the client (in the decision transaction),
     * the submission to the reviewers (post-write). APPENDED LAST: this class
     * is constructed positionally in `kyc-service.spec.ts`.
     */
    @Inject(NOTIFICATION_DISPATCH) private readonly notifications: NotificationDispatchPort,
    /**
     * Resolves the holder's NAME for the refusal in `assertNotHeldByAnother`.
     *
     * Only ever read on the contested path, so it costs a query when a decision
     * is refused and nothing at all when one succeeds. APPENDED LAST, like
     * `notifications` above: this class is constructed positionally in
     * `kyc-service.spec.ts`, so inserting a parameter in the middle silently
     * shifts every one after it.
     */
    private readonly admins: AdminsStore,
    /**
     * The one write path for the client's identity (0139): the personal step's
     * profile fields are the PROFILE, read and written here, never a copy in
     * `personal_info`. APPENDED LAST, for the positional construction above.
     */
    private readonly profile: ClientProfileService,
    /**
     * The client's identity RECORD (0151): every transaction here that changes
     * evidence or records a decision ends by recording it there, so the record
     * moves with the KYC row or not at all. APPENDED LAST, for the positional
     * construction above.
     */
    private readonly identity: ClientIdentityService,
  ) {}

  /**
   * The personal step's answers as ONE record — what every reader sees.
   *
   * The client's whole profile, and the stored answers to the questions a
   * broker added. Before 0139 the step kept its own copy of the name, phone and
   * country, so a client could hold one name on their account and another on
   * their verification, and the review screen printed both. Now there is one
   * value, and it is the profile's — all nine fields, whatever the builder
   * shows, because the identity is the platform's (26 Sep 2026).
   */
  private personalView(submission: KycSubmission, user: User | undefined): Record<string, string> {
    return { ...customAnswersOf(submission.personalInfo), ...(user ? profileOf(user) : {}) };
  }

  /** The submission, with its personal step read as one record. */
  private withPersonalView(submission: KycSubmission, user: User | undefined): KycSubmission {
    return { ...submission, personalInfo: this.personalView(submission, user) };
  }

  /**
   * The flags a return stores. REFUSED, naming each, when a reviewer names
   * something the client cannot answer (`returnableItems`): an unknown id used
   * to be stored as given — shown nowhere, blocking nothing, answered by
   * nobody — and a page the document on file does not have told the client to
   * replace a back side their passport never had.
   */
  private returnFlags(
    ids: readonly string[],
    steps: readonly KycStepConfig[],
    evidence: KycSubmission,
    field: 'rejectedFields' | 'items',
  ): string[] {
    const returnable = returnableItems(steps, reviewLayout(steps, evidence), evidence);
    const { flags, unknown } = returnedFlags(ids, steps, returnable);
    if (unknown.length > 0) {
      throw new FieldValidationError(`The client cannot be asked for: ${unknown.join(', ')}.`, {
        [field]:
          `Not something this client can update: ${unknown.join(', ')}. Choose from the ` +
          'details, the pages on file and the questions on their form.',
      });
    }
    return flags;
  }

  /**
   * What the client last PRESENTED, as the last decision recorded it: the
   * archived attempt's evidence and answers. Undefined when nothing was ever
   * decided (a returned row from before attempts were archived).
   */
  private async lastPresented(
    userId: number,
  ): Promise<
    | Pick<
        KycSubmission,
        'document' | 'selfie' | 'addressProof' | 'stepData' | 'personalInfo' | 'submittedAt'
      >
    | undefined
  > {
    const attempts = await this.kycStore.listAttempts(userId);
    const last = attempts.at(-1);
    if (!last) return undefined;
    return {
      document: last.document,
      selfie: last.selfie,
      addressProof: last.addressProof,
      stepData: last.stepData,
      personalInfo: last.personalInfo,
      submittedAt: last.submittedAt,
    };
  }

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
    } = this.withPersonalView(submission, user);
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
      // The document the client chose is a draft on their record.
      await this.identity.recordFromKyc(userId, tx);
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
    const canonical = Object.prototype.hasOwnProperty.call(CANONICAL_FILE_STEP, field)
      ? CANONICAL_FILE_STEP[field]
      : undefined;

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
        const page = field === 'doc_back' ? 1 : 0;
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
        const page = field === 'address_proof_2' ? 1 : 0;
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
      // The page lands on the client's draft in the same commit.
      await this.identity.recordFromKyc(userId, tx);
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
      const view = this.withPersonalView(finalSub, user);
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
      // What the client presented is frozen on their record, as they sent it.
      await this.identity.recordFromKyc(userId, tx);
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

  // ─── Admin: list all (paginated, searchable, with per-status counts) ───────
  async listAll(
    filter: {
      status?: KycStatus;
      /** Any-of; the `needs_review` queue. Takes precedence over `status`. */
      statuses?: readonly KycStatus[];
      q?: string;
      page?: number;
      limit?: number;
      scope?: ClientScope;
      /** R-2.5 server-side sort, already validated against KYC_SORT_COLUMNS. */
      sort?: KycSortKey;
      order?: SortOrder;
    } = {},
  ) {
    const page = Math.max(1, filter.page ?? 1);
    const limit = Math.min(100, Math.max(1, filter.limit ?? 25));

    // One joined query, filtered/sorted/paginated in SQL, plus one grouped
    // count. The previous version loaded every submission and then issued one
    // this.users.findById per row inside Promise.all — 1+N, which at 50K rows
    // fires 50,001 queries in a burst and can exhaust the pool that
    // WalletService.post() needs for its FOR UPDATE lock.
    return this.kycStore.findPageWithUsers({
      status: filter.status,
      statuses: filter.statuses ? [...filter.statuses] : undefined,
      q: filter.q,
      page,
      limit,
      scope: filter.scope,
      sort: filter.sort,
      order: filter.order,
    });
  }

  // ─── Admin: get one ────────────────────────────────────────────────────────
  async getByUserId(userId: number) {
    const submission = await this.kycStore.findByUserId(userId);
    if (!submission) throw new NotFoundError('KYC submission not found.');
    const [user, steps] = await Promise.all([
      this.users.findById(userId),
      this.kycConfig.getSteps(),
    ]);
    // The snapshot is in the layout; the policy is what approval re-checks — neither is shown.
    const {
      formSnapshot: _inLayout,
      formPolicy: _checkedAtApproval,
      ...view
    } = this.withPersonalView(submission, user);
    return {
      ...view,
      user: user ? reviewerView(user) : undefined,
      // How to present it — structure and labels only (`kyc-review-layout.ts`),
      // with the recorded name of any question since removed from the form.
      layout: reviewLayout(
        steps,
        submission,
        await this.kycConfig.recordedLabels(answerKeysOf(submission)),
      ),
    };
  }

  // ─── Admin: approve ────────────────────────────────────────────────────────
  async approve(userId: number, adminId: string) {
    const submission = await this.kycStore.findByUserId(userId);
    if (!submission) throw new NotFoundError('KYC submission not found.');

    /*
     * Approval is a decision about EVIDENCE, and `not_started` / `in_progress`
     * contain none. Without this an admin could raise an account with no
     * documents at all to verification level 1 — which is what gates
     * withdrawals, so it unlocks moving money on the strength of nothing.
     * `submit()` is what puts a submission in a reviewable state, and it is
     * where FR-CORE-15's four-document requirement is enforced.
     */
    if (submission.status !== 'submitted' && submission.status !== 'under_review') {
      throw new ValidationError(
        submission.status === 'approved'
          ? 'This KYC submission is already approved.'
          : `Only a submitted KYC can be approved; this one is ${submission.status}.`,
      );
    }

    /*
     * ONE TRANSACTION, and a CONDITIONAL write.
     *
     * This used to be two unconditional writes to two stores, with a comment
     * arguing that ordering them status-first made the crash window harmless:
     * `status approved, level 0` is recoverable, `level 1, status not approved`
     * lets a client move money with no approved submission behind them. The
     * argument was right and the ordering was right; it was still a window.
     *
     * Two things close it now:
     *
     *  - `transition()` puts the expected status in the WHERE, so the check and
     *    the write are one statement. Two admins racing approve against reject
     *    can no longer both pass their check against the same row and both
     *    write — the second one finds nothing to update and is refused.
     *  - The transaction makes the status, the archived attempt and the
     *    verification level a single atomic act, so there is no state where one
     *    landed and another did not.
     *
     * The re-read above is now advisory only: it exists to produce a precise
     * message ("already approved" vs "never submitted"), and the WHERE clause is
     * what actually enforces it. If they disagree, the database wins.
     */
    await this.assertNotHeldByAnother(submission, adminId);
    // For the archived attempt: what the reviewer decided on, as one record.
    const [client, steps] = await Promise.all([
      this.users.findById(userId),
      this.kycConfig.getSteps(),
    ]);

    /*
     * ── APPROVAL RE-ASKS THE ONE JUDGE ─────────────────────────────────────
     *
     * Submission judged the record; approval raises the money gate on it. In
     * between, the record can move — a desk edit, a submission from before
     * today's rules, a builder change — and approval used to check nothing but
     * the status. So it asks the judge again about what the verification RESTS
     * on (`approvalBlockers`): a complete, adult identity, every required page
     * of the identity document, the selfie and the proof of address when the
     * broker asks for them — never a question of the broker's added since. A
     * record that fails is not approvable; it goes back to the client (reject,
     * naming what is missing).
     */
    const unfinished = approvalBlockers(
      steps,
      this.withPersonalView(submission, client),
      new Date(),
    ).map((item) => item.message ?? item.label);
    if (unfinished.length > 0) {
      throw new ConflictError(
        `This submission cannot be approved as it stands: ${unfinished.join('; ')}. ` +
          'Return it to the client to complete.',
      );
    }

    await this.db.transaction(async (tx) => {
      const updated = await this.kycStore.transition(
        userId,
        ['submitted', 'under_review'],
        {
          status: 'approved',
          reviewedBy: adminId,
          reviewedAt: new Date(),
          // A re-verification this approval answers is over.
          reverificationRequestedAt: undefined,
        },
        tx,
        adminId,
      );
      if (!updated) {
        // Lost a race with another reviewer between the read and this write.
        throw new ConflictError(
          'This submission was changed by another reviewer. Reload it and try again.',
        );
      }

      // Snapshot inside the transaction: the evidence and the decision are one
      // fact, so a rolled-back approval must not leave an archived attempt. The
      // snapshot carries the PROFILE's values the reviewer read, so history
      // shows the record as it was decided even after the profile moves on.
      await this.kycStore.archiveAttempt(this.withPersonalView(updated, client), tx);
      /*
       * NOTHING is promoted onto the client record any more — it IS the record.
       *
       * Approval used to copy the submission's phone and country onto `users`
       * (and deliberately not the name), because the verified identity lived in
       * `personal_info` while the rest of the system read the columns. Since
       * 0139 the personal step reads and writes the profile directly, so what
       * the reviewer approved is already what every screen shows. A copy step
       * here would be a second writer with nothing to copy.
       */
      await this.users.update(userId, { verificationLevel: 1 }, tx);
      // The decision on the client's record, after the level it explains.
      await this.identity.recordFromKyc(userId, tx);
      // The bell row commits WITH the decision — a rolled-back approval must
      // not leave a "you're verified" the client can read.
      await this.notifications.notify(
        { recipient: { kind: 'client', id: userId }, kind: 'kyc.approved', params: {} },
        tx,
      );
    });

    const user = await this.users.findById(userId);
    if (user) {
      // Sent inline per ARCH §8.5 — fire-and-forget, failure is logged by EmailService
      void this.email.sendKycDecisionEmail(user.email, user.firstName, 'approved');
    }
    this.logger.log(`KYC approved for user ${userId} by admin ${adminId}`);
    return this.getByUserId(userId);
  }

  // ─── Admin: claim for review ───────────────────────────────────────────────
  // Marks a submitted KYC as under_review by this admin, so two reviewers
  // don't process the same submission concurrently.
  /**
   * Hand a claimed submission back to the queue.
   *
   * ## Why this exists
   *
   * A claim was a one-way door: `submitted → under_review` with no way back.
   * A reviewer who picked one up and then could not finish it — reassigned,
   * off shift, or moved out of that territory by an administrator — left a row
   * that LOOKS taken to everyone else, with the Claim button hidden and no
   * name on it to chase.
   *
   * ## Who may do it
   *
   * Anyone who could DECIDE it. A claim has never been a lock: `approve` and
   * `reject` both accept `under_review` from any reviewer with the permission
   * and the scope, deliberately, so one person's absence cannot strand a
   * client's verification. Refusing those same people the LESSER action —
   * putting it back in the pool rather than deciding it themselves — would be
   * incoherent, and would leave "stuck" as the only outcome of an ordinary
   * handover. The caller's identity is recorded by the audit row, which is
   * what makes a release accountable rather than restricted.
   *
   * ## What it is not
   *
   * Not a way to undo a DECISION. `from` is `under_review` alone, so an
   * approved or rejected submission is refused: reopening a decided
   * verification is `reject`'s job, with a reason attached, not a silent
   * reversal that leaves no trace of what was decided or why.
   */
  async release(userId: number, adminId: string, mayOverride = false) {
    const submission = await this.kycStore.findByUserId(userId);
    if (!submission) throw new NotFoundError('KYC submission not found.');
    if (submission.status !== 'under_review') {
      throw new ValidationError(
        submission.status === 'submitted'
          ? 'This submission is already waiting in the queue.'
          : 'Only a submission that is under review can be handed back.',
      );
    }

    /*
     * ── A CLAIM NOW MEANS SOMETHING ON THE WAY OUT TOO ──────────────────────
     *
     * `approve` and `reject` refuse a submission another reviewer is holding.
     * This did not, so the claim they enforce could be removed by anybody: a
     * second reviewer handed the submission back to the queue, the holder's
     * screen still showed a submission they believed was theirs, and the next
     * person to claim it decided an identity someone else was midway through
     * verifying. The lock was on the door and the hinges were loose.
     *
     * ## Why this is not simply "only the holder may release"
     *
     * Because that deadlocks. A reviewer who claims a submission and then goes
     * off shift, leaves, or loses their account would strand it forever —
     * `approve` and `reject` are ALREADY holder-only, so release is the only
     * way back to the queue. Locking it without an escape converts a stuck
     * claim into a client who can never be verified.
     *
     * So the escape stays and becomes DELIBERATE rather than silent: a
     * different reviewer needs `kyc.claim.override`, which is a separate
     * permission precisely so that taking a colleague's work is a thing a role
     * is granted, not a thing anyone with `kyc.review` does by accident. The
     * seeded administrator holds it (the catalogue feeds `ALL_PERMISSIONS`), so
     * the desk is never stranded.
     */
    if (!mayOverride) await this.assertNotHeldByAnother(submission, adminId);

    /*
     * `transition`, for the reason `claim` documents: the read above is for
     * its error messages and cannot be the guard. Two reviewers releasing in
     * the same tick, or a release racing a decision, must resolve to exactly
     * one winner — the expected status goes in the WHERE clause.
     *
     * `reviewedBy: null` matters as much as the status. Leaving the id behind
     * would show the next reader a submission in the pool that still names a
     * reviewer, which is the confusion this whole change is about.
     */
    const released = await this.kycStore.transition(
      userId,
      ['under_review'],
      { status: 'submitted', reviewedBy: null },
      undefined,
      /*
       * The WHERE is the enforcement; the read above only produces the message.
       * An overriding reviewer passes `undefined` so the write is unconditional
       * — that is what the override IS.
       */
      mayOverride ? undefined : adminId,
    );

    if (!released) {
      throw new ConflictError('This submission was decided or released first.');
    }
    return this.getByUserId(userId);
  }

  async claim(userId: number, adminId: string) {
    const submission = await this.kycStore.findByUserId(userId);
    if (!submission) throw new NotFoundError('KYC submission not found.');
    if (submission.status !== 'submitted') {
      throw new ValidationError(
        submission.status === 'under_review'
          ? 'This submission is already being reviewed.'
          : 'Only submitted KYC can be claimed for review.',
      );
    }
    /*
     * `transition`, so the check and the write are ONE statement.
     *
     * The read above is kept for its error messages, but it cannot be the
     * guard: two admins clicking Review in the same tick both saw 'submitted',
     * both passed, and both wrote — the second silently taking ownership of a
     * row the first was already reading. `transition` puts the expected status
     * in the WHERE clause, so exactly one UPDATE matches and the loser is told.
     *
     * This was the one decision path that never adopted the pattern the store
     * documents; approve and reject have used it throughout.
     */
    const claimed = await this.kycStore.transition(userId, ['submitted'], {
      status: 'under_review',
      reviewedBy: adminId,
    });

    if (!claimed) {
      throw new ConflictError('Another reviewer claimed this submission first.');
    }
    return this.getByUserId(userId);
  }

  /**
   * CORRECT AN IDENTITY FIELD ON AN APPROVED SUBMISSION — the one state with no
   * other way out.
   *
   * ## Why this route exists at all (CORE-18)
   *
   * `saveStep` above refuses `approved`, `submitted` and `under_review` and
   * falls through for the rest, so a client can fix a typo while
   * `not_started`, `in_progress` or `rejected`. Four of six states already had
   * a path. APPROVED had none — and it is the state every real client ends in.
   *
   * The product NAMED a remedy that did not exist. `resetKyc` refused an
   * approved submission with "Contact support if your details have changed",
   * and support could not: `UpdateClientProfileDto` carries firstName,
   * lastName, phone and country, and there is no admin route that resets a
   * client's submission — the only `reset` on the admin side is
   * `kyc-config/reset`, the step BUILDER. The one lever left was to REJECT the
   * verification for a typo, which `test/kyc-gates-money.spec.ts` proves takes
   * `verificationLevel` to 0 and shuts both money doors.
   *
   * That sentence is rewritten now and says what this route actually delivers —
   * see `resetKyc` below, which carries the reasoning and the warning that the
   * string is part of any change to the fields accepted here. Quoted in the
   * past tense on purpose: a comment quoting a string it does not own goes
   * stale the moment the string moves, which is the class this whole domain has
   * been finding.
   *
   * ## APPROVED ONLY, and that narrowing is the point
   *
   * The other five states have a client-facing path already. An admin
   * correction there would be a second way to do something the client can do
   * themselves — with more privilege and less context about what they meant.
   *
   * ## ⚠️ THE CORRECTION IS RE-VALIDATED, and without that this is a BYPASS
   *
   * `findProfileProblem` refuses an under-18, impossible or future date of
   * birth at submission. An unvalidated admin correction would let an operator
   * write any date onto an APPROVED record — a compliance control with a hole
   * in it on the side where it is least visible, and the hole works both ways:
   * making an underage client look adult, or an adult look underage.
   *
   * The obvious objection answers itself. If the CORRECTED value genuinely
   * fails the rule, the client should not be holding an approved verification —
   * that is a rejection, not an edit, and the product already has that path. The
   * refusal is not blocking a legitimate correction; it is telling the operator
   * they have found a different problem.
   *
   * ## Which is why a failed re-validation is a CONFLICT, not a validation error
   *
   * A 400 means "you typed it wrong". This is "the record is wrong": the
   * operator has just discovered that an approved client is underage or carries
   * an impossible date of birth. Those need different screens and different
   * follow-up, and collapsing them into one status code hides a compliance event
   * inside a form error. `problem.kind` rides in the details so the caller can
   * say WHICH.
   *
   * ## The values live in ONE place — the profile (0139)
   *
   * This wrote `kyc_submissions.personalInfo` while date of birth and address
   * existed only there, and its note said adding `users` columns "to carry a
   * copy" would create the disagreement it was meant to prevent. That was right
   * about copies. 0139 made the profile the ONLY home instead, so a correction
   * is a profile write — through `ClientProfileService`, audited as
   * `kyc.identity_correct` on the submission, inside the write's own
   * transaction rather than after it.
   */
  async correctIdentity(
    userId: number,
    patch: Record<string, unknown>,
    actor: ProfileActor,
    /** Why the verified record changes — on the audit row, beside both values. */
    reason?: string,
  ) {
    const submission = await this.kycStore.findByUserId(userId);
    if (!submission) throw new NotFoundError('KYC submission not found.');

    if (submission.status !== 'approved') {
      throw new ValidationError(
        `This correction applies to an APPROVED submission; this one is ${submission.status}. ` +
          'In every other state the client can edit their own details.',
      );
    }

    /*
     * ONE implementation for every admin who changes a client's details
     * (28 Sep 2026): the client page's edit and this review's "Correct details"
     * both go through `ClientProfileService.editAsAdmin`. It validates only
     * what changed (a record approved before a field became required must stay
     * correctable), refuses a value that would disqualify the record as a 409,
     * audits `kyc.identity_correct` with the reason and both values, and tells
     * the client. `correctionOnly`: this route exists for nothing else.
     */
    const phone = Object.prototype.hasOwnProperty.call(patch, 'phone');
    if (phone) {
      throw new ValidationError(
        'A correction does not change the phone number — edit it on the client’s profile.',
      );
    }
    const written = await this.profile.editAsAdmin(userId, patch, actor, {
      mayCorrect: true,
      reason,
      via: 'kyc_correction',
      correctionOnly: true,
    });
    return {
      submission: await this.getByUserId(userId),
      before: written.before,
      after: written.after,
    };
  }

  /**
   * RETURN AN APPROVED VERIFICATION TO THE CLIENT — "please update it".
   *
   * ## The dead end this closes (26 Sep 2026)
   *
   * A verified detail that changes materially — a new passport, a move abroad
   * — had no path. `reject` accepts an approved submission, but it is a
   * REJECTION: the client is emailed "your application needs correction" and
   * reads it as a verdict on them. The reviewer's screen offered nothing at all.
   *
   * ## What it does
   *
   * The same single transaction `reject` runs, from `approved` only: the
   * decided attempt archived, the level taken back to 0 (deposits and
   * withdrawals pause until re-approval — the owner's ruling), the items to
   * redo recorded as the reviewer's flags (a whole document as its pages), and
   * `reverification_requested_at` stamped so every screen can say "please
   * update your verification" rather than "rejected". The client is emailed
   * the reason and the items; their resubmission reaches the queue as a
   * resubmission, like any returned one. Approval clears the stamp.
   */
  async requestReverification(userId: number, adminId: string, reason: string, items: string[]) {
    const submission = await this.kycStore.findByUserId(userId);
    if (!submission) throw new NotFoundError('KYC submission not found.');
    if (submission.status !== 'approved') {
      throw new ValidationError(
        'Only an approved verification can be returned for re-verification. ' +
          'A submission still under review is returned with a rejection.',
      );
    }
    const [user, steps] = await Promise.all([
      this.users.findById(userId),
      this.kycConfig.getSteps(),
    ]);
    const flags = this.returnFlags(items, steps, submission, 'items');

    await this.db.transaction(async (tx) => {
      const updated = await this.kycStore.transition(
        userId,
        ['approved'],
        {
          status: 'rejected',
          rejectionReason: reason,
          rejectedFields: flags,
          reviewedBy: adminId,
          reviewedAt: new Date(),
          reverificationRequestedAt: new Date(),
        },
        tx,
      );
      if (!updated) {
        throw new ConflictError(
          'This verification changed while you were deciding. Reload it and try again.',
        );
      }
      // Archived as what it is — a request to UPDATE, not a rejection.
      await this.kycStore.archiveAttempt(this.withPersonalView(updated, user), tx, {
        reverification: true,
      });
      // The money gate closes with the return, in the same commit.
      await this.users.update(userId, { verificationLevel: 0 }, tx);
      await this.identity.recordFromKyc(userId, tx);
      /*
       * The client's bell, in the same commit — approve() and reject() stance: a
       * rolled-back return must not leave a "please update" the client can read.
       * Its own kind, not `kyc.rejected`: a verified client asked to update is
       * not being turned down, and the portal says so (the email's distinction,
       * carried to the bell). The reason rides in params so the row can say why.
       */
      await this.notifications.notify(
        {
          recipient: { kind: 'client', id: userId },
          kind: 'kyc.reverification_requested',
          params: { reason },
        },
        tx,
      );
    });

    if (user) {
      void this.email.sendKycReverificationEmail(
        user.email,
        user.firstName,
        reason,
        flags.map((id) => flagLabel(id, steps, submission)),
      );
    }
    this.logger.log(`KYC re-verification requested for user ${userId} by admin ${adminId}`);
    return this.getByUserId(userId);
  }

  /**
   * Refuse a decision on a submission a DIFFERENT reviewer is holding.
   *
   * ## The behaviour this replaces
   *
   * A claim was decoration. `approve` accepted a transition out of
   * `under_review` without asking who held it, so two reviewers could open the
   * same passport and the second to click decided it — taking the claim with
   * them. Nothing told the first; their screen still showed a submission they
   * believed was theirs, and `reviewed_by` now named somebody else.
   *
   * On a compliance desk that is worse than a wasted afternoon. The whole point
   * of a claim is that two people do not verify the same identity in parallel
   * and reach different answers, and the audit trail should record one reviewer
   * per decision because that is the person who will be asked to account for it.
   *
   * ## Why it names the holder
   *
   * "Someone else has this" leaves the reader with one option: interrupt the
   * whole desk to find out who. The name is the difference between a refusal
   * they can act on and one they have to escalate, and it is already on the
   * screen the queue renders — the API just never said it.
   *
   * ## Why this is NOT the enforcement
   *
   * It is a read, and two reviewers who read before either writes both pass it.
   * `transition`'s `unheldOrHeldBy` argument is what actually decides, in the
   * WHERE clause of the write. This exists to turn the database's "no" into a
   * sentence — the same division of labour the `from` status check already has.
   */
  private async assertNotHeldByAnother(
    submission: { status: KycStatus; reviewedBy?: string },
    adminId: string,
  ): Promise<void> {
    const holder = submission.reviewedBy;
    if (submission.status !== 'under_review' || !holder || holder === adminId) return;

    const names = await this.admins.namesByIds([holder]);
    const name = names.get(holder);
    throw new ConflictError(
      name
        ? `${name} is reviewing this submission. Ask them to hand it back first.`
        : 'Another reviewer is holding this submission. It must be handed back first.',
    );
  }

  // ─── Admin: reject ─────────────────────────────────────────────────────────
  async reject(
    userId: number,
    adminId: string,
    reason: string,
    rejectedFields: string[] = [],
    /** The configured reason chosen, when one was — kept on the decision (0151). */
    reasonId?: string,
  ) {
    const submission = await this.kycStore.findByUserId(userId);
    if (!submission) throw new NotFoundError('KYC submission not found.');
    const user = await this.users.findById(userId);

    /*
     * Same shape as `approve()`: one transaction, one conditional write.
     *
     * `from` is wider here than on approve — a rejection is also the correction
     * for a mistaken approval, and taking the level back from an already-approved
     * client is exactly what `test/kyc-gates-money.spec.ts` pins. What it will
     * NOT do is reject a submission that was never submitted.
     */
    await this.assertNotHeldByAnother(submission, adminId);
    /*
     * WHAT IS BEING DECIDED. A submission with a reviewer, or approved, is its
     * live evidence. One already RETURNED is being returned again — a correction
     * of the return — and the client may have uploaded replacements since, which
     * they never presented. Deciding on the live row would freeze those drafts
     * as evidence of a decision nobody made about them; the correction decides
     * what the LAST decision did.
     */
    const decided = submission.status === 'rejected' ? await this.lastPresented(userId) : undefined;
    const evidence = { ...submission, ...decided };
    // A whole document returned is every page of it ON FILE returned.
    const steps = await this.kycConfig.getSteps();
    const flags = this.returnFlags(rejectedFields, steps, evidence, 'rejectedFields');

    await this.db.transaction(async (tx) => {
      const updated = await this.kycStore.transition(
        userId,
        REJECTABLE_FROM,
        {
          status: 'rejected',
          rejectionReason: reason,
          rejectedFields: flags,
          reviewedBy: adminId,
          reviewedAt: new Date(),
        },
        tx,
        adminId,
      );
      if (!updated) {
        /*
         * TWO REASONS THE WRITE MATCHED NOTHING, AND THEY ARE NOT THE SAME 400.
         *
         * `from` here covers every status but `in_progress`, so a no-row result
         * is almost never "wrong status". It is far more often a RACE: the row
         * was claimed, approved or rejected between the read above and this
         * write, and the claim guard or the status list then excluded it.
         *
         * Reported as a ValidationError, that told a reviewer their request was
         * malformed when it was valid and merely late — and it made the two
         * ways of losing the same race answer differently, since `approve`'s
         * equivalent branch has always been a 409. Re-read and say which
         * happened: the row is still there, so the question is cheap to answer
         * properly rather than guess at.
         */
        const now = await this.kycStore.findByUserId(userId);
        /*
         * Judged against the SAME list the write used, not a hand-copied idea of
         * it. The first version asked `status !== 'in_progress'`, which called a
         * `not_started` submission a race and answered 409 for a request that
         * really was invalid — the drift this shares-one-constant shape exists
         * to stop.
         */
        if (now && REJECTABLE_FROM.includes(now.status)) {
          throw new ConflictError(
            'This submission was claimed or decided by another reviewer while you were ' +
              'deciding. Reload it and try again.',
          );
        }
        throw new ValidationError(
          `Only a submitted KYC can be rejected; this one is ${now?.status ?? submission.status}.`,
        );
      }
      await this.kycStore.archiveAttempt(
        { ...this.withPersonalView(updated, await this.users.findById(userId)), ...decided },
        tx,
        { reasonId },
      );
      /*
       * Take the verification level back, in the SAME transaction.
       *
       * `approve()` raises it to 1 and nothing lowered it, so an admin who
       * approved by mistake and then rejected left the client REJECTED and still
       * VERIFIED — the status said no while the money path said yes.
       *
       * Unconditional rather than conditional on the previous status: level 1
       * has exactly one source in Phase 1 — approval — so a rejected client
       * should hold none of it, whichever path they arrived by.
       */
      await this.users.update(userId, { verificationLevel: 0 }, tx);
      await this.identity.recordFromKyc(userId, tx);
      // Same stance as approve(): the row and the decision are one commit. The
      // reason rides in params so the bell can say what to fix.
      await this.notifications.notify(
        {
          recipient: { kind: 'client', id: userId },
          kind: 'kyc.rejected',
          params: { reason },
        },
        tx,
      );
    });

    if (user) {
      // Sent inline per FR-ADM-03 — the client is emailed the reason and can retry
      void this.email.sendKycDecisionEmail(
        user.email,
        user.firstName,
        'rejected',
        reason,
        // Named as every screen names them — "National ID (Back Side)", never `doc_back`.
        flags.map((id) => flagLabel(id, steps, submission)),
      );
    }

    return this.getByUserId(userId);
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
    const submission = await this.kycStore.findByUserId(userId);
    if (!submission) return { message: 'KYC data reset successfully.' };

    if (submission.status === 'approved') {
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
    if (submission.status === 'submitted' || submission.status === 'under_review') {
      throw new AuthorizationError(
        'Your submission is being reviewed and cannot be reset right now.',
      );
    }

    /*
     * Read the paths BEFORE the row goes — afterwards nothing knows them — and
     * subtract anything an archived attempt still points at.
     *
     * A document that belongs to a decided attempt is EVIDENCE, not an orphan.
     * Deleting it here would quietly destroy the record of a refusal while
     * leaving the row that describes it, which is worse than the orphaning this
     * deletion was added to fix.
     */
    const archived = new Set(
      (await this.kycStore.archivedDocumentPaths(userId)).map((p) => basename(p)),
    );
    const deletable = documentPathsOf(submission).filter((p) => !archived.has(basename(p)));

    await this.db.transaction(async (tx) => {
      await this.kycStore.resetUser(userId, tx);
      // The client's drafts go with the row, in the same commit; their decided
      // evidence stays on their record, where it always belonged.
      await this.identity.recordFromKyc(userId, tx);
    });
    await this.deleteDocuments(deletable);

    return { message: 'KYC data reset successfully.' };
  }

  /** A client's decided attempts, oldest first — the admin history view. */
  async getHistory(userId: number) {
    const [attempts, steps] = await Promise.all([
      this.kycStore.listAttempts(userId),
      this.kycConfig.getSteps(),
    ]);
    /*
     * Each attempt laid out like the live submission — its identity document
     * named by the type it held, its flags by label — so history never guesses
     * "passport" or prints `doc_back`, and needs no builder read.
     */
    const recorded = await this.kycConfig.recordedLabels(attempts.flatMap(answerKeysOf));
    return attempts.map((attempt) => ({
      ...attempt,
      layout: reviewLayout(steps, attempt, recorded),
    }));
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
