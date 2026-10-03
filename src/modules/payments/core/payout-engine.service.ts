import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import { and, asc, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../../database/database.module';
import type { Db } from '../../../database/db';
import { transactions } from '../../../database/schema';
import { ALERT_KINDS, raiseAlert } from '../../../common/logging/alerts';
import { SYSTEM_ACTOR, assertActorCan, type Actor } from '../../../common/security/actor';
import {
  NOTIFICATION_DISPATCH,
  type NotificationDispatchPort,
} from '../../../common/provisioning/notification-dispatch.port';
import { ResourceChangedPublisher } from '../../../common/realtime/resource-changed';
import { ValidationError } from '../../../common/errors/domain-errors';
import { violatesConstraint } from '../../../common/errors/pg-violation';
import { AuditLogStore } from '../../../store/audit-log.store';
import { UsersStore } from '../../../store/users.store';
import {
  PaymentProviderEventsStore,
  type ProviderEventOutcome,
  type ProviderEventSource,
  type ProviderEventType,
} from '../../../store/payment-provider-events.store';
import { EmailService } from '../../email/email.service';
import { TRANSACTION_LEDGER, type TransactionLedgerPort } from './payments-ledger.port';
import {
  PaymentProviderRegistry,
  providerWebhookUrl,
} from '../providers/payment-provider-registry';
import {
  ProviderBusyError,
  type NoticeOutcome,
  type PaymentChannel,
  type PaymentProviderAdapter,
  type PaymentRoute,
  type PayoutQuote,
  type PayoutRail,
  type PayoutReport,
  type ProviderNotice,
} from '../providers/payment-provider';
import { ChannelSwitchesService, type ChannelSwitch } from './channel-switches.service';
import { systemSentenceArabic } from '../../../common/i18n/reason-arabic';

type TransactionRow = typeof transactions.$inferSelect;

/**
 * Who will pay a withdrawal and what it costs — the desk's line before it
 * approves (0173). `paused` carries the sentence approval would refuse with.
 */
export interface PayoutPlan {
  payer: 'provider' | 'desk' | 'paused';
  /** The provider's name when a provider is involved; null for a desk payout. */
  provider: string | null;
  /** Why nobody can pay it right now (`paused` only). */
  reason: string | null;
  /** What the provider will be asked to move, its fee (null when unknown), what arrives. */
  gross: string | null;
  fee: string | null;
  net: string | null;
}

/** What an approval does with a withdrawal — decided once, at approval (`decide`). */
export type PayoutDecision =
  /** The provider pays; the row waits in `approved` for its word. */
  | { kind: 'provider' }
  /** A person sends the money; approval records it paid. */
  | { kind: 'desk' }
  /** Nobody can pay it right now — approval is refused with this sentence. */
  | { kind: 'paused'; reason: string };

/** What the engine did with one of the provider's reports. */
export type PayoutOutcome = 'applied' | 'duplicate' | 'ignored' | 'not-ours' | 'needs-attention';

/** A fixed, client-safe sentence: a provider's own refusal text never reaches a client. */
export const CLIENT_SAFE_PROVIDER_REFUSAL =
  'The payment provider could not complete this withdrawal.';

/** How far before a claim a provider's clock may place the payout it made for it. */
const CLOCK_SKEW_MS = 5 * 60_000;
/** A fresh submission is the webhook's to report first; the poll waits this long. */
const QUIET_MS = 2 * 60_000;
const BATCH = 25;

const REPORT_EVENT: Record<Exclude<PayoutReport['status'], 'pending'>, ProviderEventType> = {
  completed: 'payout.completed',
  rejected: 'payout.rejected',
  cancelled: 'payout.cancelled',
  failed: 'payout.rejected',
};

const OUTCOME_LOG: Record<PayoutOutcome, { outcome: ProviderEventOutcome; reason: string | null }> =
  {
    applied: { outcome: 'applied', reason: null },
    duplicate: { outcome: 'ignored', reason: 'Already recorded.' },
    ignored: { outcome: 'ignored', reason: null },
    'not-ours': { outcome: 'ignored', reason: 'No withdrawal here carries this payout.' },
    'needs-attention': {
      outcome: 'rejected',
      reason: 'Disagrees with the state recorded here; a person decides.',
    },
  };

/**
 * THE PAYOUT ENGINE — every automated payout, whichever provider pays it (0173).
 *
 * It is Rival's payout pipeline (0052–0172) made provider-neutral: the same
 * claim-before-call, the same held claim on an unknown outcome, the same
 * adoption of an orphan, the same conditional settle and refund — now asking
 * each provider's adapter (`PayoutRail`) only how to talk to it. Written once,
 * because two copies of the code that stops a double payout drift apart.
 *
 * ## The lifecycle, and where each side's authority ends
 *
 *   client requests (debit-on-request)               — CRM
 *   CRM admin APPROVES                               — CRM   ← the human gate
 *   submit(): claim → the provider's create          — here
 *   the provider pays (Rival's operator; 3pay: now)  — the provider
 *   its word → settle or refund (SYSTEM_ACTOR)       — here
 *
 * ## ⚠️ No provider today can be RETRIED blindly
 *
 * Neither Rival nor 3pay takes an idempotency key on a payout, so a retry after
 * a lost answer is a SECOND payout. The defence, layered:
 *
 *   1. CLAIM FIRST — `provider_submitted_at` by a conditional UPDATE before the
 *      call, so two submitters resolve to one caller.
 *   2. FINDABLE — a `reference` provider stores ours (Rival: `crm:<id>`); for a
 *      provider with NO reference (3pay), the claim writes a FINGERPRINT of
 *      what was asked and `transactions_payout_fingerprint_uq` allows one
 *      unresolved payout per fingerprint, so the lost one is the only match.
 *   3. UNKNOWN IS HELD — no answer, a 5xx: the claim stays and the reconciler
 *      ADOPTS the payout it finds, or — only once the provider's list provably
 *      lacks it after the adoption window — clears the claim and hands the
 *      row to a PERSON (Resend or Refund). Never an automatic resend.
 *   4. A DEFINITE refusal clears the claim: nothing exists there. A momentary
 *      one (a rate limit) requeues by itself — a payout never created cannot
 *      be paid twice; any other goes to a person.
 *
 * Crash-safety falls out of the ordering: died between claim and create ⇒ held
 * with nothing there ⇒ judged absent ⇒ a person; died between create and record
 * ⇒ held ⇒ adopted.
 *
 * ## System transitions carry the system's name
 *
 * Settle and refund run as SYSTEM_ACTOR, `actorKind: 'system'`. The money-side
 * idempotency is the desk's own conditional transitions (`settle`,
 * `markFailed`), so a report racing a manual action loses harmlessly.
 */
@Injectable()
export class PayoutEngine {
  private readonly logger = new Logger(PayoutEngine.name);
  private readonly providerEvents: PaymentProviderEventsStore;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Db,
    private readonly registry: PaymentProviderRegistry,
    private readonly switches: ChannelSwitchesService,
    @Inject(TRANSACTION_LEDGER) private readonly transactions: TransactionLedgerPort,
    private readonly auditLog: AuditLogStore,
    private readonly users: UsersStore,
    private readonly email: EmailService,
    @Inject(NOTIFICATION_DISPATCH) private readonly notifications: NotificationDispatchPort,
    private readonly resourceChanged: ResourceChangedPublisher,
    private readonly config: ConfigService,
  ) {
    this.providerEvents = new PaymentProviderEventsStore(db);
  }

  /* ── the approval's question ───────────────────────────────────────────── */

  /**
   * WHO PAYS THIS WITHDRAWAL, decided at approval.
   *
   * A payout the provider will make is approved into `approved` and settled by
   * its word. A desk payout — or an automated one whose provider declares
   * `whenUnavailable: 'desk'` (Rival) while it cannot pay — goes straight to
   * `success`, because the operator approving it is the one sending the money.
   * Anything else nobody can pay right now, and approving it is PAUSED with a
   * sentence: a switched-off channel, or a `wait` provider (3pay) switched off.
   *
   * ⚠️ `provider` must agree with `submit`'s claim below, or the row would sit
   * in `approved` with the client debited and nobody paying. The claim
   * re-checks everything; the sweep re-offers anything a pause or a restart
   * left unclaimed.
   */
  async decide(
    tx: { direction: string; providerCode: string; channelCode: string },
    /** Every switched-off channel, when the caller already read them (a list). */
    offSwitches?: ReadonlyMap<string, ChannelSwitch>,
  ): Promise<PayoutDecision> {
    if (tx.direction !== 'withdrawal') return { kind: 'desk' };
    const route: PaymentRoute = { providerCode: tx.providerCode, channelCode: tx.channelCode };
    const found = this.registry.payoutRail(route);
    if (!found) return { kind: 'desk' };

    const off = offSwitches
      ? offSwitches.get(ChannelSwitchesService.key(route, 'payout'))
      : await this.switches.offSwitch(route, 'payout');
    if (off) return { kind: 'paused', reason: this.switches.pausedSentence(route, 'payout', off) };
    if (await found.adapter.isUsable()) return { kind: 'provider' };
    if (found.rail.whenUnavailable === 'desk') return { kind: 'desk' };
    return {
      kind: 'paused',
      reason:
        `${found.adapter.name} is switched off or not set up, so it cannot pay this withdrawal. ` +
        `Switch ${found.adapter.name} on under Payment providers, or cancel the withdrawal.`,
    };
  }

  /**
   * The desk's line for one withdrawal: who pays, and — when a provider does —
   * what it will be asked to move. `offSwitches` lets a list read them once.
   */
  async plan(
    tx: {
      direction: string;
      providerCode: string;
      channelCode: string;
      amount: string;
      currency: string;
    },
    offSwitches?: ReadonlyMap<string, ChannelSwitch>,
  ): Promise<PayoutPlan> {
    const decision = await this.decide(tx, offSwitches);
    const found = this.registry.payoutRail(tx);
    if (decision.kind === 'desk' || !found) {
      return { payer: 'desk', provider: null, reason: null, gross: null, fee: null, net: null };
    }
    let quote: PayoutQuote | null = null;
    try {
      quote = await found.rail.quote(found.channel, tx.amount, tx.currency);
    } catch {
      // A quote the provider cannot give right now is not a reason to hide the row.
    }
    return {
      payer: decision.kind,
      provider: found.adapter.name,
      reason: decision.kind === 'paused' ? decision.reason : null,
      gross: quote?.gross ?? null,
      fee: quote?.fee ?? null,
      net: quote?.net ?? null,
    };
  }

  /** The approval dialog's figures: what the provider moves, its fee, what arrives. */
  async quote(tx: TransactionRow): Promise<(PayoutQuote & { provider: string }) | null> {
    const found = this.registry.payoutRail(tx);
    if (!found) return null;
    const quote = await found.rail.quote(found.channel, tx.amount, tx.currency);
    return { ...quote, provider: found.adapter.name };
  }

  /* ── submit ─────────────────────────────────────────────────────────────── */

  /**
   * Send an approved withdrawal to its provider. Post-commit relative to the
   * approval (an outage must not block approving) and safe to call any number
   * of times: the claim admits one create.
   *
   * Never throws: by the time this runs the approval has committed and been
   * shown to the admin; a failure is a flagged row, not an error on an action
   * that succeeded.
   */
  async submitApproved(txId: string): Promise<void> {
    await this.submitSafely(txId, false);
  }

  /**
   * A PERSON sends it again (the desk's Resend): a row flagged after a
   * definite refusal, or after the provider was proven to hold nothing. The
   * claim still decides — a held claim (an unknown outcome) makes this a no-op
   * — and the flag clears only when the provider accepts it.
   */
  async resubmit(txId: string): Promise<void> {
    await this.submitSafely(txId, true);
  }

  private async submitSafely(txId: string, byPerson: boolean): Promise<void> {
    try {
      await this.submit(txId, byPerson);
    } catch (error) {
      const reason = messageOf(error);
      this.logger.error(`Payout submission for withdrawal ${txId} failed unexpectedly: ${reason}`);
      await this.flag(txId, `The submission failed unexpectedly: ${reason}`);
    }
  }

  private async submit(txId: string, byPerson: boolean): Promise<void> {
    const current = await this.transactions.getById(txId);
    const found = this.registry.payoutRail(current);
    if (!found || current.state !== 'approved' || current.direction !== 'withdrawal') return;
    const { adapter, channel, rail } = found;

    // Paused, not failed: the sweep offers it again once it can be paid.
    if (!(await adapter.isUsable())) return;
    if (!(await this.switches.isOn(current, 'payout'))) return;
    if (!byPerson && current.needsAttention) return; // a person's to send
    if (await this.overRate(adapter.code, rail)) return; // the next sweep sends it

    // A quote failure on the sweep is transient: nothing was claimed, so the next sweep retries.
    let quote: Awaited<ReturnType<PayoutRail['quote']>>;
    try {
      quote = await rail.quote(channel, current.amount, current.currency);
    } catch (error) {
      // A person's Resend must hear it failed: submitSafely flags it, as before.
      if (byPerson) throw error;
      this.logger.warn(
        `Quote for withdrawal ${txId} failed; retrying next sweep: ${messageOf(error)}`,
      );
      return;
    }
    const destination = normalizedDestination(channel, current.destination ?? '');
    const fingerprint =
      rail.idempotency === 'none'
        ? fingerprintOf(channel.code, destination, quote.gross, current.currency)
        : null;

    // 1. CLAIM — the conditional update that makes a double create impossible.
    let claimed: TransactionRow[];
    try {
      claimed = await this.db
        .update(transactions)
        .set({
          providerSubmittedAt: new Date(),
          providerRequestAmount: quote.gross,
          payoutFingerprint: fingerprint,
        })
        .where(
          and(
            eq(transactions.id, txId),
            eq(transactions.state, 'approved'),
            eq(transactions.direction, 'withdrawal'),
            eq(transactions.providerCode, adapter.code),
            isNull(transactions.providerSubmittedAt),
            isNull(transactions.providerPayoutId),
            byPerson ? undefined : eq(transactions.needsAttention, false),
          ),
        )
        .returning();
    } catch (error) {
      if (violatesConstraint(error, 'transactions_payout_fingerprint_uq')) {
        /*
         * An IDENTICAL payout (same destination, same amount) is still
         * unresolved. Sending this one now would make a lost answer impossible
         * to attribute — so it waits, a queue rather than a guess, and the
         * sweep sends it once the first resolves.
         */
        this.logger.log(
          `Withdrawal ${txId} waits: an identical ${adapter.name} payout is still unresolved.`,
        );
        return;
      }
      throw error;
    }
    if (claimed.length === 0) return; // not eligible, or someone else claimed
    const tx = claimed[0];

    const owner = await this.users.findById(tx.userId);
    const recipientName =
      [owner?.firstName, owner?.lastName].filter(Boolean).join(' ').trim() || 'OxShare client';

    // 2. CREATE — through the adapter, which maps every answer to one of three.
    let submission: Awaited<ReturnType<PayoutRail['submit']>>;
    try {
      submission = await rail.submit(channel, {
        transactionId: tx.id,
        amount: quote.gross,
        clientAmount: quote.net,
        currency: tx.currency,
        destination: tx.destination ?? '',
        recipientName,
        callbackUrl: this.callbackUrl(adapter),
      });
    } catch (error) {
      // An adapter that threw instead of answering: it may have created the
      // payout. Treated as UNKNOWN — the held claim is the safe side.
      submission = { outcome: 'unknown', reason: messageOf(error) };
    }

    // The event log must never stand between an accepted payout and the
    // record of its id: losing the id would strand money at the provider.
    try {
      await this.providerEvents.append({
        providerCode: adapter.code,
        eventType: 'payout.submitted',
        subjectId: submission.outcome === 'accepted' ? submission.payoutId : `tx:${tx.id}`,
        providerType: submission.outcome,
        source: 'desk',
        transactionId: tx.id,
        outcome: submission.outcome === 'accepted' ? 'applied' : 'failed',
        reason: submission.outcome === 'accepted' ? null : submission.reason,
      });
    } catch (error) {
      this.logger.error(
        `Could not log the ${adapter.name} submission of ${tx.id}: ${messageOf(error)}`,
      );
    }

    switch (submission.outcome) {
      case 'accepted': {
        // 3. RECORD — the partial unique index keeps it one-to-one.
        const recorded = await this.recordPayoutId(tx, submission.payoutId, adapter);
        if (!recorded) return;
        this.recordSystemAction('withdrawal.provider.submit', tx.id, {
          provider: adapter.code,
          payoutId: submission.payoutId,
          amount: tx.amount,
          requested: quote.gross,
          currency: tx.currency,
          retriedBy: byPerson ? 'admin' : undefined,
        });
        this.logger.log(
          `Withdrawal ${tx.id} submitted to ${adapter.name} as ${submission.payoutId}.`,
        );
        // The provider may already know the outcome (3pay pays at once).
        if (submission.report) {
          await this.applyReport(
            { ...tx, providerPayoutId: submission.payoutId },
            adapter,
            submission.report,
            'poll',
          );
        }
        return;
      }
      case 'unknown': {
        // The dangerous case: the payout may exist. HOLD the claim.
        this.logger.warn(
          `${adapter.name} gave no usable answer creating the payout for ${tx.id}; holding the ` +
            'claim for the reconciler. Do NOT resend by hand.',
        );
        await this.flag(
          tx.id,
          `${adapter.name} gave no usable answer while creating this payout — the outcome is ` +
            'unknown and a resend could pay twice. The reconciler resolves it from ' +
            `${adapter.name}'s own records; do not resend by hand. (${submission.reason})`,
        );
        return;
      }
      case 'refused': {
        // Definite: nothing exists there. Release the claim.
        await this.releaseClaim(tx.id);
        if (submission.retryAfterMs !== undefined) {
          // Momentary (a rate limit) — requeued; the sweep sends it again.
          this.logger.warn(
            `${adapter.name} rate-limited the payout for ${tx.id}; it is requeued ` +
              `(retry after ~${Math.ceil(submission.retryAfterMs / 1000)}s).`,
          );
          return;
        }
        await this.flag(tx.id, `${adapter.name} refused the payout: ${submission.reason}`);
        this.recordSystemAction('withdrawal.provider.submit', tx.id, {
          provider: adapter.code,
          failed: true,
          reason: submission.reason,
        });
        // A task: resend or cancel. It ends itself when the flag clears or the
        // payout ends — migration 0173's trigger.
        await this.notifications.notifyAdmins({
          kind: 'withdrawal.payout_submit_failed',
          params: {
            transactionId: tx.id,
            amount: tx.amount,
            currency: tx.currency,
            provider: adapter.name,
            reason: submission.reason,
          },
          dedupeKey: `withdrawal.payout_submit_failed:${tx.id}`,
          subject: { id: tx.id, clientId: tx.userId },
        });
        this.logger.error(`${adapter.name} refused the payout for ${tx.id}: ${submission.reason}`);
        return;
      }
    }
  }

  /** Is this provider already at its declared submission rate this minute? */
  private async overRate(providerCode: string, rail: PayoutRail): Promise<boolean> {
    if (rail.ratePerMinute === null) return false;
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(transactions)
      .where(
        and(
          eq(transactions.providerCode, providerCode),
          sql`${transactions.providerSubmittedAt} > now() - interval '60 seconds'`,
        ),
      );
    return (row?.n ?? 0) >= rail.ratePerMinute;
  }

  /**
   * Record the provider's id on the claimed row — once. A payout id another
   * movement already holds is two of our payouts claiming one of theirs: a
   * person's, never a guess.
   */
  private async recordPayoutId(
    tx: TransactionRow,
    payoutId: string,
    adapter: PaymentProviderAdapter,
  ): Promise<boolean> {
    try {
      const updated = await this.db
        .update(transactions)
        .set({
          providerPayoutId: payoutId,
          needsAttention: false,
          attentionReason: null,
        })
        .where(and(eq(transactions.id, tx.id), isNull(transactions.providerPayoutId)))
        .returning({ id: transactions.id });
      return updated.length > 0;
    } catch (error) {
      if (violatesConstraint(error, 'transactions_provider_payout_id_uq')) {
        await this.flag(
          tx.id,
          `${adapter.name} answered with payout ${payoutId}, which another withdrawal here ` +
            'already holds. Reconcile both against the provider before touching either.',
        );
        raiseAlert(
          this.logger,
          ALERT_KINDS.PAYMENT_STATE_MISMATCH,
          'page',
          'A provider returned a payout id another withdrawal already holds.',
          { transactionId: tx.id, provider: adapter.code, payoutId },
        );
        return false;
      }
      throw error;
    }
  }

  /* ── the provider's word ────────────────────────────────────────────────── */

  /**
   * A verified webhook NOTICE about a payout — a doorbell. The provider's own
   * API is asked what the payout is now, and THAT is applied: a replayed or
   * reordered delivery cannot move state, and the webhook's vocabulary never
   * has to match the API's.
   */
  async onNotice(providerCode: string, notice: ProviderNotice): Promise<NoticeOutcome> {
    const [tx] = await this.db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.providerCode, providerCode),
          eq(transactions.providerPayoutId, notice.providerId),
        ),
      )
      .limit(1);
    if (!tx) {
      /*
       * Not ours — a payout made outside the platform, or the create/record
       * race (the reconciler's adoption covers that one). 200 either way.
       */
      await this.providerEvents.append({
        providerCode,
        eventType: notice.eventType,
        subjectId: notice.providerId,
        providerType: notice.providerType,
        source: 'webhook',
        transactionId: null,
        ...OUTCOME_LOG['not-ours'],
      });
      return 'not-ours';
    }
    const found = this.registry.payoutRail(tx);
    if (!found) return 'ignored';
    const reports = await found.rail.read(found.channel, [notice.providerId], sinceOf(tx));
    const report = reports.get(notice.providerId);
    if (!report) return 'pending';
    return this.applyReport(tx, found.adapter, report, 'webhook');
  }

  /**
   * Apply one report through the same conditional transitions the desk uses,
   * so replays, races with a manual action and out-of-order reports all
   * collapse into no-ops.
   */
  private async applyReport(
    tx: TransactionRow,
    adapter: PaymentProviderAdapter,
    report: PayoutReport,
    source: ProviderEventSource,
  ): Promise<PayoutOutcome> {
    await this.db
      .update(transactions)
      .set({
        providerStatus: report.rawStatus.slice(0, 40),
        providerCheckedAt: new Date(),
        ...(report.fee !== undefined ? { providerFee: report.fee } : {}),
        ...(report.net !== undefined ? { providerNetAmount: report.net } : {}),
      })
      .where(eq(transactions.id, tx.id));

    /*
     * PAID SOMEWHERE ELSE — the provider reports this payout going to another
     * destination, or in another asset, than was asked. 3pay's "Static Wallet"
     * force-routes payouts above a threshold to a pre-approved cold wallet
     * "regardless of what your integration sends" (its guide, §10), so a
     * payout can COMPLETE without the client receiving anything. It is never
     * settled as paid (the client would be told so) and never refunded by the
     * engine (the money did leave the company): a person pays the client from
     * where it went and marks it paid. Judged only while money may be moving —
     * a refused payout went nowhere, and its refund is right.
     */
    if (tx.state === 'approved' && (report.status === 'pending' || report.status === 'completed')) {
      const elsewhere = this.paidElsewhere(tx, adapter, report);
      if (elsewhere) {
        const fresh = !(tx.needsAttention && tx.attentionReason === elsewhere);
        await this.flagOnce(tx, elsewhere);
        if (fresh) {
          await this.notifications.notifyAdmins({
            kind: 'withdrawal.payout_attention',
            params: {
              transactionId: tx.id,
              ourState: tx.state,
              event: report.status,
              provider: adapter.name,
            },
            dedupeKey: `withdrawal.payout_attention:${tx.id}`,
            subject: { id: tx.id, clientId: tx.userId },
          });
        }
        await this.providerEvents.append({
          providerCode: adapter.code,
          eventType: report.status === 'completed' ? 'payout.completed' : 'payout.submitted',
          subjectId: report.payoutId,
          providerType: report.rawStatus,
          source,
          transactionId: tx.id,
          outcome: 'rejected',
          reason: elsewhere,
        });
        return 'needs-attention';
      }
    }

    /*
     * SHORT — the provider will deliver less than the client was debited (a fee
     * deducted rather than charged on top, or one changed since it was
     * configured). Flagged the moment ANY report says so — the create's own
     * answer included — so a person sees it before the client does. Never
     * refused: the payout exists at the provider, and unwinding to retry is the
     * double payment this engine exists to prevent.
     */
    if (
      report.net !== undefined &&
      report.status !== 'rejected' &&
      report.status !== 'cancelled' &&
      report.status !== 'failed'
    ) {
      await this.flagShortfall(tx, adapter, report.net);
    }

    if (report.status === 'pending') return 'ignored';

    let outcome: PayoutOutcome;
    if (report.status === 'completed') {
      if (tx.state === 'success') outcome = 'duplicate';
      else if (tx.state !== 'approved') {
        outcome = await this.disagreement(tx, adapter, report);
      } else {
        await this.settleBySystem(tx, adapter, report);
        outcome = 'applied';
      }
    } else if (tx.state === 'failure') {
      outcome = 'duplicate';
    } else if (tx.state !== 'approved') {
      outcome = await this.disagreement(tx, adapter, report);
    } else {
      await this.refundBySystem(tx, adapter, report);
      outcome = 'applied';
    }

    await this.providerEvents.append({
      providerCode: adapter.code,
      eventType: REPORT_EVENT[report.status],
      subjectId: report.payoutId,
      providerType: report.rawStatus,
      source,
      transactionId: tx.id,
      ...OUTCOME_LOG[outcome],
    });
    return outcome;
  }

  /**
   * The provider paid: record success. The client's balance moved when they
   * asked (debit-on-request), so this is a state change plus the paid
   * notification — the desk's own conditional transition.
   *
   * A payout that arrives SHORT (the provider reports a net below what the
   * client was debited — a fee deducted rather than charged on top, or a fee
   * that changed since it was configured) is settled — the money left — and
   * FLAGGED with a page, so a person makes the client whole before the client
   * has to ask.
   */
  private async settleBySystem(
    tx: TransactionRow,
    adapter: PaymentProviderAdapter,
    report: PayoutReport,
  ): Promise<void> {
    const providerRef = report.providerRef || report.payoutId;
    const row = await this.transactions.settle(
      tx.id,
      SYSTEM_ACTOR.id,
      providerRef,
      async (dbTx, settled) => {
        await this.auditLog.record(
          {
            actorId: SYSTEM_ACTOR.id,
            actorEmail: SYSTEM_ACTOR.email,
            actorKind: 'system',
            action: 'withdrawal.settle',
            subjectType: 'transaction',
            subjectId: tx.id,
            details: {
              amount: settled.amount,
              currency: settled.currency,
              providerRef,
              source: adapter.code,
              fee: report.fee ?? null,
              net: report.net ?? null,
            },
          },
          dbTx,
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
          dbTx,
        );
      },
    );
    void this.emailDecision(row, 'paid');
    /*
     * No bell for a payout that completed — nobody must DO anything — but every
     * other operator's desk must stop showing it as awaiting payout.
     */
    await this.resourceChanged.publish({ resource: 'withdrawals' });
  }

  /**
   * The provider did not pay after our approval: refund, with a fixed
   * client-safe sentence. The provider OPERATOR's note (Rival's `adminNotes`)
   * is kept for the desk (`provider_note`, 0172) and the audit row, and never
   * reaches the client.
   */
  private async refundBySystem(
    tx: TransactionRow,
    adapter: PaymentProviderAdapter,
    report: PayoutReport,
  ): Promise<void> {
    const providerNote = report.operatorNote?.trim() || null;
    const row = await this.transactions.markFailed(
      tx.id,
      CLIENT_SAFE_PROVIDER_REFUSAL,
      SYSTEM_ACTOR,
      async (dbTx, failed) => {
        await this.auditLog.record(
          {
            actorId: SYSTEM_ACTOR.id,
            actorEmail: SYSTEM_ACTOR.email,
            actorKind: 'system',
            action: 'withdrawal.provider.reject',
            subjectType: 'transaction',
            subjectId: tx.id,
            details: {
              amount: failed.amount,
              currency: failed.currency,
              provider: adapter.code,
              reason: CLIENT_SAFE_PROVIDER_REFUSAL,
              event: report.status,
              providerNote,
            },
          },
          dbTx,
        );
        await this.notifications.notify(
          {
            recipient: { kind: 'client', id: failed.userId },
            kind: 'withdrawal.rejected',
            params: {
              transactionId: failed.id,
              amount: failed.amount,
              currency: failed.currency,
              reason: CLIENT_SAFE_PROVIDER_REFUSAL,
              reasonAr: systemSentenceArabic(CLIENT_SAFE_PROVIDER_REFUSAL),
            },
          },
          dbTx,
        );
      },
      providerNote,
    );
    void this.emailDecision(row, 'rejected', CLIENT_SAFE_PROVIDER_REFUSAL);
    // No bell: the refund is automatic and complete. Desks refresh.
    await this.resourceChanged.publish({ resource: 'withdrawals' });
  }

  /**
   * The two sides DISAGREE about a finished payout (paid here, failed there;
   * refunded here, paid there): never corrected automatically — a person
   * reconciles against the provider. Flag, page, and ring the desk.
   */
  private async disagreement(
    tx: TransactionRow,
    adapter: PaymentProviderAdapter,
    report: PayoutReport,
  ): Promise<PayoutOutcome> {
    await this.flag(
      tx.id,
      `${adapter.name} reports this withdrawal ${report.status}, but this side recorded ` +
        `'${tx.state}'. The two systems disagree about whether the money moved — reconcile ` +
        `against ${adapter.name} before touching the row.`,
    );
    raiseAlert(
      this.logger,
      ALERT_KINDS.PAYMENT_STATE_MISMATCH,
      'page',
      `A provider reports a payout ${report.status} against a withdrawal in state ` +
        `'${tx.state}'. The two sides disagree about whether money moved — reconcile by hand.`,
      { transactionId: tx.id, provider: adapter.code, ourState: tx.state, event: report.status },
    );
    await this.notifications.notifyAdmins({
      kind: 'withdrawal.payout_attention',
      params: {
        transactionId: tx.id,
        ourState: tx.state,
        event: report.status,
        provider: adapter.name,
      },
      dedupeKey: `withdrawal.payout_attention:${tx.id}`,
      subject: { id: tx.id, clientId: tx.userId },
    });
    return 'needs-attention';
  }

  /* ── the reconciler ─────────────────────────────────────────────────────── */

  /**
   * One provider's payouts, brought up to date. Three scans, each bounded:
   *
   *  1. CLAIMED, NOT RECORDED — the create may or may not have happened. The
   *     adapter searches the provider; exactly one unrecorded candidate is
   *     ADOPTED; several is a person's; none, once the adoption window has
   *     passed, clears the claim and hands the row to a person.
   *  2. RECORDED, STILL APPROVED — a report may have been missed. The
   *     provider's word is read and applied, least recently asked first.
   *  3. APPROVED, NOT CLAIMED — paused (a switch, the provider off, a rate
   *     limit, an identical payout ahead of it) and now sendable.
   *
   * Runs whether or not the provider is switched on: money it already holds
   * must still be reconciled. Only (3) needs it on.
   */
  async reconcile(providerCode: string): Promise<void> {
    const adapter = this.registry.find(providerCode);
    if (!adapter?.payouts) return;
    await this.adoptOrphans(adapter, adapter.payouts);
    await this.pollDecided(adapter, adapter.payouts);
    await this.sendWaiting(adapter);
  }

  private async adoptOrphans(adapter: PaymentProviderAdapter, rail: PayoutRail): Promise<void> {
    const dangling = await this.db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.state, 'approved'),
          eq(transactions.direction, 'withdrawal'),
          eq(transactions.providerCode, adapter.code),
          isNull(transactions.providerPayoutId),
          isNotNull(transactions.providerSubmittedAt),
        ),
      )
      .orderBy(asc(transactions.providerSubmittedAt))
      .limit(BATCH);

    for (const tx of dangling) {
      const channel = this.registry.findChannel(tx, 'payout');
      if (!channel) continue;
      let lookup: Awaited<ReturnType<PayoutRail['find']>>;
      try {
        lookup = await rail.find(channel, {
          transactionId: tx.id,
          destination: normalizedDestination(channel, tx.destination ?? ''),
          amount: tx.providerRequestAmount ?? tx.amount,
          currency: tx.currency,
          since: sinceOf(tx),
        });
      } catch (error) {
        // At its request limit: nothing more this pass; the next resumes here.
        if (error instanceof ProviderBusyError) {
          this.logger.warn(`${adapter.name} orphan scan paused: ${error.message}`);
          return;
        }
        lookup = { complete: false, reason: messageOf(error) };
      }
      if (!lookup.complete) {
        // Cannot judge absence without the whole picture — hold.
        this.logger.warn(
          `Orphan scan for ${tx.id} held: ${adapter.name}'s records were not fully readable ` +
            `(${lookup.reason}).`,
        );
        continue;
      }
      const unclaimed = await this.unrecorded(adapter.code, lookup.candidates);
      if (unclaimed.length === 1) {
        const adopted = await this.db
          .update(transactions)
          .set({
            providerPayoutId: unclaimed[0],
            needsAttention: false,
            attentionReason: null,
          })
          .where(and(eq(transactions.id, tx.id), isNull(transactions.providerPayoutId)))
          .returning();
        if (adopted[0]) {
          this.logger.log(
            `Adopted ${adapter.name} payout ${unclaimed[0]} for withdrawal ${tx.id}.`,
          );
          this.recordSystemAction('withdrawal.provider.adopt', tx.id, {
            provider: adapter.code,
            payoutId: unclaimed[0],
          });
        }
        continue;
      }
      if (unclaimed.length > 1) {
        await this.flagOnce(
          tx,
          `${adapter.name} holds ${unclaimed.length} payouts that could be this withdrawal ` +
            `(${unclaimed.join(', ')}). Match it by hand against ${adapter.name} — do not resend.`,
        );
        continue;
      }
      const claimedAt = tx.providerSubmittedAt?.getTime() ?? 0;
      if (Date.now() - claimedAt <= rail.adoptWindowMs) continue; // wait, deliberately
      /*
       * PROVABLY ABSENT: the provider's complete records hold nothing that
       * could be this payout, and the window has passed. The claim is cleared
       * and a PERSON decides — Resend, or Refund. The engine never resends:
       * a provider whose list is ever late would otherwise pay twice.
       */
      await this.db
        .update(transactions)
        .set({
          providerSubmittedAt: null,
          payoutFingerprint: null,
          providerRequestAmount: null,
          needsAttention: true,
          attentionReason:
            `${adapter.name} holds no payout for this withdrawal ${Math.round(
              rail.adoptWindowMs / 60_000,
            )} minutes after it was sent — it never reached them. Check ${adapter.name}'s ` +
            'dashboard, then Resend it or cancel and refund.',
        })
        .where(and(eq(transactions.id, tx.id), isNull(transactions.providerPayoutId)));
      await this.notifications.notifyAdmins({
        kind: 'withdrawal.payout_submit_failed',
        params: {
          transactionId: tx.id,
          amount: tx.amount,
          currency: tx.currency,
          provider: adapter.name,
          reason: 'never reached the provider',
        },
        dedupeKey: `withdrawal.payout_submit_failed:${tx.id}`,
        subject: { id: tx.id, clientId: tx.userId },
      });
      this.logger.warn(
        `Cleared the claim on withdrawal ${tx.id}: ${adapter.name} holds nothing for it after ` +
          `${rail.adoptWindowMs / 60_000} minutes. A person decides.`,
      );
    }
  }

  private async pollDecided(adapter: PaymentProviderAdapter, rail: PayoutRail): Promise<void> {
    const waiting = await this.db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.state, 'approved'),
          eq(transactions.direction, 'withdrawal'),
          eq(transactions.providerCode, adapter.code),
          isNotNull(transactions.providerPayoutId),
          lt(transactions.providerSubmittedAt, new Date(Date.now() - QUIET_MS)),
        ),
      )
      .orderBy(sql`${transactions.providerCheckedAt} ASC NULLS FIRST`)
      .limit(BATCH);
    if (waiting.length === 0) return;

    // One read per channel — a provider whose read is a list sweep pays once.
    const byChannel = new Map<string, TransactionRow[]>();
    for (const tx of waiting)
      byChannel.set(tx.channelCode, [...(byChannel.get(tx.channelCode) ?? []), tx]);
    for (const [channelCode, rows] of byChannel) {
      const channel = this.registry.findChannel(
        { providerCode: adapter.code, channelCode },
        'payout',
      );
      if (!channel) continue;
      const since = new Date(Math.min(...rows.map((tx) => sinceOf(tx).getTime())));
      let reports: ReadonlyMap<string, PayoutReport>;
      try {
        reports = await rail.read(
          channel,
          rows.map((tx) => tx.providerPayoutId ?? ''),
          since,
        );
      } catch (error) {
        this.logger.warn(`Could not read ${adapter.name} payouts: ${messageOf(error)}`);
        if (error instanceof ProviderBusyError) return;
        continue;
      }
      for (const tx of rows) {
        const report = reports.get(tx.providerPayoutId ?? '');
        if (!report) {
          await this.db
            .update(transactions)
            .set({ providerCheckedAt: new Date() })
            .where(eq(transactions.id, tx.id));
          continue;
        }
        try {
          await this.applyReport(tx, adapter, report, 'poll');
        } catch (error) {
          this.logger.error(
            `Could not apply ${adapter.name}'s report on ${tx.id}: ${messageOf(error)}`,
          );
        }
      }
    }
  }

  /** Approved, unclaimed and not a person's: paused until now, sendable again. */
  private async sendWaiting(adapter: PaymentProviderAdapter): Promise<void> {
    if (!(await adapter.isUsable())) return;
    const waiting = await this.db
      .select({ id: transactions.id })
      .from(transactions)
      .where(
        and(
          eq(transactions.state, 'approved'),
          eq(transactions.direction, 'withdrawal'),
          eq(transactions.providerCode, adapter.code),
          isNull(transactions.providerSubmittedAt),
          isNull(transactions.providerPayoutId),
          eq(transactions.needsAttention, false),
        ),
      )
      .orderBy(asc(transactions.reviewedAt))
      .limit(BATCH);
    for (const row of waiting) await this.submitSafely(row.id, false);
  }

  /** Of these provider ids, the ones no movement here holds yet. */
  private async unrecorded(providerCode: string, ids: readonly string[]): Promise<string[]> {
    const unique = [...new Set(ids.filter((id) => id.length > 0))];
    if (unique.length === 0) return [];
    const held = await this.db
      .select({ id: transactions.providerPayoutId })
      .from(transactions)
      .where(
        and(
          eq(transactions.providerCode, providerCode),
          inArray(transactions.providerPayoutId, unique),
        ),
      );
    const taken = new Set(held.map((row) => row.id));
    return unique.filter((id) => !taken.has(id));
  }

  /* ── a person finishes a flagged payout ─────────────────────────────────── */

  /**
   * A PERSON finishes a flagged payout the provider already holds (0174) — one
   * the engine will neither settle nor refund on its own: the provider reported
   * it paid to ANOTHER destination (3pay's forced cold-wallet route), or several
   * of its records could be it. After checking the provider's dashboard:
   *
   *   `paid`   — the client did receive it (another way, or after all): settled
   *              with the reference of what paid them, and the client is told.
   *   `refund` — nothing reached the client: failed and refunded to their
   *              wallet with the fixed client-safe sentence. The desk's reason is
   *              the audit record, never the client's.
   *
   * Only an APPROVED, FLAGGED payout that reached the provider (a payout id, or
   * a held claim). One that never did is resent or cancelled instead, and one no
   * longer flagged is the engine's again.
   */
  async finishFlagged(
    txId: string,
    actor: Actor,
    decision: 'paid' | 'refund',
    reason: string,
    reference?: string,
  ): Promise<TransactionRow> {
    assertActorCan(actor, 'withdrawals.settle', 'finish a flagged payout');
    const tx = await this.transactions.getById(txId);
    const found = this.registry.payoutRail(tx);
    if (tx.direction !== 'withdrawal' || !found) {
      throw new ValidationError('Only a payout a provider sends is finished here.');
    }
    if (tx.state !== 'approved' || !tx.needsAttention) {
      throw new ValidationError(
        'This payout is not waiting for a person any more — it may be finished already.',
      );
    }
    if (!tx.providerPayoutId && !tx.providerSubmittedAt) {
      throw new ValidationError(
        `It never reached ${found.adapter.name}: resend it, or cancel it, instead.`,
      );
    }
    /*
     * A held claim with no payout id may be an answer still coming: the
     * reconciler adopts it from the provider's records within its window. A
     * person refunding it before then could pay the client twice.
     */
    if (!tx.providerPayoutId) {
      const claimedAt = tx.providerSubmittedAt?.getTime() ?? 0;
      if (Date.now() - claimedAt < found.rail.adoptWindowMs) {
        throw new ValidationError(
          `${found.adapter.name} may still answer for this payout. The reconciler settles it ` +
            `from ${found.adapter.name}'s records first — try again ${Math.round(
              found.rail.adoptWindowMs / 60_000,
            )} minutes after it was sent.`,
        );
      }
    }
    const why = reason.trim();
    if (why.length === 0) throw new ValidationError('Say what you found, for the record.');
    const details = {
      userId: tx.userId,
      amount: tx.amount,
      currency: tx.currency,
      provider: found.adapter.code,
      payoutId: tx.providerPayoutId,
      reason: why,
    };

    if (decision === 'paid') {
      const ref = reference?.trim() ?? '';
      if (ref.length === 0) {
        throw new ValidationError('Give the reference of the payment that reached the client.');
      }
      let row: TransactionRow;
      try {
        row = await this.transactions.settle(tx.id, actor.id, ref, async (dbTx, settled) => {
          await dbTx
            .update(transactions)
            .set({ needsAttention: false, attentionReason: null })
            .where(eq(transactions.id, tx.id));
          await this.auditLog.record(
            {
              actorId: actor.id,
              actorEmail: actor.email,
              actorKind: 'admin',
              action: 'withdrawal.finish_paid',
              subjectType: 'transaction',
              subjectId: tx.id,
              details: { ...details, reference: ref },
            },
            dbTx,
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
            dbTx,
          );
        });
      } catch (error) {
        if (violatesConstraint(error, 'transactions_provider_ref_uq')) {
          throw new ValidationError('That reference already belongs to another movement.');
        }
        throw error;
      }
      void this.emailDecision(row, 'paid');
      await this.resourceChanged.publish({ resource: 'withdrawals' });
      return this.transactions.getById(tx.id);
    }

    const row = await this.transactions.markFailed(
      tx.id,
      CLIENT_SAFE_PROVIDER_REFUSAL,
      actor,
      async (dbTx, failed) => {
        await dbTx
          .update(transactions)
          .set({ needsAttention: false, attentionReason: null })
          .where(eq(transactions.id, tx.id));
        await this.auditLog.record(
          {
            actorId: actor.id,
            actorEmail: actor.email,
            actorKind: 'admin',
            action: 'withdrawal.finish_refund',
            subjectType: 'transaction',
            subjectId: tx.id,
            details,
          },
          dbTx,
        );
        await this.notifications.notify(
          {
            recipient: { kind: 'client', id: failed.userId },
            kind: 'withdrawal.rejected',
            params: {
              transactionId: failed.id,
              amount: failed.amount,
              currency: failed.currency,
              reason: CLIENT_SAFE_PROVIDER_REFUSAL,
              reasonAr: systemSentenceArabic(CLIENT_SAFE_PROVIDER_REFUSAL),
            },
          },
          dbTx,
        );
      },
    );
    void this.emailDecision(row, 'rejected', CLIENT_SAFE_PROVIDER_REFUSAL);
    await this.resourceChanged.publish({ resource: 'withdrawals' });
    return this.transactions.getById(tx.id);
  }

  /* ── the desk's cancel ──────────────────────────────────────────────────── */

  /**
   * May an APPROVED withdrawal be cancelled, and what must the provider do
   * first? The caller (AdminMoneyService) owns permissions, scope, the reason
   * and the refund; this owns only the provider's half.
   *
   *   never sent               — purely local.
   *   sent, answer unknown     — refused until reconciliation says whether it
   *                              exists: a local refund could meet a payout.
   *   held by the provider     — recalled first where the provider can
   *                              (`cancellable`), and refused where it cannot
   *                              or where it is already being paid. "Cancelled
   *                              here, paid there" is the split-brain this
   *                              engine exists to prevent.
   */
  async cancelApproved(tx: TransactionRow): Promise<void> {
    const found = this.registry.payoutRail(tx);
    if (!tx.providerPayoutId) {
      if (tx.providerSubmittedAt) {
        throw new ValidationError(
          'This withdrawal has a payout in flight whose outcome is not known yet. Wait for ' +
            'reconciliation to confirm whether the provider made it, then cancel.',
        );
      }
      return;
    }
    if (!found?.rail.cancellable || !found.rail.cancel) {
      throw new ValidationError(
        `${found?.adapter.name ?? 'The provider'} has already been sent this payout and it cannot ` +
          'be recalled. Act on its outcome instead.',
      );
    }
    try {
      await found.rail.cancel(found.channel, tx.providerPayoutId);
    } catch (error) {
      throw new ValidationError(
        `${found.adapter.name} is already processing this payout — it can no longer be ` +
          'cancelled. It will settle or fail shortly; act on the outcome instead.',
        { cause: messageOf(error) },
      );
    }
  }

  /* ── small shared bits ──────────────────────────────────────────────────── */

  /** Where a provider that takes a per-request callback reports back. */
  private callbackUrl(adapter: PaymentProviderAdapter): string | undefined {
    return providerWebhookUrl(this.config.get<string>('API_PUBLIC_URL'), adapter) ?? undefined;
  }

  /** A definite refusal: nothing exists at the provider, so the claim is let go. */
  private async releaseClaim(txId: string): Promise<void> {
    await this.db
      .update(transactions)
      .set({ providerSubmittedAt: null, payoutFingerprint: null, providerRequestAmount: null })
      .where(and(eq(transactions.id, txId), isNull(transactions.providerPayoutId)));
  }

  /** Detached system audit row — a failure is loud in the logs, never fatal to money. */
  private recordSystemAction(action: string, subjectId: string, details: Record<string, unknown>) {
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

  private async flag(txId: string, reason: string): Promise<void> {
    await this.db
      .update(transactions)
      .set({ needsAttention: true, attentionReason: reason })
      .where(eq(transactions.id, txId));
  }

  /**
   * Why a report does not describe the payout that was asked for — another
   * asset, or another destination — or null when it does (or does not say).
   */
  private paidElsewhere(
    tx: TransactionRow,
    adapter: PaymentProviderAdapter,
    report: PayoutReport,
  ): string | null {
    const channel = this.registry.findChannel(tx, 'payout');
    if (!channel) return null;
    const asset = channel.asset?.code ?? tx.currency;
    if (report.currency !== undefined && report.currency.toUpperCase() !== asset.toUpperCase()) {
      return (
        `${adapter.name} reports this payout in ${report.currency}, but it was asked to send ` +
        `${asset}. The client may not have received it: check ${adapter.name}'s dashboard, pay ` +
        'the client what they are owed, then mark it paid.'
      );
    }
    if (report.destination !== undefined) {
      const asked = normalizedDestination(channel, tx.destination ?? '');
      if (normalizedDestination(channel, report.destination) !== asked) {
        return (
          `${adapter.name} reports this payout sent to ${report.destination}, not to the ` +
          `client's ${tx.destination ?? '(none)'} — the client did NOT receive it. Check ` +
          `${adapter.name}'s dashboard (a forced cold-wallet route does this), pay the client ` +
          'from where it went, then mark it paid.'
        );
      }
    }
    return null;
  }

  /** Flag and page a payout that lands short of what the client was debited — once. */
  private async flagShortfall(
    tx: TransactionRow,
    adapter: PaymentProviderAdapter,
    net: string,
  ): Promise<void> {
    const shortfall = shortOf(tx.amount, net);
    if (shortfall === null) return;
    /*
     * The company carries the provider's fee (the owner, 30 Sep 2026), so a
     * client receiving less than they withdrew means the fee the provider
     * actually took is not the one configured — the company owes the client the
     * difference. Said in those words, so nobody reads it as a client fee.
     */
    const grossedUp =
      tx.providerRequestAmount !== null &&
      new Decimal(tx.providerRequestAmount).greaterThan(tx.amount);
    const reason =
      `${adapter.name} delivered ${new Decimal(net).toFixed()} ${tx.currency} of this ` +
      `${new Decimal(tx.amount).toFixed()} ${tx.currency} withdrawal, so the client is ` +
      `${shortfall} ${tx.currency} short. ${adapter.name}'s fee is the company's, not the ` +
      "client's: " +
      (grossedUp
        ? 'the fee it took is not the one configured. Pay the client the difference, and ' +
          `update the fee in Payment providers → ${adapter.name}.`
        : `it took its fee out of the client's amount. Pay the client the difference, and ` +
          `ask ${adapter.name} to charge its fee to the company instead.`);
    const [current] = await this.db
      .select({ reason: transactions.attentionReason })
      .from(transactions)
      .where(eq(transactions.id, tx.id))
      .limit(1);
    if (current?.reason === reason) return;
    await this.flag(tx.id, reason);
    raiseAlert(
      this.logger,
      ALERT_KINDS.PAYMENT_STATE_MISMATCH,
      'page',
      'A payout will deliver LESS than the client was debited. Check the provider’s fee.',
      {
        transactionId: tx.id,
        provider: adapter.code,
        debited: tx.amount,
        delivered: net,
        shortfall,
        currency: tx.currency,
      },
    );
  }

  /** Flag, and page, only the first time — a sweep repeats every few minutes. */
  private async flagOnce(tx: TransactionRow, reason: string): Promise<void> {
    if (tx.needsAttention && tx.attentionReason === reason) return;
    await this.flag(tx.id, reason);
    raiseAlert(this.logger, ALERT_KINDS.PAYMENT_STATE_MISMATCH, 'page', reason, {
      transactionId: tx.id,
      provider: tx.providerCode,
    });
  }

  private async emailDecision(
    row: { userId: number; amount: string; currency: string; rejectionReasonAr?: string | null },
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
        user.locale,
        row.rejectionReasonAr,
      );
    } catch (error) {
      this.logger.warn(`Could not send the withdrawal ${decision} email: ${messageOf(error)}`);
    }
  }
}

