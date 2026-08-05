import { Injectable, Logger } from '@nestjs/common';
import { KycStore, KycStatus } from '../../store/kyc.store';
import { User, UsersStore } from '../../store/users.store';
import { KycConfigStore } from '../../store/kyc-config.store';
import { EmailService } from '../email/email.service';
import { findProfileProblem, type ProfileFieldRule } from './kyc-profile';
import {
  AuthorizationError,
  NotFoundError,
  ValidationError,
} from '../../common/errors/domain-errors';

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
    private readonly kycStore: KycStore,
    private readonly users: UsersStore,
    private readonly kycConfig: KycConfigStore,
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

    // A resubmission after rejection starts a fresh review — stale rejection
    // data must not follow it into the admin queue.
    return await this.kycStore.update(userId, {
      status: 'submitted',
      submittedAt: new Date(),
      rejectionReason: undefined,
      rejectedFields: undefined,
    });
  }

  // ─── Admin: list all (paginated, searchable, with per-status counts) ───────
  async listAll(filter: { status?: KycStatus; q?: string; page?: number; limit?: number } = {}) {
    const page = Math.max(1, filter.page ?? 1);
    const limit = Math.min(100, Math.max(1, filter.limit ?? 25));

    // One joined query, filtered/sorted/paginated in SQL, plus one grouped
    // count. The previous version loaded every submission and then issued one
    // this.users.findById per row inside Promise.all — 1+N, which at 50K rows
    // fires 50,001 queries in a burst and can exhaust the pool that
    // WalletService.post() needs for its FOR UPDATE lock.
    return this.kycStore.findPageWithUsers({ status: filter.status, q: filter.q, page, limit });
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
     * ORDER MATTERS, and it is the only thing making this safe without a
     * transaction: the status is written FIRST, the verification level second.
     * These are two stores and two writes, so a crash between them leaves one
     * of two states — and this order picks the harmless one.
     *
     *   status approved, level 0  → the client looks verified but cannot
     *                               withdraw. Re-approving fixes it.
     *   level 1, status not approved → the client can move money with no
     *                               approved submission behind them.
     *
     * The second is the one that costs money, so it must be the one that cannot
     * happen. Making this genuinely atomic needs an Executor threaded through
     * KycStore and UsersStore — recorded as a follow-up rather than half-done.
     */
    await this.kycStore.update(userId, {
      status: 'approved',
      reviewedBy: adminId,
      reviewedAt: new Date(),
    });

    await this.users.update(userId, { verificationLevel: 1 });

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
    await this.kycStore.update(userId, { status: 'under_review', reviewedBy: adminId });
    return this.getByUserId(userId);
  }

  // ─── Admin: reject ─────────────────────────────────────────────────────────
  async reject(userId: string, adminId: string, reason: string, rejectedFields: string[] = []) {
    const submission = await this.kycStore.findByUserId(userId);
    if (!submission) throw new NotFoundError('KYC submission not found.');
    const user = await this.users.findById(userId);

    await this.kycStore.update(userId, {
      status: 'rejected',
      rejectionReason: reason,
      rejectedFields: rejectedFields,
      reviewedBy: adminId,
      reviewedAt: new Date(),
    });

    /*
     * Take the verification level back.
     *
     * `approve()` raises it to 1 and nothing lowered it, so an admin who
     * approved by mistake and then rejected left the client REJECTED and still
     * VERIFIED — the status said no while the money path said yes, and
     * verification level is what gates withdrawals. Rejection is the statement
     * that the evidence is not accepted, so the level it granted goes with it.
     *
     * Unconditional rather than conditional on the previous status: level 1 has
     * exactly one source in Phase 1 — approval — so a rejected client should
     * hold none of it, whichever path they arrived by.
     */
    await this.users.update(userId, { verificationLevel: 0 });

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

  // ─── Reset User KYC ────────────────────────────────────────────────────────
  async resetKyc(userId: string) {
    await this.kycStore.resetUser(userId);
    return { message: 'KYC data reset successfully.' };
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
