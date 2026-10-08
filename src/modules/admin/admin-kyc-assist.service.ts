import { Injectable } from '@nestjs/common';
import { KycClientService, type KycStaff } from '../compliance/kyc-client.service';
import { KycReviewService } from '../compliance/kyc-review.service';
import { assistLayout } from '../compliance/kyc-assist-view';
import { AdminComplianceService } from './admin-compliance.service';
import { AdminAuditService } from './admin-audit.service';
import { AdminsStore } from '../../store/admins.store';
import { UsersStore } from '../../store/users.store';
import { assertActorCan } from '../../common/security/actor';
import { maskedFieldsFor, maskedPathsFor } from '../../common/security/field-mask';
import { isProfileKey } from '../../common/profile/client-profile';
import {
  AuthorizationError,
  NotFoundError,
  ValidationError,
} from '../../common/errors/domain-errors';
import type { AuthenticatedAdmin } from './guards/admin.guard';
import type { SaveKycStepDto, UploadKycFileDto } from '../compliance/dto/kyc.dto';
import type { AssistReturnDto, AssistSubmitDto } from './dto/requests/compliance.dto';

/**
 * "COMPLETE KYC" — staff do a client's KYC FOR them (0210, 8 Oct 2026).
 *
 * For clients who are not technical (elderly people, anyone who struggles): they
 * sign up, or staff create them, and then cannot do the uploads, the steps or
 * the submit. Staff do it, and the result must be exactly as correct as when
 * the client does it. So nothing here decides anything about KYC:
 *
 *  - every write is the CLIENT's own action (`KycClientService`), under the
 *    client's own rules — only while the KYC is open, judged by the same
 *    `stepStates` at submit, approved by the same `approve` (and so by the same
 *    `approvalBlockers`). There is no second road to "verified";
 *  - what differs is only the record of who acted: the profile writer audits a
 *    detail under the administrator, the upload registry names them, a
 *    submission they send carries `submittedByAdminId`, and each action here
 *    writes its own audit row;
 *  - the page is laid out by the server (`assistLayout`), and the answers ride
 *    in the two maps RBAC-03 masks — a reader whose role hides a detail sees it
 *    as hidden and cannot change it.
 *
 * Opening a KYC waiting for review is reading it, as the review page does; to
 * CHANGE it, staff return it first (`returnToEdit`) — never by swapping the
 * evidence under a reviewer, which would leave what the client presented
 * undecided for ever and delete its file.
 */
@Injectable()
export class AdminKycAssistService {
  constructor(
    private readonly kyc: KycClientService,
    private readonly review: KycReviewService,
    private readonly compliance: AdminComplianceService,
    private readonly audit: AdminAuditService,
    private readonly users: UsersStore,
    private readonly admins: AdminsStore,
  ) {}

  /**
   * The client, in this reader's territory — FIRST, before anything about them
   * is read: an out-of-scope client 404s exactly as a missing one does. A write
   * also refuses a suspended client: suspension freezes the account, and a
   * verification completed behind it would be one nobody decided to resume.
   */
  private async clientFor(userId: number, actor: AuthenticatedAdmin, write: boolean) {
    assertActorCan(actor, 'kyc.assist', "complete a client's KYC");
    const client = await this.users.findForAdmin(userId, actor.clientScope);
    if (!client) throw new NotFoundError('Client not found.');
    if (write && client.status === 'suspended') {
      throw new AuthorizationError(
        'This client is suspended. Reactivate them before completing their KYC.',
      );
    }
    return client;
  }

  private staffOf(actor: AuthenticatedAdmin): KycStaff {
    return { id: actor.id, email: actor.email };
  }

