import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../../database/database.module';
import type { Db } from '../../../database/db';
import { transactions } from '../../../database/schema';
import { ALERT_KINDS, raiseAlert } from '../../../common/logging/alerts';
import { SYSTEM_ACTOR } from '../../../common/security/actor';
import {
  NOTIFICATION_DISPATCH,
  type NotificationDispatchPort,
} from '../../../common/provisioning/notification-dispatch.port';
import { AuditLogStore } from '../../../store/audit-log.store';
import { EmailService } from '../../email/email.service';
import { UsersStore } from '../../../store/users.store';
import { TransactionsService } from '../transactions.service';
import { RivalClient, type RivalWithdrawal } from './rival.client';
import { RivalConfigService } from './rival-config.service';
import { PaymentIndeterminateError, ValidationError } from '../../../common/errors/domain-errors';

/**
 * The withdrawal leg of the Rival integration: submit on approval, settle on
 * Rival's decision, reconcile everything in between.
 *
 * ## The lifecycle, and where each side's authority ends
 *
 *   client requests (OTP, debit-on-request)          — CRM
 *   CRM admin APPROVES                               — CRM   ← the human gate
 *   submitApproved(): claim → create at Rival        — this file
 *   Rival's operator approves and PAYS the customer  — Rival
 *   withdrawal.completed → settle (SYSTEM_ACTOR)     — this file
 *   withdrawal.rejected/cancelled → refund + email   — this file
 *
 * The CRM admin's approval stays the gate: nothing reaches Rival before it,
 * and Rival's operator is the second pair of eyes on the money leaving.
 *
 * ## ⚠️ Rival's withdrawal create has NO idempotency key
 *
 * A blind retry after a timeout is a SECOND payout request reserving company
 * funds again — the one mistake this file exists to make impossible. The
 * defence is layered:
 *
 *   1. CLAIM FIRST — `rival_submitted_at` is taken with a conditional UPDATE
 *      (`… WHERE rival_submitted_at IS NULL`) BEFORE calling out, so two
 *      racing submitters resolve to one caller (§8.7).
 *   2. `notes: crm:<txId>` travels on the create and round-trips through
 *      Rival's API, so a create that succeeded without answering is FINDABLE.
 *   3. On timeout/5xx the claim is HELD, never cleared — the reconciler
 *      either ADOPTS the orphan by notes-match or, once Rival's pending list
 *      provably lacks it, CLEARS the claim for one more attempt.
 *   4. A definite 4xx clears the claim immediately: Rival refused, nothing
 *      exists, the desk shows why.
 *
 * Crash-safety falls out of the ordering: died between claim and create ⇒
 * claimed-with-nothing, reconciler clears; died between create and record ⇒
 * created-unrecorded, reconciler adopts.
 *
 * ## System transitions carry the system's name
 *
 * Settle and refund here run as `SYSTEM_ACTOR` with `actorKind: 'system'` in
 * the audit row — a webhook IS the system acting, and recording it as an
 * unknown admin would be a false statement in the one record that must not
 * contain any. The money-side idempotency is unchanged: `settle` and
 * `markFailed` are the same conditional transitions the admin desk uses, so
 * the webhook racing a manual settle is harmless by construction.
 */

/** How long a held claim may sit before the reconciler judges the orphan scan. */
const ADOPT_WINDOW_MS = 15 * 60_000;

export type RivalWithdrawalEvent = 'pending' | 'completed' | 'rejected' | 'cancelled';

export type RivalWithdrawalOutcome =
  'applied' | 'duplicate' | 'stale' | 'ignored' | 'not-ours' | 'needs-attention';

