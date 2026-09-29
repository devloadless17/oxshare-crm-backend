import { Inject, Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import {
  DEFAULT_KYC_STEPS,
  KycConfigStore,
  kycConfigVersion,
  type KycStepConfig,
} from '../../store/kyc-config.store';
import { DEFAULT_KYC_SORT, KYC_SORT_COLUMNS } from '../../store/kyc.store';
import { sortKey, sortOrder } from '../../common/sorting';
import { RejectionContext, RejectionReasonsStore } from '../../store/rejection-reasons.store';
import { KycService } from '../compliance/kyc.service';
import {
  FieldValidationError,
  KycBuilderOutdatedError,
  KycConfigStaleError,
  NotFoundError,
  ValidationError,
} from '../../common/errors/domain-errors';
import { AdminAuditService } from './admin-audit.service';
import { maskedFieldsFor } from '../../common/security/field-mask';
import { assertActorCan, assertActorCanAny } from '../../common/security/actor';
import { assertKycConfigIntegrity } from './kyc-config-integrity';
import { describeKycConfigChanges } from './kyc-config-diff';
import { newCustomSlug } from '../../common/kyc/identity-core';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db } from '../../database/db';
import { ClientVisibilityService } from '../../common/security/client-visibility.service';
import type { CorrectKycIdentityDto } from './dto/requests/compliance.dto';
import type { AuthenticatedAdmin } from './guards/admin.guard';
import type { Admin } from '../../store/admins.store';
import { NEEDS_REVIEW, NEEDS_REVIEW_STATUSES } from '../../store/kyc.store';
import { AdminsStore } from '../../store/admins.store';

/**
 * The admin side of compliance: the KYC review queue, the step configurator,
 * and the configurable rejection reasons both KYC and withdrawals draw on
 * (FR-ADM-03).
 */
/**
 * The KYC builder format a whole-form save must declare (Phase 2, 29 Sep 2026):
 * identity placements, per-step evidence requirements, every step editable.
 */
export const KYC_BUILDER_FORMAT = 2;

@Injectable()
export class AdminComplianceService {
  constructor(
    private readonly kycService: KycService,
    private readonly kycConfig: KycConfigStore,
    private readonly rejectionReasons: RejectionReasonsStore,
    private readonly audit: AdminAuditService,
    private readonly visibility: ClientVisibilityService,
    private readonly admins: AdminsStore,
    /**
     * For the one transaction every change to the KYC form runs in
     * (`changeKycConfig`). APPENDED LAST: this class is constructed
     * positionally in tests.
     */
    @Inject(DRIZZLE_DB) private readonly db: Db,
  ) {}

  /**
   * Resolve the holders of the claims on a page, in ONE query.
   *
   * A reviewer's NAME rather than their id, because "who has this" is the only
   * question a claim exists to answer for a colleague, and a uuid answers it
   * to nobody. Null when the row is unclaimed, and null too when the
   * administrator who held it has since been deleted — an absence the screen
   * states rather than filling with an id.
   *
   * Batched: a page of 25 that resolved a name per row would be 25 round trips
   * for a column, which is how a list screen becomes slow without anyone
   * noticing a single slow query.
   */
  private async withReviewerNames<T extends { reviewedBy?: string }>(
    rows: T[],
  ): Promise<(T & { reviewedByName: string | null })[]> {
    const names = await this.admins.namesByIds(rows.map((r) => r.reviewedBy ?? '').filter(Boolean));
    return rows.map((row) => ({
      ...row,
      reviewedByName: row.reviewedBy ? (names.get(row.reviewedBy) ?? null) : null,
    }));
  }