  /**
   * The page. `audited` on the GET only: opening it discloses the client's
   * identity like opening their submission does (`kyc.submission.view`); the
   * page returned after a write is that write's answer, audited as the write.
   */
  async view(userId: number, actor: AuthenticatedAdmin, audited = false) {
    const client = await this.clientFor(userId, actor, false);
    const { steps, view, states } = await this.kyc.assistState(userId);

    // The paths this reader's role hides, already expanded with their aliases.
    const masked = new Set(maskedPathsFor('kyc', actor.fieldMask));
    const hidden = (stepSlug: string, fieldName: string) =>
      stepSlug === 'personal' && isProfileKey(fieldName)
        ? masked.has(`personalInfo.${fieldName}`)
        : masked.has('stepData');

    const submittedByName = view.submittedByAdminId
      ? ((await this.admins.namesByIds([view.submittedByAdminId])).get(view.submittedByAdminId) ??
        null)
      : null;
    if (audited) {
      this.audit.record(actor.id, 'kyc.submission.view', 'kyc_submission', userId);
    }
    const layout = assistLayout(steps, view, states, hidden);
    // Read, never changed: every write refuses a suspended client (`clientFor`), so
    // the page says so up front rather than after the typing.
    const suspended = client.status === 'suspended';
    return {
      userId,
      status: view.status,
      ...layout,
      editable: layout.editable && !suspended,
      suspended,
      rejectionReason: view.rejectionReason,
      reverificationRequestedAt: view.reverificationRequestedAt,
      submittedAt: view.submittedAt,
      submittedByName,
      personalInfo: (view.personalInfo ?? {}) as Record<string, string>,
      stepData: view.stepData,
      maskedFields: maskedFieldsFor('kyc', actor.fieldMask),
    };
  }

  async saveStep(userId: number, dto: SaveKycStepDto, actor: AuthenticatedAdmin) {
    await this.clientFor(userId, actor, true);
    await this.kyc.saveStep(userId, dto.step, dto.data, this.staffOf(actor));
    // Which questions, never the answers: a detail's values are in its own audit row.
    this.audit.record(actor.id, 'kyc.assist_step', 'kyc_submission', userId, {
      step: dto.step,
      fields: Object.keys(dto.data ?? {}),
    });
    return this.view(userId, actor);
  }

  async upload(
    userId: number,
    file: { buffer: Buffer; mimetype: string },
    dto: UploadKycFileDto,
    actor: AuthenticatedAdmin,
  ) {
    await this.clientFor(userId, actor, true);
    await this.kyc.uploadFile(userId, file, dto.field, dto.docType, this.staffOf(actor));
    this.audit.record(actor.id, 'kyc.assist_upload', 'kyc_submission', userId, {
      field: dto.field,
      docType: dto.docType ?? null,
    });
    return this.view(userId, actor);
  }

  async submit(userId: number, dto: AssistSubmitDto, actor: AuthenticatedAdmin) {
    await this.clientFor(userId, actor, true);
    /*
     * Asked BEFORE submitting: a caller who may not approve is refused with
     * nothing changed, rather than leaving a submission they believed they had
     * approved waiting in the queue.
     */
    if (dto.approve) assertActorCan(actor, 'kyc.review', 'approve a KYC submission');
    await this.kyc.submit(userId, this.staffOf(actor));
    this.audit.record(actor.id, 'kyc.assist_submit', 'kyc_submission', userId, {
      approve: Boolean(dto.approve),
    });
    // The review page's own approve: its checks, its claim rule, its audit row.
    if (dto.approve) await this.compliance.approveKyc(userId, actor);
    return this.view(userId, actor);
  }

  /**
   * A KYC waiting for review goes back to OPEN so staff can complete it. A
   * return like any — a decision on the record, the level stays 0 — without
   * the client's bell and email, because staff are handling it.
   *
   * Only from waiting-for-review: returning an APPROVED verification would
   * take the client's level away, which is re-verification's job, with its own
   * reason and its own message to the client.
   */
  async returnToEdit(userId: number, dto: AssistReturnDto, actor: AuthenticatedAdmin) {
    await this.clientFor(userId, actor, true);
    assertActorCan(actor, 'kyc.review', 'return a KYC submission');
    const { view } = await this.kyc.assistState(userId);
    if (view.status !== 'submitted' && view.status !== 'under_review') {
      throw new ValidationError('Only a KYC waiting for review can be returned to edit.');
    }
    await this.review.reject(userId, actor.id, dto.reason, [], undefined, null, {
      notifyClient: false,
    });
    this.audit.record(actor.id, 'kyc.assist_return', 'kyc_submission', userId, {
      reason: dto.reason,
    });
    return this.view(userId, actor);
  }
}
