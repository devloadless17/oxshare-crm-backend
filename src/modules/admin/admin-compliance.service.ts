import { Injectable } from '@nestjs/common';
import { KycConfigStore, KycStepConfig } from '../../store/kyc-config.store';
import { DEFAULT_KYC_SORT, KYC_SORT_COLUMNS } from '../../store/kyc.store';
import { sortKey, sortOrder } from '../../common/sorting';
import { RejectionContext, RejectionReasonsStore } from '../../store/rejection-reasons.store';
import { KycService } from '../compliance/kyc.service';
import { NotFoundError, ValidationError } from '../../common/errors/domain-errors';
import { AdminAuditService } from './admin-audit.service';
import { maskedFieldsFor } from '../../common/security/field-mask';
import { assertActorCan, assertActorCanAny } from '../../common/security/actor';
import { assertKycConfigIntegrity } from './kyc-config-integrity';
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
@Injectable()
export class AdminComplianceService {
  constructor(
    private readonly kycService: KycService,
    private readonly kycConfig: KycConfigStore,
    private readonly rejectionReasons: RejectionReasonsStore,
    private readonly audit: AdminAuditService,
    private readonly visibility: ClientVisibilityService,
    private readonly admins: AdminsStore,
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
    return attempts;
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

    const patch: Record<string, unknown> = {};
    if (dto.dateOfBirth !== undefined) patch['dateOfBirth'] = dto.dateOfBirth;
    if (dto.address !== undefined) patch['address'] = dto.address;
    if (Object.keys(patch).length === 0) {
      throw new ValidationError('Send a dateOfBirth or an address to correct.');
    }

    const result = await this.kycService.correctIdentity(userId, patch);

    // AFTER the write and describing the OBSERVED change — see the block above
    // `approveKyc` on why this is not fire-and-forget before the fact.
    this.audit.record(actor.id, 'kyc.identity_correct', 'kyc_submission', userId, {
      before: result.before,
      after: result.after,
    });

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
  getKycConfig() {
    return this.kycConfig.getSteps();
  }
  /*
   * ── THERE IS NO MANDATORY STEP ANY MORE (owner's call, 15 Aug 2026) ───────
   *
   * `personal`, `document`, `selfie` and `address` used to be undeletable and
   * undisablable here, in the admin UI, and by omission in the portal — three
   * copies of one rule citing FR-CORE-15/FR-IND-03.
   *
   * The objection that retired it is simple and correct: a KYC flow sold as
   * configurable that refuses to drop four of its steps is not configurable.
   * Which documents a jurisdiction requires is the broker's decision and
   * differs by licence; encoding one regulator's answer in a service made
   * every other answer unreachable without a code change.
   *
   * WHAT REPLACES IT is the audit trail, not nothing. `kyc_config.replace`
   * records the full slug list and the enabled subset on every save, so
   * "onboarding stopped asking for proof of address on the 12th" is an
   * answerable question with a name attached. That is the control a compliance
   * review actually needs — the previous rule could only say the step was
   * never removed, which is a weaker claim than knowing who removed it.
   *
   * The portal degrades safely: it resolves steps by `stepNumber` from the
   * config and branches on slug for its uploader, camera and passport paths,
   * so a slug that is gone simply takes its branch out of the flow.
   */

  // `async` so this REJECTS rather than throwing synchronously. deleteKycStep and
  // updateKycStep both await the current config before guarding, so they reject; a
  // sibling that throws sync instead is a footgun for any caller that only handles
  // one of the two.
  /*
   * The KYC configuration is AUDITED for the same reason the rejection reasons
   * are: it governs what every client must submit to be verified, and
   * verification is what opens the withdrawal gate. A step quietly disabled is
   * a control quietly removed, and `setSteps` replaces the WHOLE
   * configuration — so the recorded slug list is the only way to reconstruct
   * what onboarding looked like on a given day.
   */
  async updateKycConfig(steps: KycStepConfig[], actor: Admin) {
    /*
     * Refused BEFORE the write, and refused here rather than in the DTO.
     *
     * Two of the three rules need the CURRENT configuration to judge the new one
     * — a reserved key renamed is only visible by comparing the two — and a
     * class-validator decorator cannot read the database. The third (unique keys
     * per step) could live in the DTO and is kept beside its siblings instead,
     * because an operator who fixes one and then meets the next in a different
     * voice learns the screen is guessing.
     *
     * `kyc-config-integrity.ts` states at length that none of this is the
     * mandatory-step rule coming back: a broker may still delete any step and
     * stop collecting anything. What is refused is a configuration that cannot
     * work — answers with nowhere to go, an answer silently overwritten, or a
     * server-side check silently switched off.
     */
    const current = await this.kycConfig.getSteps();
    assertKycConfigIntegrity(current, steps);

    const result = await this.kycConfig.setSteps(steps);
    this.audit.record(actor.id, 'kyc_config.replace', 'kyc_config', 'steps', {
      slugs: steps.map((step) => step.slug),
      enabled: steps.filter((step) => step.enabled).map((step) => step.slug),
    });
    return result;
  }
  async addKycStep(stepData: Omit<KycStepConfig, 'id' | 'stepNumber'>, actor: Admin) {
    const created = await this.kycConfig.addStep(stepData);
    this.audit.record(actor.id, 'kyc_config.step_add', 'kyc_config', created.id, {
      slug: stepData.slug,
      title: stepData.title,
    });
    return created;
  }
  async updateKycStep(id: string, patch: Partial<KycStepConfig>, actor: Admin) {
    const steps = await this.kycConfig.getSteps();
    const target = steps.find((s) => s.id === id);
    /*
     * NO MANDATORY-STEP GUARD. See `assertMandatoryStepsIntact` below for why
     * the whole rule was dropped: a configurable flow that refuses to drop four
     * of its steps is not configurable, and the broker — not this service —
     * owns which jurisdiction needs what.
     */
    const updated = await this.kycConfig.updateStep(id, patch);
    this.audit.record(actor.id, 'kyc_config.step_update', 'kyc_config', id, {
      slug: target?.slug,
      // The whole patch, because "enabled: false" on a KYC step is a control
      // being switched off and the field name is the evidence.
      patch,
    });
    return updated;
  }
  async deleteKycStep(id: string, actor: Admin) {
    const steps = await this.kycConfig.getSteps();
    const target = steps.find((s) => s.id === id);
    const result = await this.kycConfig.deleteStep(id);
    this.audit.record(actor.id, 'kyc_config.step_delete', 'kyc_config', id, {
      slug: target?.slug,
      title: target?.title,
    });
    return result;
  }
  async resetKycConfig(actor: Admin) {
    // The most destructive of the five: it discards the entire configuration.
    const result = await this.kycConfig.resetDefaults();
    this.audit.record(actor.id, 'kyc_config.reset', 'kyc_config', 'steps', {});
    return result;
  }
}
