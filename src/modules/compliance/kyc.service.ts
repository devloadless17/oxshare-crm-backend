import { basename } from 'path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { KYC_BUCKET, StoredFilesService } from '../../common/uploads/stored-files.service';
import { filenameFromStored } from '../../common/uploads/storage/storage-key';
import { AdminsStore } from '../../store/admins.store';
import { collectsAnswers, isDataBearingStep } from './step-slugs';
import { documentTypeFor, typedAnswersFor } from './kyc-answers';
import {
  CANONICAL_FILE_STEP,
  documentFlagLabel,
  flagsSettledByUpload,
  outstandingDocumentFlags,
} from './kyc-document-rules';
import {
  isPlainUpload,
  stepStates,
  type ChosenDocument,
  type Owed,
  type StepState,
} from './kyc-step-state';
import {
  KycStore,
  stepDataFilePaths,
  type KycSortKey,
  type KycStatus,
  type KycSubmission,
} from '../../store/kyc.store';
import type { SortOrder } from '../../common/sorting';
import { User, UsersStore } from '../../store/users.store';
import { KycConfigStore, type KycStepConfig } from '../../store/kyc-config.store';
import { EmailService } from '../email/email.service';
import { findProfileProblem, type ProfileFieldRule } from './kyc-profile';
import {
  AuthorizationError,
  ConflictError,
  KycCorrectionRefusedError,
  NotFoundError,
  ValidationError,
} from '../../common/errors/domain-errors';
import { DRIZZLE_DB } from '../../database/database.module';
import {
  NOTIFICATION_DISPATCH,
  type NotificationDispatchPort,
} from '../../common/provisioning/notification-dispatch.port';
import type { Db } from '../../database/db';
import type { ClientScope } from '../../common/security/client-scope';

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
function assertOpenForUploads(submission: { status: KycStatus }): void {
  if (submission.status === 'approved') {
    throw new AuthorizationError('KYC already approved.');
  }
  if (submission.status === 'under_review' || submission.status === 'submitted') {
    throw new AuthorizationError('KYC is under review. You cannot change your documents now.');
  }
}

type StoredPage = { filePath: string; fileName: string } | undefined;

function pageOf(filePath: string | undefined, fileName: string | undefined): StoredPage {
  return filePath ? { filePath, fileName: fileName ?? '' } : undefined;
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
  file: { filePath: string; fileName: string },
  type: string | undefined,
): { docType?: string; pages: StoredPage[] } {
  const switching = type !== undefined && storedType !== undefined && storedType !== type;
  const next = switching ? [] : [...pages];
  next[page] = file;
  return { docType: type ?? storedType, pages: next };
}

/**
 * The refusal `submit` gives for a step that still owes something — the
 * messages it has always given, now read off the one judgement
 * (`kyc-step-state.ts`) rather than computed beside it.
 */
