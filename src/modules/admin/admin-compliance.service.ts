import { Injectable } from '@nestjs/common';
import { KycConfigStore, KycStepConfig } from '../../store/kyc-config.store';
import { RejectionContext, RejectionReasonsStore } from '../../store/rejection-reasons.store';
import { KycService } from '../compliance/kyc.service';
import { NotFoundError, ValidationError } from '../../common/errors/domain-errors';
import { AdminAuditService } from './admin-audit.service';

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
  // ─── KYC: approve ─────────────────────────────────────────────────────────
  async approveKyc(userId: string, adminId: string) {
    const result = this.kycService.approve(userId, adminId);
    this.audit.record(adminId, 'kyc.approve', 'kyc_submission', userId, { verificationLevel: 1 });
    return result;
  }
  // ─── KYC: claim for review ────────────────────────────────────────────────
  async claimKyc(userId: string, adminId: string) {
    const result = this.kycService.claim(userId, adminId);
    this.audit.record(adminId, 'kyc.claim', 'kyc_submission', userId);
    return result;
  }
  // ─── KYC: reject ──────────────────────────────────────────────────────────
  async rejectKyc(
    userId: string,
    adminId: string,
    reason?: string,
    rejectedFields?: string[],
    reasonId?: string,
  ) {
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
  updateKycConfig(steps: KycStepConfig[]) {
    return this.kycConfig.setSteps(steps);
  }
  addKycStep(stepData: Omit<KycStepConfig, 'id' | 'stepNumber'>) {
    return this.kycConfig.addStep(stepData);
  }
  updateKycStep(id: string, patch: Partial<KycStepConfig>) {
    return this.kycConfig.updateStep(id, patch);
  }
  deleteKycStep(id: string) {
    return this.kycConfig.deleteStep(id);
  }
  resetKycConfig() {
    return this.kycConfig.resetDefaults();
  }
}
