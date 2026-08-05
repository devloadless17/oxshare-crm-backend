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
  // ─── KYC: get one ─────────────────────────────────────────────────────────
  getKyc(userId: string) {
    return this.kycService.getByUserId(userId);
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
   */
  // ─── KYC: approve ─────────────────────────────────────────────────────────
  async approveKyc(userId: string, actor: Admin) {
    assertActorCan(actor, 'kyc.review', 'approve a KYC submission');
    const result = this.kycService.approve(userId, actor.id);
    this.audit.record(actor.id, 'kyc.approve', 'kyc_submission', userId, { verificationLevel: 1 });
    return result;
  }
  // ─── KYC: claim for review ────────────────────────────────────────────────
  async claimKyc(userId: string, actor: Admin) {
    assertActorCan(actor, 'kyc.review', 'claim a KYC submission for review');
    const result = this.kycService.claim(userId, actor.id);
    this.audit.record(actor.id, 'kyc.claim', 'kyc_submission', userId);
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
    const result = this.kycService.reject(userId, adminId, effectiveReason, rejectedFields);
    this.audit.record(adminId, 'kyc.reject', 'kyc_submission', userId, {
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