  // ─── KYC: list all ────────────────────────────────────────────────────────
  async listKyc(
    query: {
      status?: string;
      q?: string;
      page?: string;
      limit?: string;
      sort?: string;
      order?: string;
    },
    actor: AuthenticatedAdmin,
  ) {
    /*
     * EITHER key, matching the route guard exactly — the "reading is not
     * deciding" split, decided (owner, 13 Aug). The catalog has always
     * labelled `kyc.view` "View Submissions & the Review Queue" while every
     * queue endpoint demanded `kyc.review`, so a compliance READER got the
     * nav item, the route, and a 403 where the queue should be. Reads accept
     * either key now; the three DECISIONS below stay `kyc.review` only.
     */
    assertActorCanAny(actor, ['kyc.view', 'kyc.review'], 'list KYC submissions');
    const page = await this.kycService.listAll({
      // `needs_review` is a SET, not a column value — see kyc.store.ts.
      ...(query.status === NEEDS_REVIEW
        ? { statuses: NEEDS_REVIEW_STATUSES }
        : { status: query.status as import('../../store/kyc.store').KycStatus | undefined }),
      q: query.q,
      page: parseInt(query.page ?? '1', 10) || 1,
      limit: parseInt(query.limit ?? '25', 10) || 25,
      // The predicate goes into the queue's own query, so an out-of-scope
      // submission is never in the page and never in the status counts either.
      scope: actor.clientScope,
      // R-2.5. An unrecognised key is a 400 naming the allowed ones, never a
      // silent fallback to the default ordering.
      sort: sortKey(query.sort, KYC_SORT_COLUMNS, DEFAULT_KYC_SORT, 'KYC submissions'),
      order: sortOrder(query.order),
    });
    /*
     * RBAC-03 ON THE QUEUE. The mask was computed and alias-expanded for every
     * admin request (`admin.guard.ts`) and then applied on the CLIENT screens
     * only — so a role that hid `client.email` read every address off the KYC
     * queue one tab away. The queue's rows carry the same person under
     * `user.*`; the catalog's aliases map `client.email` to `kyc.user.email`.
     */
    return {
      ...page,
      items: await this.withReviewerNames(page.items),
      maskedFields: maskedFieldsFor('kyc', actor.fieldMask),
    };
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
  async getKyc(userId: string, actor?: AuthenticatedAdmin) {
    // Before the submission is read, so an out-of-scope client's details never
    // reach a log line or an error on the way to being refused.
    if (actor) await this.visibility.assertVisible(userId, actor.clientScope);
    const submission = await this.kycService.getByUserId(userId);
    if (actor) {
      this.audit.record(actor.id, 'kyc.submission.view', 'kyc_submission', userId);
    }
    /*
     * The mask, at last, on the screen holding the most sensitive data. This
     * response carries the date of birth, the address, the nationality, the
     * phone and the email — and none of it was ever masked, while
     * `client-fields.json` claimed the alias expansion "closes the KYC bypass".
     * The expansion happened; nothing applied it here.
     */
    if (!actor) return submission;
    const [withReviewer] = await this.withReviewerNames([submission]);
    return {
      ...withReviewer,
      maskedFields: maskedFieldsFor('kyc', actor.fieldMask),
    };
  }
  /**
   * Previously decided attempts.
   *
   * A read, so it is not asserted on the actor here beyond the route guard —
   * unlike the three decisions below, which change privilege and are asserted
   * in both places (R-4.3).
   */
  async getKycHistory(userId: string, actor: AuthenticatedAdmin) {
    assertActorCanAny(actor, ['kyc.view', 'kyc.review'], "view a client's KYC history");
    /*
     * The gap `client-scope-enforcement.spec.ts` found.
     *
     * This route carried `@ScopedToClients` and scoped nothing — the exact
     * failure mode the enforcement spec exists for, and the reason a
     * declaration alone was never going to be enough. Previously decided
     * attempts carry the same identity data as the live submission, so an
     * out-of-scope read here is the same disclosure by a different URL.
     */
    await this.visibility.assertVisible(userId, actor.clientScope);
    /*
     * ⚠️ MASKED, like the live submission beside it.
     *
     * This returned raw attempts, and every one of them carries the same
     * `personalInfo` the detail screen masks — email, phone, date of birth,
     * nationality, address. So a reviewer whose role hides `client.email` read
     * it straight off the history panel, one tab from the field that correctly
     * showed nothing.
     *
     * That is the SECOND time this shape has bitten: `getKyc` above records
     * that `client-fields.json` claimed the alias expansion "closes the KYC
     * bypass" while nothing applied it, and the exports had the same hole. The
     * expansion is not the enforcement — a response that never calls
     * `applyMask` is unmasked however many aliases the catalog declares.
     *
     * The response stays an ARRAY rather than gaining a `maskedFields`
     * envelope: the history panel renders attempts and the live submission's
     * own `maskedFields` already tells the screen which fields are hidden for
     * this viewer, so a second copy would be one more thing to keep in step.
     */
    const attempts = await this.kycService.getHistory(userId);
    /*
     * R-6.6, recorded — and it was not.
     *
     * `getKyc` above writes `kyc.submission.view` for the live record; this read
     * returns the same identity data one decision older and wrote nothing, so a
     * reviewer could work through a client's superseded submissions leaving no
     * trace. The access comment ten lines up already argues the two are the same
     * disclosure; only the audit disagreed.
     *
     * Fire-and-forget, matching its sibling rather than the document read: the
     * same trade that comment names, since failing a reviewer's panel over an
     * audit write is the wrong one for a screen opened all day.
     */
    this.audit.record(actor.id, 'kyc.history.view', 'kyc_submission', userId);
    /*
     * WHO DECIDED EACH PAST ATTEMPT — the name, not the id.
     *
     * `KycAttemptDto` has always declared `reviewedByName`, and this returned the
     * archived rows raw, so the field the contract promised was absent from every
     * response. The id was archived correctly (`archiveAttempt` copies
     * `reviewedBy`); only the lookup was missing.
     *
     * Reported from production as "I can see who approved, not who rejected".
     * The current submission's card and the queue both name the reviewer — but a
     * rejection is almost always a PAST attempt by the time anyone reads it: the
     * client corrects and resubmits, which archives the rejection. So the decision
     * people most need attributed was rendered here, anonymously.
     *
     * Masking is untouched by this: the global `FieldMaskInterceptor` masks by the
     * route's declared shape, and `reviewedByName` is an administrator attribute
     * (`@NotClientField`), never a client's.
     */
    return this.withReviewerNames(attempts);
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
  // ─── KYC: correct an identity field on an approved submission (CORE-18) ────
  /**
   * The authorization, visibility and audit half. The state machine, the
   * merge and the re-validation are `KycService.correctIdentity`, which
   * carries the reasoning.
   *
   * ITS OWN PERMISSION, not `clients.edit` and not `kyc.review`. Changing an
   * identity field on a KYC-BEARING record is not the same power as fixing a
   * surname — `PATCH /admin/clients/:id/email` is already split out on exactly
   * that reasoning — and it is not the same power as deciding a submission: a
   * reviewer approves or rejects what the client claimed, this rewrites the
   * claim. `kyc.edit` is taken and means the step BUILDER, which is a third
   * thing again.
   *
   * ⚠️ AUDITED WITH BOTH SIDES. "Who changed this date of birth and what was it
   * before" is the entire question somebody asks later, and a row carrying only
   * the new value cannot answer it — the client's own copy of the old value is
   * the thing in dispute. `ib.level_change` is the precedent (`before`/`after`,
   * the rung on both sides).
   *
   * Subject `kyc_submission`, not `user`: the values live in
   * `kyc_submissions.personalInfo` and nowhere else, and an audit row filed
   * against the wrong subject is one a reviewer reading the submission's
   * history will not find.
   */
  async correctKycIdentity(userId: string, dto: CorrectKycIdentityDto, actor: AuthenticatedAdmin) {
    assertActorCan(actor, 'kyc.identity.correct', 'correct identity details');
    // FIRST, as everywhere on this surface: an out-of-scope client 404s exactly
    // as a missing one does, so nothing about the response says they exist.
    await this.visibility.assertVisible(userId, actor.clientScope);

    const { reason, ...fields } = dto;
    const patch: Record<string, unknown> = Object.fromEntries(
      Object.entries(fields).filter(([, value]) => value !== undefined),
    );
    if (Object.keys(patch).length === 0) {
      throw new ValidationError('Name a detail to correct.');
    }

    /*
     * The audit row is written BY the profile write, in its transaction — the
     * observed before → after, never a claim made before the fact, and never a
     * change without its row. Filed as `kyc.identity_correct` on the submission,
     * where a reviewer reading its history looks.
     */
    const result = await this.kycService.correctIdentity(
      userId,
      patch,
      { kind: 'admin', id: actor.id, email: actor.email },
      reason,
    );
    return result.submission;
  }

  // ─── KYC: approve ─────────────────────────────────────────────────────────
  async approveKyc(userId: string, actor: AuthenticatedAdmin) {
    assertActorCan(actor, 'kyc.review', 'approve a KYC submission');
    // FIRST, before the submission is read: an out-of-scope client 404s exactly
    // as a missing one does, so nothing about the response says they exist.
    await this.visibility.assertVisible(userId, actor.clientScope);
    const result = await this.kycService.approve(userId, actor.id);
    this.audit.record(actor.id, 'kyc.approve', 'kyc_submission', userId, {
      status: result.status,
      verificationLevel: result.user?.verificationLevel,
    });
    /*
     * RBAC-03 on the DECISION's own response.
     *
     * `getKyc` masks this submission and these did not, so a reviewer who
     * cannot see the client's phone number on the review screen got it back in
     * the body of the Claim button sitting on that screen. The read was
     * protected and the write handed the value over — the same shape as the
     * history leak (20332db), one method along.
     *
     * Proved on the wire before it was fixed: PATCH .../claim returned
     * personalInfo.phone, personalInfo.dateOfBirth, personalInfo.nationality
     * and user.email, with no `maskedFields` at all.
     */
    return {
      ...result,
      maskedFields: maskedFieldsFor('kyc', actor.fieldMask),
    };
  }
  // ─── KYC: claim for review ────────────────────────────────────────────────
  async claimKyc(userId: string, actor: AuthenticatedAdmin) {
    assertActorCan(actor, 'kyc.review', 'claim a KYC submission for review');
    await this.visibility.assertVisible(userId, actor.clientScope);
    const result = await this.kycService.claim(userId, actor.id);
    this.audit.record(actor.id, 'kyc.claim', 'kyc_submission', userId, { status: result.status });
    /*
     * RBAC-03 on the DECISION's own response.
     *
     * `getKyc` masks this submission and these did not, so a reviewer who
     * cannot see the client's phone number on the review screen got it back in
     * the body of the Claim button sitting on that screen. The read was
     * protected and the write handed the value over — the same shape as the
     * history leak (20332db), one method along.
     *
     * Proved on the wire before it was fixed: PATCH .../claim returned
     * personalInfo.phone, personalInfo.dateOfBirth, personalInfo.nationality
     * and user.email, with no `maskedFields` at all.
     */
    return {
      ...result,
      maskedFields: maskedFieldsFor('kyc', actor.fieldMask),
    };
  }
  /**
   * Hand a claimed submission back to the queue.
   *
   * Gated exactly like a DECISION — `kyc.review` plus the client being in this
   * actor's territory — and for the same reason `KycService.release` gives:
   * approve and reject already accept an `under_review` row from any reviewer
   * who can see it, so a claim has never been a lock. Anyone who could decide
   * it may put it back instead; a stricter rule here would make "stuck" the
   * outcome of an ordinary handover.
   *
   * The previous holder is recorded in the audit row rather than checked in a
   * guard: that is what makes a release accountable, which is the property
   * this needs, instead of restricted, which is the property that strands work.
   */
  async releaseKyc(userId: string, actor: AuthenticatedAdmin) {
    assertActorCan(actor, 'kyc.review', 'hand a KYC submission back to the queue');
    await this.visibility.assertVisible(userId, actor.clientScope);
    // Read BEFORE the release, or the id it names has already been cleared.
    const before = await this.kycService.getByUserId(userId).catch(() => null);
    /*
     * `kyc.claim.override` is what lets a reviewer hand back a submission a
     * COLLEAGUE is holding. Without it they may only release their own claim —
     * the same rule approve and reject already enforce, which this route used
     * to leave open (a claim could be removed by anyone, so the lock the other
     * two enforce could be taken off its hinges).
     */
    const result = await this.kycService.release(
      userId,
      actor.id,
      actor.permissions.includes('kyc.claim.override'),
    );
    this.audit.record(actor.id, 'kyc.release', 'kyc_submission', userId, {
      status: result.status,
      // Who was holding it — the question anyone reading this row will ask.
      releasedFrom: before?.reviewedBy ?? null,
      // Stated because it is the interesting case: a reviewer taking a
      // colleague's claim back into the pool, rather than dropping their own.
      ownClaim: before?.reviewedBy === actor.id,
    });
    /*
     * RBAC-03 on the DECISION's own response.
     *
     * `getKyc` masks this submission and these did not, so a reviewer who
     * cannot see the client's phone number on the review screen got it back in
     * the body of the Claim button sitting on that screen. The read was
     * protected and the write handed the value over — the same shape as the
     * history leak (20332db), one method along.
     *
     * Proved on the wire before it was fixed: PATCH .../claim returned
     * personalInfo.phone, personalInfo.dateOfBirth, personalInfo.nationality
     * and user.email, with no `maskedFields` at all.
     */
    return {
      ...result,
      maskedFields: maskedFieldsFor('kyc', actor.fieldMask),
    };
  }
  // ─── KYC: reject ──────────────────────────────────────────────────────────
  async rejectKyc(
    userId: string,
    actor: AuthenticatedAdmin,
    reason?: string,
    rejectedFields?: string[],
    reasonId?: string,
  ) {
    assertActorCan(actor, 'kyc.review', 'reject a KYC submission');
    await this.visibility.assertVisible(userId, actor.clientScope);
    const adminId = actor.id;
    let effectiveReason = reason?.trim();
    if (reasonId) {
      const configured = await this.rejectionReasons.findById(reasonId);
      if (!configured) throw new NotFoundError('Rejection reason not found.');
      /*
       * A KYC decision takes a KYC reason. The list is shared with withdrawals
       * and partner applications, and nothing checked which one was chosen — a
       * verification could be returned "for" a withdrawal reason. Now that the
       * id is KEPT on the decision (0151), it must mean what it says.
       */
      if (configured.context !== 'kyc') {
        throw new FieldValidationError('That is not a KYC rejection reason.', {
          reasonId: 'Choose one of the KYC rejection reasons.',
        });
      }
      effectiveReason = effectiveReason
        ? `${configured.label} — ${effectiveReason}`
        : configured.label;
    }
    if (!effectiveReason) {
      throw new ValidationError('A rejection reason (reasonId or reason text) is required.');
    }
    const result = await this.kycService.reject(
      userId,
      adminId,
      effectiveReason,
      rejectedFields,
      reasonId,
    );
    this.audit.record(adminId, 'kyc.reject', 'kyc_submission', userId, {
      status: result.status,
      verificationLevel: result.user?.verificationLevel,
      reason: effectiveReason,
      rejectedFields,
    });
    /*
     * RBAC-03 on the DECISION's own response.
     *
     * `getKyc` masks this submission and these did not, so a reviewer who
     * cannot see the client's phone number on the review screen got it back in
     * the body of the Claim button sitting on that screen. The read was
     * protected and the write handed the value over — the same shape as the
     * history leak (20332db), one method along.
     *
     * Proved on the wire before it was fixed: PATCH .../claim returned
     * personalInfo.phone, personalInfo.dateOfBirth, personalInfo.nationality
     * and user.email, with no `maskedFields` at all.
     */
    return {
      ...result,
      maskedFields: maskedFieldsFor('kyc', actor.fieldMask),
    };
  }
  /**
   * Return an APPROVED verification to the client to update — the reviewer's
   * answer to a detail that changed materially (`KycService.requestReverification`).
   * The same power as a rejection (`kyc.review`, in scope), audited with the
   * reason and the items asked for.
   */
  async requestReverification(
    userId: string,
    actor: AuthenticatedAdmin,
    reason: string,
    items: string[],
  ) {
    assertActorCan(actor, 'kyc.review', 'return a verification to the client');
    await this.visibility.assertVisible(userId, actor.clientScope);
    const result = await this.kycService.requestReverification(userId, actor.id, reason, items);
    this.audit.record(actor.id, 'kyc.reverification_request', 'kyc_submission', userId, {
      reason,
      items: result.rejectedFields,
    });
    return {
      ...result,
      maskedFields: maskedFieldsFor('kyc', actor.fieldMask),
    };
  }

  // ─── Rejection reasons (FR-ADM-03 configurable list) ──────────────────────
  async listRejectionReasons(context?: RejectionContext) {
    return await this.rejectionReasons.findAll(context);
  }
  /*
   * These three are AUDITED, and it is worth saying why they were not.
   *
   * A rejection reason is the sentence a client is emailed when their
   * withdrawal or verification is refused (FR-ADM-03). It does not look like
   * money, so it did not get a line — but changing one changes what every
   * affected client is told from that moment on, and it could be rewritten
   * leaving no trace of who did it or what it said before. `before`/`after` are
   * recorded for exactly that reason: the current value answers nothing about
   * a complaint concerning last month's wording.
   */
  async createRejectionReason(context: RejectionContext, label: string, actor: Admin) {
    const created = await this.rejectionReasons.create(context, label);
    this.audit.record(actor.id, 'rejection_reason.create', 'rejection_reason', created.id, {
      context,
      label,
    });
    return created;
  }
  async updateRejectionReason(id: string, label: string, actor: Admin) {
    const before = await this.rejectionReasons.findById(id);
    const updated = await this.rejectionReasons.update(id, label);
    if (!updated) throw new NotFoundError('Rejection reason not found.');
    this.audit.record(actor.id, 'rejection_reason.update', 'rejection_reason', id, {
      before: before?.label,
      after: label,
    });
    return updated;
  }
  async deleteRejectionReason(id: string, actor: Admin) {
    const before = await this.rejectionReasons.findById(id);
    if (!(await this.rejectionReasons.delete(id))) {
      throw new NotFoundError('Rejection reason not found.');
    }
    // The label is recorded because the row is gone: without it the trail says
    // an id was deleted and nothing about what clients used to be told.
    this.audit.record(actor.id, 'rejection_reason.delete', 'rejection_reason', id, {
      label: before?.label,
    });
    return { message: 'Rejection reason deleted.' };
  }
  // ─── KYC Configurator ───────────────────────────────────────────────────────
  /** The form, and the version the builder's next save must name (`If-Match`). */
  async getKycConfig(): Promise<{ steps: KycStepConfig[]; version: string }> {
    const steps = await this.kycConfig.getSteps();
    return { steps, version: kycConfigVersion(steps) };
  }

  /*
   * ── WHAT THE BROKER OWNS, AND WHAT THE PLATFORM DOES (26 Sep 2026) ────────
   *
   * This block used to open "THERE IS NO MANDATORY STEP ANY MORE (owner's call,
   * 15 Aug 2026)", and argued — correctly — that a KYC flow sold as configurable
   * that refuses to drop four of its steps is not configurable, because which
   * documents a jurisdiction requires is the broker's decision.
   *
   * Then a broker's edit removed a client's first name from the form, and
   * re-adding it made an anonymous custom box instead. So the owner ruled again:
   * the client's IDENTITY is not configuration. The identity fields, the four
   * built-in steps and the documents that prove identity and address belong to
   * the platform (`common/kyc/identity-core.ts`); Personal Information and
   * Identity Document are always on; Selfie and Proof of Address can still be
   * switched off — which keeps the half of the old argument that was right.
   * Everything else stays the broker's.
   *
   * Every change — the whole-form save and the four per-step routes alike —
   * goes through ONE path below, so none of them can skip a rule the others
   * enforce. They used to differ: the delete route checked nothing and could
   * leave a form with no steps at all.
   */

  async updateKycConfig(
    steps: KycStepConfig[],
    actor: AuthenticatedAdmin,
    version?: string,
    format?: number,
  ) {
    if (format !== KYC_BUILDER_FORMAT) {
      throw new KycBuilderOutdatedError(
        'This console is out of date. Reload the page to get the current KYC builder, then ' +
          'make your change again.',
      );
    }
    const { after } = await this.changeKycConfig(
      actor,
      { action: 'kyc_config.replace', version },
      () => steps,
    );
    return after;
  }

  async addKycStep(stepData: Omit<KycStepConfig, 'id' | 'stepNumber'>, actor: AuthenticatedAdmin) {
    const id = `step-${uuidv4()}`;
    const { after } = await this.changeKycConfig(
      actor,
      { action: 'kyc_config.step_add' },
      (current) => [...current, { ...stepData, id, stepNumber: current.length + 1 }],
    );
    return after.find((step) => step.id === id)!;
  }

  async updateKycStep(id: string, patch: Partial<KycStepConfig>, actor: AuthenticatedAdmin) {
    const { after } = await this.changeKycConfig(
      actor,
      { action: 'kyc_config.step_update' },
      (current) => {
        if (!current.some((step) => step.id === id)) throw new NotFoundError('KYC step not found.');
        return current.map((step) => (step.id === id ? { ...step, ...patch, id } : step));
      },
    );
    return after.find((step) => step.id === id)!;
  }

  async deleteKycStep(id: string, actor: AuthenticatedAdmin) {
    await this.changeKycConfig(actor, { action: 'kyc_config.step_delete' }, (current) => {
      if (!current.some((step) => step.id === id)) throw new NotFoundError('KYC step not found.');
      return current.filter((step) => step.id !== id);
    });
    return true;
  }

  /**
   * Back to the default form. The built-in steps keep their ids — they are the
   * same four steps, returned to their defaults — so the audit reads as what
   * happened rather than as four removals and four additions.
   */
  async resetKycConfig(actor: AuthenticatedAdmin) {
    const { after } = await this.changeKycConfig(actor, { action: 'kyc_config.reset' }, (current) =>
      DEFAULT_KYC_STEPS.map((step) => ({
        ...step,
        id: current.find((existing) => existing.slug === step.slug)?.id ?? step.id,
      })),
    );
    return after;
  }

  /**
   * THE ONE WAY THE FORM CHANGES: locked, checked against the version it was
   * edited from, checked for permission and integrity, written, and audited —
   * as one transaction.
   *
   *  - LOCKED, so two saves cannot both read version N and both write: the
   *    second waits, then finds version N+1 and is refused rather than silently
   *    replacing the first operator's work.
   *  - PERMISSION by what the save DOES. `PUT /admin/kyc-config` needs only
   *    `kyc.edit`, and a whole-form save can add or remove steps — so a role
   *    without `kyc.create` / `kyc.delete` could do through PUT exactly what the
   *    per-step routes refuse it. Now adding a step needs `kyc.create` and
   *    removing one `kyc.delete`, whichever route carried the change.
   *  - AUDITED IN THE TRANSACTION, with what changed in the builder's own words
   *    (`describeKycConfigChanges`). The form decides what every client must
   *    hand over to be verified; a change to it without its record must not
   *    stand.
   */
  private async changeKycConfig(
    actor: AuthenticatedAdmin,
    /** What the audit row records it as, and the version the change was made from. */
    { action, version }: { action: string; version?: string },
    change: (current: KycStepConfig[]) => KycStepConfig[],
  ): Promise<{ before: KycStepConfig[]; after: KycStepConfig[] }> {
    return this.db.transaction(async (tx) => {
      await this.kycConfig.lockForChange(tx);
      const before = await this.kycConfig.getSteps(tx);
      if (version !== undefined && version !== kycConfigVersion(before)) {
        throw new KycConfigStaleError(
          'Someone else changed the KYC form while you were editing it. Reload to see their ' +
            'changes, then make yours again.',
        );
      }
      const next = withStepAddresses(before, change(before));
      assertMayChangeSteps(actor, before, next);
      assertKycConfigIntegrity(before, next);

      const after = await this.kycConfig.setSteps(next, tx);
      await this.audit.recordWithin(tx, actor.id, action, 'kyc_config', 'steps', {
        slugs: after.map((step) => step.slug),
        enabled: after.filter((step) => step.enabled).map((step) => step.slug),
        changes: describeKycConfigChanges(before, after),
      });
      return { before, after };
    });
  }
}

/**
 * A new step of the broker's gets its address from its title
 * (`newCustomSlug`) when none was given; an existing step sent without one
 * keeps the one it has. Addresses given are left for the integrity rules to
 * judge.
 */
function withStepAddresses(
  before: readonly KycStepConfig[],
  next: readonly KycStepConfig[],
): KycStepConfig[] {
  const taken = new Set(next.map((step) => step.slug).filter(Boolean));
  return next.map((step) => {
    if (step.slug) return step;
    const known = before.find((existing) => existing.id === step.id)?.slug;
    const slug = known ?? newCustomSlug(step.title ?? '', taken);
    taken.add(slug);
    return { ...step, slug };
  });
}

/** Adding a step needs `kyc.create`, removing one `kyc.delete` — whichever route carries it. */
function assertMayChangeSteps(
  actor: AuthenticatedAdmin,
  before: readonly KycStepConfig[],
  after: readonly KycStepConfig[],
): void {
  const had = new Set(before.map((step) => step.id));
  const has = new Set(after.map((step) => step.id));
  if (after.some((step) => !step.id || !had.has(step.id))) {
    assertActorCan(actor, 'kyc.create', 'add a step to the KYC form');
  }
  if (before.some((step) => !has.has(step.id))) {
    assertActorCan(actor, 'kyc.delete', 'remove a step from the KYC form');
  }
}
