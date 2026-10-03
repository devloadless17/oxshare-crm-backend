import { Inject, Injectable, Logger } from '@nestjs/common';
import { AdminsStore } from '../../store/admins.store';
import {
  answerKeysOf,
  flagLabel,
  returnableItems,
  returnedFlags,
  reviewLayout,
} from './kyc-review-layout';
import { approvalBlockers } from './kyc-step-state';
import {
  KycStore,
  type KycSortKey,
  type KycStatus,
  type KycSubmission,
} from '../../store/kyc.store';
import type { SortOrder } from '../../common/sorting';
import { User, UsersStore } from '../../store/users.store';
import { KycConfigStore, type KycStepConfig } from '../../store/kyc-config.store';
import { EmailService } from '../email/email.service';
import {
  ConflictError,
  FieldValidationError,
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
import { ClientProfileService, type ProfileActor } from '../profile/client-profile.service';
import { withPersonalView } from './kyc-personal-view';

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

/**
 * The DESK's side of KYC — the queue, one submission, claim and release,
 * approve, reject, correcting a verified identity, requesting
 * re-verification, and the attempt history. The client's side is
 * `KycClientService`.
 */
@Injectable()
export class KycReviewService {
  private readonly logger = new Logger(KycReviewService.name);

  constructor(
    private readonly email: EmailService,
    private readonly kycStore: KycStore,
    private readonly users: UsersStore,
    private readonly kycConfig: KycConfigStore,
    /*
     * The db handle, for the decisions that must be atomic. Used ONLY to open
     * a transaction — every read and write still goes through a store.
     */
    @Inject(DRIZZLE_DB) private readonly db: Db,
    /** Bell rows — the decision to the client, in the decision transaction. */
    @Inject(NOTIFICATION_DISPATCH) private readonly notifications: NotificationDispatchPort,
    /**
     * Resolves the holder's NAME for the refusal in `assertNotHeldByAnother`;
     * only read on the contested path.
     */
    private readonly admins: AdminsStore,
    /** The one write path for the client's identity (0139) — `correctIdentity`. */
    private readonly profile: ClientProfileService,
  ) {}

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
    } = withPersonalView(submission, user);
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
      withPersonalView(submission, client),
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
      /*
       * Re-judge on the profile as it stands under lock: the KYC row is held by
       * `transition`, then the users row (the order profile writers take), so a
       * desk edit between the check above and here cannot be approved past, and
       * history records the values actually verified.
       */
      const locked = (await this.users.findByIdForUpdate(userId, tx)) ?? client;
      const lateBlockers = approvalBlockers(
        steps,
        withPersonalView(updated, locked),
        new Date(),
      ).map((item) => item.message ?? item.label);
      if (lateBlockers.length > 0) {
        throw new ConflictError(
          `This submission changed while it was being approved: ${lateBlockers.join('; ')}. ` +
            'Reload it and try again.',
        );
      }
      await this.kycStore.archiveAttempt(withPersonalView(updated, locked), tx);
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
      // An ADMIN decision: written in the client's stored language, not the request's.
      void this.email.sendKycDecisionEmail(
        user.email,
        user.firstName,
        'approved',
        undefined,
        undefined,
        user.locale,
      );
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
  async requestReverification(
    userId: number,
    adminId: string,
    reason: string,
    items: string[],
    /** The reason as an Arabic reader is shown it (0179); null when there is none. */
    reasonAr: string | null = null,
  ) {
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
          rejectionReasonAr: reasonAr ?? undefined,
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
      await this.kycStore.archiveAttempt(withPersonalView(updated, user), tx, {
        reverification: true,
      });
      // The money gate closes with the return, in the same commit.
      await this.users.update(userId, { verificationLevel: 0 }, tx);
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
          params: { reason, ...(reasonAr ? { reasonAr } : {}) },
        },
        tx,
      );
    });

    if (user) {
      void this.email.sendKycReverificationEmail(
        user.email,
        user.firstName,
        reason,
        // Named in the client's own language — the email is written in it.
        flags.map((id) => flagLabel(id, steps, submission, [], user.locale)),
        user.locale,
        reasonAr,
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
    /** The reason as an Arabic reader is shown it (0179); null when there is none. */
    reasonAr: string | null = null,
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
          rejectionReasonAr: reasonAr ?? undefined,
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
        { ...withPersonalView(updated, await this.users.findById(userId)), ...decided },
        tx,
        { reasonId, sameEvidenceAsLast: decided !== undefined },
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
      // Same stance as approve(): the row and the decision are one commit. The
      // reason rides in params so the bell can say what to fix.
      await this.notifications.notify(
        {
          recipient: { kind: 'client', id: userId },
          kind: 'kyc.rejected',
          params: { reason, ...(reasonAr ? { reasonAr } : {}) },
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
        // Named as every screen names them — "National ID (Back Side)", never `doc_back` —
        // and in the client's own language, which the email is written in.
        flags.map((id) => flagLabel(id, steps, submission, [], user.locale)),
        user.locale,
        reasonAr,
      );
    }

    return this.getByUserId(userId);
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
}