/** When a payout made for this claim could first have appeared at the provider. */
function sinceOf(tx: { providerSubmittedAt: Date | null; createdAt: Date }): Date {
  return new Date((tx.providerSubmittedAt ?? tx.createdAt).getTime() - CLOCK_SKEW_MS);
}

/** The destination in the one spelling the provider's echo compares equal to. */
export function normalizedDestination(channel: PaymentChannel, destination: string): string {
  const trimmed = destination.trim();
  return channel.destination?.normalize ? channel.destination.normalize(trimmed) : trimmed;
}

/**
 * The fingerprint of what a reference-less provider was asked — what makes
 * the one unresolved payout per (channel, destination, amount, currency)
 * findable. Hashed: the index needs equality, not the address.
 */
export function fingerprintOf(
  channelCode: string,
  destination: string,
  gross: string,
  currency: string,
): string {
  return createHash('sha256')
    .update([channelCode, destination, new Decimal(gross).toFixed(), currency].join('\n'))
    .digest('hex');
}

/**
 * How much SHORT of `asked` a payout landed, or null when it did not. Decimal
 * throughout (§6.1): a fee comparison is exactly where a float would round the
 * difference away.
 */
function shortOf(asked: string, net: string): string | null {
  const difference = new Decimal(asked).minus(new Decimal(net));
  return difference.greaterThan(0) ? difference.toFixed() : null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