@Injectable()
export class RivalWithdrawalsService {
  private readonly logger = new Logger(RivalWithdrawalsService.name);

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Db,
    private readonly rival: RivalClient,
    private readonly config: RivalConfigService,
    private readonly transactions: TransactionsService,
    private readonly auditLog: AuditLogStore,
    private readonly users: UsersStore,
    private readonly email: EmailService,
    @Inject(NOTIFICATION_DISPATCH) private readonly notifications: NotificationDispatchPort,
  ) {}

  /* ── submit on approval ─────────────────────────────────────────────────── */

  /**
   * Submit an approved whish withdrawal to Rival. Post-commit relative to the
   * approval — a Rival outage must not block the approval itself — and safe
   * to call any number of times: the claim admits exactly one create.
   *
   * Never throws. By the time this runs the approval has committed and been
   * shown to the admin; a submission failure is a flagged row on the desk,
   * not an error on an action that succeeded.
   */
  async submitApproved(txId: string): Promise<void> {
    try {
      await this.submitApprovedInner(txId);
    } catch (error) {
      this.logger.error(
        `Rival submission for withdrawal ${txId} failed unexpectedly: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await this.flagNeedsAttention(txId);
    }
  }

  private async submitApprovedInner(txId: string): Promise<void> {
    if (!(await this.config.isEnabled())) return;

    // 1. CLAIM — the conditional update that makes double-create impossible.
    const claimed = await this.db
      .update(transactions)
      .set({ rivalSubmittedAt: new Date() })
      .where(
        and(
          eq(transactions.id, txId),
          eq(transactions.state, 'approved'),
          eq(transactions.direction, 'withdrawal'),
          eq(transactions.provider, 'whish'),
          isNull(transactions.rivalSubmittedAt),
        ),
      )
      .returning();
    if (claimed.length === 0) return; // not eligible, or someone else claimed
    const tx = claimed[0];

    const owner = await this.users.findById(tx.userId);
    const recipientName =
      [owner?.firstName, owner?.lastName].filter(Boolean).join(' ').trim() || 'OxShare client';

    try {
      // 2. CREATE — notes carry our id; that string is the orphan reconcile.
      const created = await this.rival.createWithdrawal({
        amount: tx.amount,
        currency: tx.currency,
        notes: `crm:${tx.id}`,
        recipientName,
        recipientPhone: tx.destination ?? '',
      });

      // 3. RECORD — the partial unique index backs this being one-to-one.
      await this.db
        .update(transactions)
        .set({ rivalWithdrawalId: created.id })
        .where(eq(transactions.id, tx.id));

      this.recordSystemAction('withdrawal.rival.submit', tx.id, {
        rivalWithdrawalId: created.id,
        amount: tx.amount,
        currency: tx.currency,
      });
      this.logger.log(`Withdrawal ${tx.id} submitted to Rival as ${created.id}.`);
    } catch (error) {
      if (error instanceof PaymentIndeterminateError) {
        /*
         * 4b. The dangerous case: Rival may have created it. The claim is
         * HELD — a retry here is the double payout — and the reconciler
         * resolves it by notes-match within the adopt window.
         */
        this.logger.warn(
          `Rival gave no answer creating the withdrawal for ${tx.id}; holding the claim for ` +
            'the reconciler. Do NOT resubmit by hand.',
        );
        await this.flagNeedsAttention(tx.id);
        return;
      }
      /*
       * 4a. A definite refusal: nothing exists at Rival. Clear the claim so
       * the desk's retry button works, flag the row, and tell the operators —
       * the client was already told "approved", and the money will not move
       * until somebody acts.
       */
      const reason = error instanceof Error ? error.message : String(error);
      await this.db
        .update(transactions)
        .set({ rivalSubmittedAt: null, rivalNeedsAttention: true })
        .where(eq(transactions.id, tx.id));
      this.recordSystemAction('withdrawal.rival.submit', tx.id, { failed: true, reason });
      await this.notifications.notifyAdminsWithPermission(
        'withdrawals.approve',
        {
          kind: 'withdrawal.rival_submit_failed',
          params: { transactionId: tx.id, amount: tx.amount, currency: tx.currency, reason },
          dedupeKey: `withdrawal.rival_submit_failed:${tx.id}`,
        },
        { subjectClientId: tx.userId },
      );
      this.logger.error(`Rival refused the withdrawal for ${tx.id}: ${reason}`);
    }
  }

  /* ── inbound events ─────────────────────────────────────────────────────── */

  /**
   * Apply one verified `withdrawal.*` event. The webhook's and the poller's
   * shared entry point — both funnel into the same conditional transitions,
   * so replays, races with the manual desk, and out-of-order deliveries all
   * collapse into no-ops.
   */
  async applyEvent(
    rivalWithdrawalId: string,
    event: RivalWithdrawalEvent,
    payload: { externalReference?: string | null; adminNotes?: string | null },
  ): Promise<RivalWithdrawalOutcome> {
    if (event === 'pending') return 'ignored'; // the echo of our own create

    const [tx] = await this.db
      .select()
      .from(transactions)
      .where(eq(transactions.rivalWithdrawalId, rivalWithdrawalId))
      .limit(1);
    /*
     * Not ours: Rival withdrawals can be created outside the CRM (the
     * dashboard, another system), and their events are not an error — but the
     * create/record race is also possible, so the reconciler's notes-match
     * covers the row this event may belong to. 200 either way.
     */
    if (!tx) return 'not-ours';

    switch (event) {
      case 'completed': {
        if (tx.state === 'success') return 'duplicate';
        if (tx.state !== 'approved') return this.flagDisagreement(tx.id, tx.state, event);
        await this.settleBySystem(tx.id, payload.externalReference ?? rivalWithdrawalId);
        return 'applied';
      }
      case 'rejected':
      case 'cancelled': {
        if (tx.state === 'failure') return 'duplicate';
        if (tx.state !== 'approved') return this.flagDisagreement(tx.id, tx.state, event);
        const reason =
          payload.adminNotes?.trim() ||
          (event === 'rejected'
            ? 'Rejected by the payment platform.'
            : 'Cancelled on the payment platform.');
        await this.refundBySystem(tx.id, reason, event);
        return 'applied';
      }
      default:
        return 'ignored';
    }
  }

  /**
   * Rival paid the customer: record success. The client's balance moved when
   * they asked (debit-on-request), so this is a state change plus the paid
   * notification — the same conditional transition the manual desk uses, so
   * whichever of the two runs second loses harmlessly.
   */
  private async settleBySystem(txId: string, providerRef: string): Promise<void> {
    const row = await this.transactions.settle(
      txId,
      SYSTEM_ACTOR.id,
      providerRef,
      async (tx, settled) => {
        await this.auditLog.record(
          {
            actorId: SYSTEM_ACTOR.id,
            actorEmail: SYSTEM_ACTOR.email,
            actorKind: 'system',
            action: 'withdrawal.settle',
            subjectType: 'transaction',
            subjectId: txId,
            details: {
              amount: settled.amount,
              currency: settled.currency,
              providerRef,
              source: 'rival',
            },
          },
          tx,
        );
        await this.notifications.notify(
          {
            recipient: { kind: 'client', id: settled.userId },
            kind: 'withdrawal.paid',
            params: {
              transactionId: settled.id,
              amount: settled.amount,
              currency: settled.currency,
            },
          },
          tx,
        );
      },
    );
    void this.emailDecision(row, 'paid');
  }

  /** Rival refused after our approval: refund, reasoned, audited, emailed. */
  private async refundBySystem(
    txId: string,
    reason: string,
    event: 'rejected' | 'cancelled',
  ): Promise<void> {
    const row = await this.transactions.markFailed(
      txId,
      reason,
      SYSTEM_ACTOR,
      async (tx, failed) => {
        await this.auditLog.record(
          {
            actorId: SYSTEM_ACTOR.id,
            actorEmail: SYSTEM_ACTOR.email,
            actorKind: 'system',
            action: 'withdrawal.rival.reject',
            subjectType: 'transaction',
            subjectId: txId,
            details: { amount: failed.amount, currency: failed.currency, reason, event },
          },
          tx,
        );
        await this.notifications.notify(
          {
            recipient: { kind: 'client', id: failed.userId },
            kind: 'withdrawal.rejected',
            params: {
              transactionId: failed.id,
              amount: failed.amount,
              currency: failed.currency,
              reason,
            },
          },
          tx,
        );
      },
    );
    void this.emailDecision(row, 'rejected', reason);
  }

  /** Terminal states that DISAGREE (our success, their rejected): a human's. */
  private async flagDisagreement(
    txId: string,
    ourState: string,
    event: string,
  ): Promise<RivalWithdrawalOutcome> {
    await this.flagNeedsAttention(txId);
    raiseAlert(
      this.logger,
      ALERT_KINDS.PAYMENT_STATE_MISMATCH,
      'page',
      `Rival reports a withdrawal ${event} against a CRM row in state '${ourState}'. The two ` +
        'sides disagree about whether this money moved — reconcile by hand.',
      { transactionId: txId, ourState, event },
    );
    return 'needs-attention';
  }

  /* ── the reconciler ─────────────────────────────────────────────────────── */

  /**
   * Resolve claims a crash or timeout left dangling, and poll the decided.
   *
   * Two scans, both bounded:
   *
   *  1. CLAIMED, NOT RECORDED — the create may or may not have happened.
   *     Rival's PENDING list is searched for our `crm:<txId>` note: found ⇒
   *     adopt the id (the create landed, the answer was lost); provably
   *     absent after the adopt window ⇒ clear the claim so one retry is
   *     possible, flag the row. Between the two ⇒ wait, deliberately.
   *  2. RECORDED, STILL APPROVED — the webhook may have been missed. Rival's
   *     stored state is read and terminal outcomes applied through the same
   *     `applyEvent` mapping the webhook uses.
   */
  async reconcile(): Promise<void> {
    if (!(await this.config.isEnabled())) return;
    await this.adoptOrphans();
    await this.pollDecided();
  }

  private async adoptOrphans(): Promise<void> {
    const dangling = await this.db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.state, 'approved'),
          eq(transactions.provider, 'whish'),
          eq(transactions.direction, 'withdrawal'),
          isNull(transactions.rivalWithdrawalId),
          sql`${transactions.rivalSubmittedAt} IS NOT NULL`,
        ),
      )
      .limit(25);
    if (dangling.length === 0) return;

    let pending: RivalWithdrawal[];
    try {
      pending = await this.rival.listPendingWithdrawals();
    } catch (error) {
      // Cannot judge absence without the list — hold every claim.
      this.logger.warn(
        `Orphan scan skipped: Rival's pending list is unavailable. ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    const byNote = new Map(pending.map((w) => [w.notes ?? '', w]));

    for (const tx of dangling) {
      const found = byNote.get(`crm:${tx.id}`);
      if (found) {
        await this.db
          .update(transactions)
          .set({ rivalWithdrawalId: found.id, rivalNeedsAttention: false })
          .where(and(eq(transactions.id, tx.id), isNull(transactions.rivalWithdrawalId)));
        this.logger.log(`Adopted Rival withdrawal ${found.id} for ${tx.id} by notes-match.`);
        continue;
      }
      const claimedAt = tx.rivalSubmittedAt?.getTime() ?? 0;
      if (Date.now() - claimedAt > ADOPT_WINDOW_MS) {
        /*
         * Provably absent: the pending list does not carry our note and the
         * window has passed (a created-but-processing row would still be
         * PENDING at Rival — money-out needs its operator). One retry becomes
         * possible; the flag stays until the desk uses it.
         */
        await this.db
          .update(transactions)
          .set({ rivalSubmittedAt: null, rivalNeedsAttention: true })
          .where(and(eq(transactions.id, tx.id), isNull(transactions.rivalWithdrawalId)));
        this.logger.warn(
          `Cleared a dangling Rival claim on withdrawal ${tx.id}: no matching note at Rival ` +
            `after ${ADOPT_WINDOW_MS / 60000} minutes. The desk may retry the submission.`,
        );
      }
    }
  }

  private async pollDecided(): Promise<void> {
    const waiting = await this.db
      .select({
        id: transactions.id,
        rivalWithdrawalId: transactions.rivalWithdrawalId,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.state, 'approved'),
          eq(transactions.provider, 'whish'),
          eq(transactions.direction, 'withdrawal'),
          sql`${transactions.rivalWithdrawalId} IS NOT NULL`,
          // Give the webhook first claim on fresh submissions.
          lt(transactions.rivalSubmittedAt, new Date(Date.now() - 2 * 60_000)),
        ),
      )
      .limit(25);

    for (const row of waiting) {
      try {
        const remote = await this.rival.getWithdrawal(row.rivalWithdrawalId ?? '');
        if (remote.status === 'COMPLETED') {
          await this.applyEvent(remote.id, 'completed', {
            externalReference: remote.externalReference,
          });
        } else if (remote.status === 'REJECTED' || remote.status === 'CANCELLED') {
          await this.applyEvent(
            remote.id,
            remote.status === 'REJECTED' ? 'rejected' : 'cancelled',
            {
              adminNotes: remote.adminNotes,
            },
          );
        }
        // PENDING / PROCESSING / APPROVED: still Rival's move. Wait.
      } catch (error) {
        this.logger.warn(
          `Could not poll Rival withdrawal ${row.rivalWithdrawalId ?? '?'}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  /* ── the admin cancel, both variants ────────────────────────────────────── */

  /**
   * Cancel an APPROVED withdrawal — the "approved, then thought better of it"
   * case, which has two very different shapes:
   *
   *   not submitted (or submission failed): purely local. Refund with the
   *   operator's reason.
   *
   *   submitted: Rival is asked FIRST. Its 409 means the payout is PROCESSING
   *   — being paid right now — and cancellation is refused with nothing
   *   changed, because "cancelled here, paid there" is the exact split-brain
   *   this integration exists to prevent. On Rival's 200 the refund runs
   *   immediately; the `withdrawal.cancelled` webhook that follows finds a
   *   `failure` row and lands as a duplicate no-op.
   *
   * The caller (AdminMoneyService) owns permissions, scope, the reason list
   * and the actor's audit row — this method owns only the Rival choreography.
   */
  async cancelApproved(tx: {
    id: string;
    rivalWithdrawalId: string | null;
    rivalSubmittedAt: Date | null;
  }): Promise<void> {
    if (!tx.rivalWithdrawalId) {
      if (tx.rivalSubmittedAt) {
        /*
         * Claimed but unrecorded — the create may have landed. Cancelling
         * locally now could refund money Rival goes on to pay. Refused until
         * the reconciler resolves the claim one way or the other.
         */
        throw new ValidationError(
          'This withdrawal has a submission to the payment platform in flight. Wait for ' +
            'reconciliation to confirm whether it was created there, then cancel.',
        );
      }
      return; // never submitted: nothing to unwind remotely
    }

    try {
      await this.rival.cancelWithdrawal(tx.rivalWithdrawalId);
    } catch (error) {
      /*
       * Rival's CONFLICT means PROCESSING: the payout is being executed and
       * can no longer be stopped. Surfaced as-is — the desk shows "wait for
       * the outcome" — and nothing local changes.
       */
      throw new ValidationError(
        'The payment platform is already processing this payout — it can no longer be ' +
          'cancelled. It will settle or fail shortly; act on the outcome instead.',
        { cause: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  /* ── small shared bits ──────────────────────────────────────────────────── */

  /**
   * A fire-and-forget system audit row — `actorKind: 'system'`, because a
   * scheduler or a webhook IS the system acting and recording it as an
   * unknown admin would be false. Detached like `AdminAuditService.record`:
   * an audit-write failure must be loud in the logs and must not fail the
   * money action it describes (the IN-transaction rows for settle/refund use
   * the store directly inside their `withinTx` hooks instead).
   */
  private recordSystemAction(
    action: string,
    subjectId: string,
    details: Record<string, unknown>,
  ): void {
    void this.auditLog
      .record({
        actorId: SYSTEM_ACTOR.id,
        actorEmail: SYSTEM_ACTOR.email,
        actorKind: 'system',
        action,
        subjectType: 'transaction',
        subjectId,
        details,
      })
      .catch((err: Error) =>
        this.logger.error(`Failed to record ${action} for ${subjectId}: ${err.message}`),
      );
  }

  private async flagNeedsAttention(txId: string): Promise<void> {
    await this.db
      .update(transactions)
      .set({ rivalNeedsAttention: true })
      .where(eq(transactions.id, txId));
  }

  private async emailDecision(
    row: { userId: string; amount: string; currency: string },
    decision: 'paid' | 'rejected',
    reason?: string,
  ): Promise<void> {
    try {
      const user = await this.users.findById(row.userId);
      if (!user) return;
      await this.email.sendWithdrawalDecisionEmail(
        user.email,
        user.firstName,
        decision,
        row.amount,
        row.currency,
        reason,
      );
    } catch (error) {
      this.logger.warn(
        `Could not send the withdrawal ${decision} email: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
