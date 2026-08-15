import { basename } from 'path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { KYC_BUCKET, StoredFilesService } from '../../common/uploads/stored-files.service';
import { filenameFromStored } from '../../common/uploads/storage/storage-key';
import {
  KycStore,
  type KycSortKey,
  type KycStatus,
  type KycSubmission,
} from '../../store/kyc.store';
import type { SortOrder } from '../../common/sorting';
import { User, UsersStore } from '../../store/users.store';
import { KycConfigStore } from '../../store/kyc-config.store';
import { EmailService } from '../email/email.service';
import { findProfileProblem, type ProfileFieldRule } from './kyc-profile';
import {
  AuthorizationError,
  ConflictError,
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
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);
}

function reviewerView(user: User) {
  return {
    id: user.id,
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
    const steps = await this.kycConfig.getSteps();
    const personal = steps.find((s) => s.slug === 'personal' && s.enabled);
    if (!personal) {
      /*
       * A plain Error, so this surfaces as a 500 rather than a 400.
       *
       * The caller did nothing wrong — the deployment has no profile step, which
       * `assertMandatoryStepsIntact` makes unreachable through the API and the
       * bootstrap seed makes unreachable in practice. Telling the client their
       * request was invalid would be a lie, and "please contact support" on a 400
       * is the kind of message that gets triaged as a user error for a week.
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
    const user = await this.users.findById(userId);
    return {
      ...submission,
      verificationLevel: user?.verificationLevel ?? 0,
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

    if (step === 'personal') patch['personalInfo'] = { ...submission.personalInfo, ...data };
    else if (step === 'document') patch['document'] = { ...submission.document, ...data };
    else if (step === 'selfie') patch['selfie'] = { ...submission.selfie, ...data };
    else if (step === 'address') patch['addressProof'] = { ...submission.addressProof, ...data };
    else throw new ValidationError(`Unknown step: ${step}`);

    return await this.kycStore.update(userId, patch);
  }

  // ─── Attach uploaded file to a step ────────────────────────────────────────
  async attachFile(userId: string, field: string, filePath: string, fileName: string) {
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
    if (submission.status === 'approved') {
      throw new AuthorizationError('KYC already approved.');
    }
    if (submission.status === 'under_review' || submission.status === 'submitted') {
      throw new AuthorizationError('KYC is under review. You cannot change your documents now.');
    }

    if (field === 'doc_front') {
      await this.kycStore.update(userId, {
        document: {
          ...submission.document,
          frontFilePath: filePath,
          frontFileName: fileName,
          docType: submission.document?.docType ?? 'passport',
        },
      });
    } else if (field === 'doc_back') {
      await this.kycStore.update(userId, {
        document: {
          ...submission.document,
          backFilePath: filePath,
          backFileName: fileName,
          docType: submission.document?.docType ?? 'passport',
        },
      });
    } else if (field === 'selfie') {
      await this.kycStore.update(userId, { selfie: { filePath, fileName } });
    } else if (field === 'address_proof' || field === 'address_proof_2') {
      await this.kycStore.update(userId, {
        addressProof: {
          ...submission.addressProof,
          filePath:
            field === 'address_proof' ? filePath : submission.addressProof?.filePath || filePath,
          fileName:
            field === 'address_proof' ? fileName : submission.addressProof?.fileName || fileName,
          page2FilePath:
            field === 'address_proof_2' ? filePath : submission.addressProof?.page2FilePath,
          page2FileName:
            field === 'address_proof_2' ? fileName : submission.addressProof?.page2FileName,
          docType: submission.addressProof?.docType ?? 'utility_bill',
        },
      });
    } else {
      throw new ValidationError(`Unknown file field: ${field}`);
    }

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
    const problem = findProfileProblem(
      // `PersonalInfo` declares named optional fields; the stored column is
      // `jsonb` and also carries whatever a custom field was named. The cast
      // widens to what is actually there rather than what the interface admits.
      finalSub.personalInfo as unknown as Record<string, unknown>,
      await this.profileRules(),
      new Date(),
    );
    if (problem) {
      throw new ValidationError(problem.message, { kind: problem.kind, fields: problem.fields });
    }

    if (!finalSub.document?.frontFilePath)
      throw new ValidationError('ID document front is required.');
    if (!finalSub.selfie?.filePath) throw new ValidationError('Selfie is required.');
    if (!finalSub.addressProof?.filePath)
      throw new ValidationError('Proof of address is required.');

    /*
     * Read BEFORE the transition below overwrites it — this is what tells a
     * first submission from a client returning to fix one.
     */
    const wasRejected = finalSub.status === 'rejected';

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
    await this.db.transaction(async (tx) => {
      const updated = await this.kycStore.transition(
        userId,
        ['submitted', 'under_review'],
        { status: 'approved', reviewedBy: adminId, reviewedAt: new Date() },
        tx,
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
      await this.users.update(userId, { verificationLevel: 1 }, tx);
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
    await this.db.transaction(async (tx) => {
      const updated = await this.kycStore.transition(
        userId,
        ['submitted', 'under_review', 'approved', 'rejected'],
        {
          status: 'rejected',
          rejectionReason: reason,
          rejectedFields: rejectedFields,
          reviewedBy: adminId,
          reviewedAt: new Date(),
        },
        tx,
      );
      if (!updated) {
        throw new ValidationError(
          `Only a submitted KYC can be rejected; this one is ${submission.status}.`,
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
      throw new AuthorizationError(
        'An approved verification cannot be reset. Contact support if your details have changed.',
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