function refusalFor(step: KycStepConfig, missing: readonly Owed[]): ValidationError {
  const answers = missing.filter((item) => item.kind === 'answer');
  if (step.slug === 'personal' && answers.length > 0) {
    const names = answers.map((item) => item.id);
    return new ValidationError(
      `These profile fields are required before submitting: ${names.join(', ')}.`,
      { kind: 'missing_fields', fields: names },
    );
  }
  const first = missing[0];
  if (first.kind === 'invalid') {
    return new ValidationError(first.message ?? `${first.label} is not acceptable.`, {
      kind: first.code ?? 'invalid_answer',
      fields: [first.id],
    });
  }
  if (first.kind === 'choice' || first.kind === 'page') {
    const identity = step.slug === 'document';
    const firstPage = identity ? 'doc_front' : 'address_proof';
    const primary = first.kind === 'choice' || first.id === firstPage;
    return new ValidationError(
      primary
        ? identity
          ? 'ID document front is required.'
          : 'Proof of address is required.'
        : `${first.label} is required.`,
      { kind: 'missing_document', fields: [primary ? firstPage : first.id] },
    );
  }
  if (step.slug === 'selfie' && first.id === 'selfie') {
    return new ValidationError('Selfie is required.', {
      kind: 'missing_document',
      fields: ['selfie'],
    });
  }
  const owed = missing.filter((item) => item.kind === 'answer' || item.kind === 'upload');
  return new ValidationError(
    `${step.title || step.slug} is incomplete: ${owed.map((item) => item.label).join(', ')}.`,
    { kind: 'incomplete_step', fields: owed.map((item) => item.id) },
  );
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
  ) {}

  /**
   * The profile rules for this deployment, read from the configured steps.
   *
   * Read rather than hardcoded because the admin KYC builder owns the field set
   * (D-29). `AdminComplianceService.assertMandatoryStepsIntact` guarantees the
   * `personal` step exists and is enabled, so an empty result means the config
   * is genuinely unusable — and requiring nothing is the wrong way to fail on a
   * compliance path, so submission is refused rather than waved through.
   */
  private async profileRules(): Promise<ProfileFieldRule[]> {
    return this.profileRulesFrom(await this.kycConfig.getSteps());
  }

  /**
   * The same rules, from a configuration the caller has already loaded.
   *
   * `submit` needs the personal step's fields AND the enabled set of every other
   * step, and reading the configuration twice inside one submission is a window
   * where the two could disagree.
   */
  private profileRulesFrom(steps: readonly KycStepConfig[]): ProfileFieldRule[] {
    const personal = steps.find((s) => s.slug === 'personal' && s.enabled);
    if (!personal) {
      /*
       * A plain Error, so this surfaces as a 500 rather than a 400.
       *
       * The caller did nothing wrong — the deployment has no profile step. Only
       * the bootstrap seed makes that unlikely now: this used to say
       * `assertMandatoryStepsIntact` made it unreachable through the API, and
       * that guard was deliberately removed (see `admin-compliance.service.ts`),
       * so a broker CAN disable the personal step and reach this. Telling the
       * client their request was invalid would be a lie, and "please contact
       * support" on a 400 is the kind of message that gets triaged as a user
       * error for a week.
       *
       * Failing closed rather than defaulting to "no fields are required": on a
       * compliance path, an empty rule set is the one outcome that must never be
       * reachable by accident.
       */
      throw new Error(
        'KYC config has no enabled `personal` step; cannot determine the required profile fields.',
      );
    }
    return personal.fields;
  }

  // ─── Get status ────────────────────────────────────────────────────────────
  async getStatus(userId: string) {
    const submission = await this.kycStore.getOrCreate(userId);
    return this.statusView(userId, submission, await this.kycConfig.getSteps());
  }

  /**
   * The submission as the client reads it, WITH every step's state — the one
   * judgement `submit` also applies, so the portal renders a verdict rather
   * than re-deriving one (`kyc-step-state.ts`).
   */
  private async statusView(
    userId: string,
    submission: KycSubmission,
    steps: readonly KycStepConfig[],
    chosen?: ChosenDocument,
  ): Promise<KycSubmission & { verificationLevel: number; steps: StepState[] }> {
    const user = await this.users.findById(userId);
    return {
      ...submission,
      verificationLevel: user?.verificationLevel ?? 0,
      steps: stepStates(steps, submission, new Date(), chosen),
    };
  }

  // ─── Save step data ────────────────────────────────────────────────────────
  async saveStep(userId: string, step: string, data: Record<string, unknown>) {
    const submission = await this.kycStore.getOrCreate(userId);

    if (submission.status === 'approved') {
      throw new AuthorizationError('KYC already approved.');
    }
    if (submission.status === 'under_review' || submission.status === 'submitted') {
      throw new AuthorizationError('KYC is under review. You cannot edit it now.');
    }

    const patch: Record<string, unknown> = { status: 'in_progress' };

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
    let chosen: ChosenDocument | undefined;
    if (step === 'document' || step === 'address') {
      const docType = documentTypeFor(
        step === 'document' ? 'identity' : 'address',
        data['docType'],
      );
      const stored = step === 'document' ? submission.document : submission.addressProof;
      const onFile =
        step === 'document'
          ? Boolean(submission.document?.frontFilePath || submission.document?.backFilePath)
          : Boolean(submission.addressProof?.filePath || submission.addressProof?.page2FilePath);
      if (docType && docType !== stored?.docType) {
        if (onFile) chosen = { slug: step, docType };
        else if (step === 'document') patch['document'] = { ...submission.document, docType };
        else patch['addressProof'] = { ...submission.addressProof, docType };
      }
    }

    /*
     * ── THE STEP'S TYPED ANSWERS, on every step ──────────────────────────────
     *
     * The personal step's go to `personal_info`, read by name across the system
     * (the verified phone and country are promoted from it). Every other step's
     * — an added step's, and the extra questions a broker puts on a built-in
     * step — go to `step_data` under the step's slug.
     */
    const fields = steps.find((s) => s.slug === step)?.fields ?? [];
    const { answers, problems } = typedAnswersFor(fields, data);
    if (problems.length > 0) {
      throw new ValidationError(problems.map((p) => p.message).join(' '), {
        kind: 'invalid_answer',
        fields: problems.map((p) => p.field),
      });
    }
    const current = (
      step === 'personal' ? submission.personalInfo : submission.stepData?.[step]
    ) as Record<string, unknown> | undefined;
    const changed = Object.keys(answers).filter((key) => current?.[key] !== answers[key]);

    if (step === 'personal') {
      // `PersonalInfo` names the seeded fields; the column also carries any
      // field the builder added, so the cast widens to what is stored.
      patch['personalInfo'] = {
        ...(submission.personalInfo ?? {}),
        ...answers,
      };
    } else if (!isDataBearingStep(step) || Object.keys(answers).length > 0) {
      patch['stepData'] = {
        ...submission.stepData,
        [step]: { ...(submission.stepData?.[step] ?? {}), ...answers },
      };
    }

    /*
     * An answer the reviewer returned is settled by CHANGING it. Kept when the
     * value is the same, so the portal goes on showing it red — a client who
     * re-saves an untouched step has not answered the reviewer.
     */
    const flagged = submission.rejectedFields ?? [];
    const remaining = flagged.filter((id) => !changed.includes(id));
    if (remaining.length !== flagged.length) patch['rejectedFields'] = remaining;

    /*
     * Answered with every step's state — this step's judged against the
     * document the client says they are presenting — so Continue can ask the
     * server rather than guess.
     */
    const saved = await this.kycStore.update(userId, patch);
    return this.statusView(userId, saved, steps, chosen);
  }

  // ─── Attach uploaded file to a step ────────────────────────────────────────
  async attachFile(
    userId: string,
    field: string,
    filePath: string,
    fileName: string,
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

    const file = { filePath, fileName };
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
      if (canonical === 'document') {
        const page = field === 'doc_back' ? 1 : 0;
        const doc = placePage(
          current.document?.docType,
          [
            pageOf(current.document?.frontFilePath, current.document?.frontFileName),
            pageOf(current.document?.backFilePath, current.document?.backFileName),
          ],
          page,
          file,
          type,
        );
        patch.document = {
          ...(doc.docType ? { docType: doc.docType } : {}),
          frontFilePath: doc.pages[0]?.filePath,
          frontFileName: doc.pages[0]?.fileName,
          backFilePath: doc.pages[1]?.filePath,
          backFileName: doc.pages[1]?.fileName,
        };
      } else if (canonical === 'address') {
        const page = field === 'address_proof_2' ? 1 : 0;
        const doc = placePage(
          current.addressProof?.docType,
          [
            pageOf(current.addressProof?.filePath, current.addressProof?.fileName),
            pageOf(current.addressProof?.page2FilePath, current.addressProof?.page2FileName),
          ],
          page,
          file,
          type,
        );
        patch.addressProof = {
          ...(doc.docType ? { docType: doc.docType } : {}),
          filePath: doc.pages[0]?.filePath,
          fileName: doc.pages[0]?.fileName,
          page2FilePath: doc.pages[1]?.filePath,
          page2FileName: doc.pages[1]?.fileName,
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
       * what lets `submit` accept the submission back.
       */
      const settled = flagsSettledByUpload(field, steps);
      const flagged = current.rejectedFields ?? [];
      const remaining = flagged.filter((id) => !settled.includes(id));
      if (remaining.length !== flagged.length) patch.rejectedFields = remaining;

      await this.kycStore.update(userId, patch, tx);
    });

    return { message: 'File uploaded.', field, fileName };
  }

  // ─── Submit KYC ────────────────────────────────────────────────────────────
  async submit(userId: string) {
    const submission = await this.kycStore.getOrCreate(userId);
    const user = await this.users.findById(userId);

    if (!submission.personalInfo && user?.firstName) {
      submission.personalInfo = {
        firstName: user.firstName,
        lastName: user.lastName,
      };
      await this.kycStore.update(userId, { personalInfo: submission.personalInfo });
    }

    const finalSub = await this.kycStore.getOrCreate(userId);

    if (!finalSub.personalInfo)
      throw new ValidationError('Personal information is required before submitting.');

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
    // Fails closed when the deployment has no enabled profile step — see
    // `profileRulesFrom` for why an empty rule set must never be reachable.
    this.profileRulesFrom(steps);

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
    for (const state of stepStates(steps, finalSub, new Date())) {
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
    const owed = outstandingDocumentFlags(finalSub.rejectedFields, steps);
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
    const wasRejected = finalSub.status === 'rejected' || Boolean(finalSub.rejectionReason);

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
    const submitted = await this.kycStore.transition(
      userId,
      ['not_started', 'in_progress', 'rejected'],
      {
        status: 'submitted',
        submittedAt: new Date(),
        rejectionReason: undefined,
        rejectedFields: undefined,
      },
    );

    if (!submitted) {
      // No row matched, so the status moved under us — already submitted, in
      // review, or approved. Reporting the current state beats a generic 500.
      throw new AuthorizationError(
        finalSub.status === 'approved'
          ? 'KYC already approved.'
          : 'KYC has already been submitted and is awaiting review.',
      );
    }

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
    void this.notifications.notifyAdminsWithPermission(
      'kyc.review',
      {
        kind: wasRejected ? 'admin.kyc.resubmitted' : 'admin.kyc.submitted',
        params: { userId },
      },
      { subjectClientId: userId },
    );

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
  async getByUserId(userId: string) {
    const submission = await this.kycStore.findByUserId(userId);
    if (!submission) throw new NotFoundError('KYC submission not found.');
    const user = await this.users.findById(userId);
    return { ...submission, user: user ? reviewerView(user) : undefined };
  }

  // ─── Admin: approve ────────────────────────────────────────────────────────
  async approve(userId: string, adminId: string) {
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

    await this.db.transaction(async (tx) => {
      const updated = await this.kycStore.transition(
        userId,
        ['submitted', 'under_review'],
        { status: 'approved', reviewedBy: adminId, reviewedAt: new Date() },
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
      // fact, so a rolled-back approval must not leave an archived attempt.
      await this.kycStore.archiveAttempt(updated, tx);
      /*
       * The VERIFIED identity is promoted onto the client record.
       *
       * Approval is the moment `personal_info` stops being a claim and becomes
       * evidence somebody checked against a document. Until this ran, that
       * evidence stayed locked in the submission's JSONB and the columns the
       * rest of the system reads stayed empty — so an operator opening a fully
       * verified client saw "—" for phone and country, and the client list's
       * country filter (which has two indexes built for it) matched none of
       * them. Every real client was invisible to a filter that worked
       * perfectly on the seeded ones.
       *
       * Only fields the submission actually carries are written, so an
       * approval that captured no phone cannot blank a phone taken at
       * registration. Where both exist the verified value wins: it is the one
       * backed by a document.
       *
       * Name is deliberately NOT promoted here. It is `not null` on the row,
       * it is what every screen and every audit entry already calls this
       * person, and a silent rename on approval is a change nobody asked for
       * — that belongs to the admin's own edit (CORE-18), where it is audited.
       */
      const verified = updated.personalInfo;
      const identity: { phone?: string; country?: string } = {};
      if (verified?.phone?.trim()) identity.phone = verified.phone.trim();
      if (verified?.country?.trim()) identity.country = verified.country.trim();
      await this.users.update(userId, { verificationLevel: 1, ...identity }, tx);
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
  async release(userId: string, adminId: string, mayOverride = false) {
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

  async claim(userId: string, adminId: string) {
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
   * ## The values live in ONE place
   *
   * `users` has no `dateOfBirth` and no `address` column — the fields exist only
   * in `kyc_submissions.personalInfo`. So there is no second row to keep in step
   * and nothing here writes to `users`. Adding those columns to carry a copy was
   * the first shape considered and rejected: it would have created the
   * disagreement it was meant to prevent.
   */
  async correctIdentity(userId: string, patch: Record<string, unknown>) {
    const submission = await this.kycStore.findByUserId(userId);
    if (!submission) throw new NotFoundError('KYC submission not found.');

    if (submission.status !== 'approved') {
      throw new ValidationError(
        `This correction applies to an APPROVED submission; this one is ${submission.status}. ` +
          'In every other state the client can edit their own details.',
      );
    }

    const current = (submission.personalInfo ?? {}) as unknown as Record<string, unknown>;
    const before = Object.fromEntries(Object.keys(patch).map((k) => [k, current[k]]));
    const merged = { ...current, ...patch };

    /*
     * ⚠️ VALIDATES WHAT CHANGED, NOT THE WHOLE RECORD — and the first version of
     * this did the opposite, which my own test caught.
     *
     * Running `findProfileProblem` over the merged object also runs its
     * COMPLETENESS branch against TODAY's config. So a client approved before a
     * required field was added to the form has a record that is legitimately
     * incomplete by current rules, and every correction on them fails with
     * `missing_fields` — for a field this route cannot even accept. That is
     * CORE-18 all over again: an operator who cannot fix a typo because of
     * something unrelated, on the one state that already had no way out.
     *
     * Completeness was established at submission and is not what a correction
     * re-opens. What must still hold is that the NEW VALUE is one the system
     * would accept, so the rule set is narrowed to the corrected fields: the
     * missing-fields branch is then vacuous by construction, and the date-of-
     * birth rules fire exactly when a date of birth is what changed.
     *
     * Correcting an ADDRESS therefore does not re-check an untouched date of
     * birth. That is deliberate — it is the same "unrelated field blocks the
     * fix" trap from the other direction, and a record whose stored DOB is
     * disqualifying is a rejection to make on purpose, not a side effect of
     * someone fixing a street name.
     */
    const corrected = Object.keys(patch);
    const subject = Object.fromEntries(corrected.map((k) => [k, merged[k]]));
    const rules = (await this.profileRules()).filter((rule) => corrected.includes(rule.name));
    const problem = findProfileProblem(subject, rules, new Date());
    if (problem) {
      throw new KycCorrectionRefusedError(
        `The corrected details do not pass verification: ${problem.message} ` +
          'This is a fact about the RECORD, not about what you typed — an approved ' +
          'submission cannot hold these values, so this is a rejection rather than an edit.',
        { kind: problem.kind, fields: problem.fields },
      );
    }

    /*
     * The cast mirrors `submitKyc`'s, and for the same reason: `PersonalInfo`
     * declares named fields while the COLUMN is jsonb and also carries whatever
     * a custom KYC field was named. Widening to what is actually stored is
     * honest; narrowing to the interface would drop a configured field on every
     * correction, silently.
     */
    const updated = await this.kycStore.update(userId, {
      personalInfo: merged as unknown as KycSubmission['personalInfo'],
    });
    return { submission: updated, before, after: patch };
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
  async reject(userId: string, adminId: string, reason: string, rejectedFields: string[] = []) {
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

    await this.db.transaction(async (tx) => {
      const updated = await this.kycStore.transition(
        userId,
        REJECTABLE_FROM,
        {
          status: 'rejected',
          rejectionReason: reason,
          rejectedFields: rejectedFields,
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
      await this.kycStore.archiveAttempt(updated, tx);
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
        rejectedFields,
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
  async resetKyc(userId: string) {
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
       * `PATCH /admin/kyc/:userId/personal-info` closes that, for a date of
       * birth or an address and NOTHING ELSE. So the sentence promises exactly
       * that much and names the two cases a reader will actually be holding —
       * "anything else" is accurate and makes them contact support to find out
       * which side of the line they are on, which is the round trip this is
       * here to remove.
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
        'An approved verification cannot be reset. Support can correct a date of birth or ' +
          'an address on it. Anything else — a name, a document — needs a new verification.',
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

    await this.kycStore.resetUser(userId);
    await this.deleteDocuments(deletable);

    return { message: 'KYC data reset successfully.' };
  }

  /** A client's decided attempts, oldest first — the admin history view. */
  async getHistory(userId: string) {
    return this.kycStore.listAttempts(userId);
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
