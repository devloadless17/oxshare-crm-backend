import { Injectable } from '@nestjs/common';
import { KycConfigStore, KycStepConfig, MANDATORY_KYC_SLUGS } from '../../store/kyc-config.store';
import { RejectionContext, RejectionReasonsStore } from '../../store/rejection-reasons.store';
import { KycService } from '../compliance/kyc.service';
import { NotFoundError, ValidationError } from '../../common/errors/domain-errors';
import { AdminAuditService } from './admin-audit.service';
import { Admin } from '../../store/admins.store';
import { assertActorCan } from '../../common/security/actor';

/**
 * The admin side of compliance: the KYC review queue, the step configurator,
 * and the configurable rejection reasons both KYC and withdrawals draw on
 * (FR-ADM-03).
 */
@Injectable()
export class AdminComplianceService {
  constructor(
    private readonly kycService: KycService,
    private readonly kycConfig: KycConfigStore,
    private readonly rejectionReasons: RejectionReasonsStore,
    private readonly audit: AdminAuditService,
  ) {}

  // ─── KYC: list all ────────────────────────────────────────────────────────
  listKyc(query: { status?: string; q?: string; page?: string; limit?: string }) {
    return this.kycService.listAll({
      status: query.status as import('../../store/kyc.store').KycStatus | undefined,
      q: query.q,
      page: parseInt(query.page ?? '1', 10) || 1,
      limit: parseInt(query.limit ?? '25', 10) || 25,
    });
  }
  /**
   * Open one submission — and record that its PII was read.
   *
   * FSD §10 requires "restricted PII access" and "attributable, reviewable
   * records". Fetching a document BYTE was already audited and audited well
   * (PLATFORM-CONVENTIONS R-6.6, `uploads.controller.ts`), but opening the
   * submission itself recorded nothing — and this response carries the date of
   * birth, the address, the nationality and the phone number. "Which admin
   * looked at this client's details" was unanswerable while "which admin
   * fetched this client's passport image" was answerable, which is an odd place
   * for the line to fall.
   *
   * Fire-and-forget, unlike the document read. That one refuses to serve if it
   * cannot be recorded, because it is the stronger of the two claims; failing a
   * reviewer's page load over an audit write would be the wrong trade for a
   * screen they open dozens of times an hour, and the row that matters most —
   * the DECISION — is recorded separately either way.
   */
  async getKyc(userId: string, actor?: Admin) {
    const submission = await this.kycService.getByUserId(userId);
    if (actor) {
      this.audit.record(actor.id, 'kyc.submission.view', 'kyc_submission', userId);
    }
    return submission;
  }
  /**
   * Previously decided attempts.
   *
   * A read, so it is not asserted on the actor here beyond the route guard —
   * unlike the three decisions below, which change privilege and are asserted
   * in both places (R-4.3).
   */
  getKycHistory(userId: string) {
    return this.kycService.getHistory(userId);
  }
  /*
   * The three decisions below assert on the ACTOR, not only in the guard —
   * R-4.3.
   *
   * A guard runs on an HTTP request. These methods are what a queued job would
   * call, and BullMQ is coming (ARCHITECTURE §9) — the moment a KYC decision is
   * queued rather than executed inline, a guard-only check stops running and
   * nothing fails, which is what makes it dangerous. They were the last
   * privilege-affecting admin methods still guarded only at the edge: approving
   * KYC moves a client's verificationLevel to 1, and that is what unlocks
   * withdrawals.
   *
   * ── The audit row is written AFTER the decision, and describes what happened
   *
   * Each of these used to read:
   *
   *     const result = this.kycService.approve(userId, actor.id);   // not awaited
   *     this.audit.record(…, { verificationLevel: 1 });             // fire-and-forget
   *     return result;
   *
   * `record()` dispatches a detached write and returns void, so the audit row
   * was written BEFORE the decision resolved and REGARDLESS of whether it
   * succeeded. Every refusal path still produced one: no such submission, a
   * submission the client never submitted, one already approved, a failed store
   * write. The details payload made it worse — `{ verificationLevel: 1 }` was a
   * literal, so the row asserted a promotion the code had not performed and
   * could not have performed.
   *
   * That is the opposite of what the log is for. D-21's justification is that
   * this is the one record which cannot be reconstructed afterwards, FSD §10
   * requires "attributable, reviewable records of administrative actions", and
   * FSD §14 accepts requirements on the evidence of an audit-log entry. A log
   * that reports approvals which did not happen is worse than no log, because it
   * will be believed.
   *
   * So: await the decision, then record it, and record the OBSERVED outcome
   * rather than the intended one. A throw now skips the write entirely, which is
   * the correct behaviour — nothing happened, so nothing is recorded.
   *
   * Still fire-and-forget once it is reached, which remains the right trade
   * here: the decision has already been persisted, and losing the audit row must
   * not un-make it. Making the two atomic needs an Executor threaded through
   * KycStore and UsersStore (see kyc.service.ts) — a separate, larger change.
   */
  // ─── KYC: approve ─────────────────────────────────────────────────────────
  async approveKyc(userId: string, actor: Admin) {
    assertActorCan(actor, 'kyc.review', 'approve a KYC submission');
    const result = await this.kycService.approve(userId, actor.id);
    this.audit.record(actor.id, 'kyc.approve', 'kyc_submission', userId, {
      status: result.status,
      verificationLevel: result.user?.verificationLevel,
    });
    return result;
  }
  // ─── KYC: claim for review ────────────────────────────────────────────────
  async claimKyc(userId: string, actor: Admin) {
    assertActorCan(actor, 'kyc.review', 'claim a KYC submission for review');
    const result = await this.kycService.claim(userId, actor.id);
    this.audit.record(actor.id, 'kyc.claim', 'kyc_submission', userId, { status: result.status });
    return result;
  }
  // ─── KYC: reject ──────────────────────────────────────────────────────────
  async rejectKyc(
    userId: string,
    actor: Admin,
    reason?: string,
    rejectedFields?: string[],
    reasonId?: string,
  ) {
    assertActorCan(actor, 'kyc.review', 'reject a KYC submission');
    const adminId = actor.id;
    let effectiveReason = reason?.trim();
    if (reasonId) {
      const configured = await this.rejectionReasons.findById(reasonId);
      if (!configured) throw new NotFoundError('Rejection reason not found.');
      effectiveReason = effectiveReason
        ? `${configured.label} — ${effectiveReason}`
        : configured.label;
    }
    if (!effectiveReason) {
      throw new ValidationError('A rejection reason (reasonId or reason text) is required.');
    }
    const result = await this.kycService.reject(userId, adminId, effectiveReason, rejectedFields);
    this.audit.record(adminId, 'kyc.reject', 'kyc_submission', userId, {
      status: result.status,
      verificationLevel: result.user?.verificationLevel,
      reason: effectiveReason,
      rejectedFields,
    });
    return result;
  }
  // ─── Rejection reasons (FR-ADM-03 configurable list) ──────────────────────
  async listRejectionReasons(context?: RejectionContext) {
    return await this.rejectionReasons.findAll(context);
  }
  async createRejectionReason(context: RejectionContext, label: string) {
    return await this.rejectionReasons.create(context, label);
  }
  async updateRejectionReason(id: string, label: string) {
    const updated = await this.rejectionReasons.update(id, label);
    if (!updated) throw new NotFoundError('Rejection reason not found.');
    return updated;
  }
  async deleteRejectionReason(id: string) {
    if (!(await this.rejectionReasons.delete(id))) {
      throw new NotFoundError('Rejection reason not found.');
    }
    return { message: 'Rejection reason deleted.' };
  }
  // ─── KYC Configurator ───────────────────────────────────────────────────────
  getKycConfig() {
    return this.kycConfig.getSteps();
  }
  /**
   * FR-CORE-15 / FR-IND-03, enforced here rather than only in the admin UI.
   *
   * `setSteps` replaces the whole configuration, so a payload that omits or
   * disables a mandatory step silently removes it from onboarding — the portal
   * filters /kyc/config to enabled steps. The admin screen has always blocked
   * that; the API accepted it, which made the rule a property of one screen
   * rather than of the system.
   */
  private assertMandatoryStepsIntact(steps: KycStepConfig[]): void {
    const enabledSlugs = new Set(steps.filter((s) => s.enabled).map((s) => s.slug));
    const missing = MANDATORY_KYC_SLUGS.filter((slug) => !enabledSlugs.has(slug));
    if (missing.length > 0) {
      throw new ValidationError(
        `These KYC steps are required and must stay enabled: ${missing.join(', ')}. ` +
          'They are mandated by FR-CORE-15/FR-IND-03 and the client portal submits by slug.',
        { missing },
      );
    }
  }

  // `async` so this REJECTS rather than throwing synchronously. deleteKycStep and
  // updateKycStep both await the current config before guarding, so they reject; a
  // sibling that throws sync instead is a footgun for any caller that only handles
  // one of the two.
  async updateKycConfig(steps: KycStepConfig[]) {
    this.assertMandatoryStepsIntact(steps);
    return this.kycConfig.setSteps(steps);
  }
  addKycStep(stepData: Omit<KycStepConfig, 'id' | 'stepNumber'>) {
    return this.kycConfig.addStep(stepData);
  }
  async updateKycStep(id: string, patch: Partial<KycStepConfig>) {
    const steps = await this.kycConfig.getSteps();
    const target = steps.find((s) => s.id === id);
    if (target && MANDATORY_KYC_SLUGS.includes(target.slug)) {
      // Disabling or re-slugging a mandatory step is the same removal by another
      // route: the portal submits by slug and filters to enabled.
      if (patch.enabled === false) {
        throw new ValidationError(
          `"${target.title}" is required by the KYC spec (FR-CORE-15) and cannot be disabled.`,
          { slug: target.slug },
        );
      }
      if (patch.slug !== undefined && patch.slug !== target.slug) {
        throw new ValidationError(
          `"${target.title}" is a required step and its slug cannot be changed — the client ` +
            'portal submits by slug.',
          { slug: target.slug },
        );
      }
    }
    return this.kycConfig.updateStep(id, patch);
  }
  async deleteKycStep(id: string) {
    const steps = await this.kycConfig.getSteps();
    const target = steps.find((s) => s.id === id);
    if (target && MANDATORY_KYC_SLUGS.includes(target.slug)) {
      throw new ValidationError(
        `"${target.title}" is required by the KYC spec (FR-CORE-15) and cannot be deleted.`,
        { slug: target.slug },
      );
    }
    return this.kycConfig.deleteStep(id);
  }
  resetKycConfig() {
    return this.kycConfig.resetDefaults();
  }
}
