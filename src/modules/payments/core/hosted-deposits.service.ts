import { Inject, Injectable, Logger } from '@nestjs/common';
import Decimal from 'decimal.js';
import { and, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../../database/database.module';
import type { Db } from '../../../database/db';
import { transactions } from '../../../database/schema';
import { LEDGER_REFERENCE } from '../../../database/ledger-reference';
import { ALERT_KINDS, raiseAlert } from '../../../common/logging/alerts';
import { SYSTEM_ACTOR, assertActorCan, type Actor } from '../../../common/security/actor';
import {
  NOTIFICATION_DISPATCH,
  type NotificationDispatchPort,
} from '../../../common/provisioning/notification-dispatch.port';
import {
  MoneyRuleError,
  NotFoundError,
  ValidationError,
} from '../../../common/errors/domain-errors';
import type { DepositAttentionReason } from '../../../common/notifications/admin-notification-catalogue';
import { AuditLogStore } from '../../../store/audit-log.store';
import {
  PaymentProviderEventsStore,
  type ProviderEventOutcome,
  type ProviderEventSource,
} from '../../../store/payment-provider-events.store';
import { WalletService } from '../../wallet/wallet.service';
import { money, toDecimal } from '../../wallet/money';
import { CurrenciesService } from '../../currencies/currencies.service';
import { TransactionsService, depositStateOf } from '../transactions.service';
import { PaymentMethodsService } from '../payment-methods.service';
import { PaymentProviderRegistry } from '../providers/payment-provider-registry';
import {
  ProviderBusyError,
  type DepositCreditPolicy,
  type NoticeOutcome,
  type PaymentChannel,
  type PaymentRoute,
  type PaymentStatus,
  type ProviderNotice,
} from '../providers/payment-provider';

type TransactionRow = typeof transactions.$inferSelect;

/** A fresh deposit is the webhook's to report first; the sweep waits this long. */
const QUIET_MS = 2 * 60_000;
/** After this long a hosted deposit is re-asked upstream where the provider can (Rival's /refresh). */
const REFRESH_AFTER_MS = 30 * 60_000;
/** A start with no provider id this old, that the provider cannot find, never began. */
const START_ABANDONED_MS = 60 * 60_000;
/** A hosted deposit still unfinished after this long is a person's to look at. */
const STALE_AFTER_MS = 7 * 24 * 60 * 60_000;
/** A `received` provider may confirm an expired link late; watched this long, hourly. */
const LATE_WATCH_MS = 30 * 24 * 60 * 60_000;
const LATE_RECHECK_MS = 60 * 60_000;
const BATCH = 50;

/**
 * What a client reads on a hosted deposit the desk closed without credit. The
 * desk's reason is an internal finding ("3pay returned it to the sender") and
 * is kept in the audit log, never shown to the client.
 */
export const CLIENT_SAFE_DEPOSIT_CLOSED =
  'This deposit was closed after a check and nothing was credited. If you sent money for it, ' +
  'contact support with your reference.';

/**
 * THE HOSTED-DEPOSIT ENGINE — every deposit a client pays on a provider's own
 * page, whichever provider hosts it (0173).
 *
 * It is `TransactionsService.settleGatewayDeposit` (0052–0168) made
 * provider-neutral, and it keeps that method's one rule: MONEY IS CREDITED ON
 * THE PROVIDER'S STORED STATE, NEVER ON THE SHAPE OF WHATEVER PROMPTED THE
 * QUESTION. The client's browser landing, a signed webhook (a doorbell), the
 * poll — every trigger converges here and asks the provider's API.
 *
 * Idempotency is the DATABASE's, twice over: the state change is conditional
 * on the row still being open, and `WalletService.post` is guarded by
 * `ledger_entries_wallet_reference_uq`.
 *
 * ## What is credited is the provider's DECLARATION (`creditPolicy`)
 *
 *   `exact`    — the amount the link was created for; any other figure is a
 *                person's (Rival: a Whish link is fixed-amount). A terminally
 *                failed deposit is never revived — flagged instead.
 *   `received` — what the provider confirms ARRIVED, rounded DOWN to the
 *                wallet's places: less, more, or LATE — a payment the provider
 *                confirms on a link already failed as expired is credited then,
 *                audited `deposit.settle_late` (3pay; the tech lead, 30 Sep
 *                2026). `amount` becomes the credited figure so every list,
 *                export and total is true; `requested_amount` keeps the ask.
 *
 * Either way the ASSET must be the channel's (USDT-TRC20 on a TRC20 channel),
 * and anything the rules cannot decide is FLAGGED for a person — who finishes
 * it with `creditReceived` or `closeWithoutCredit` — never guessed.
 */
@Injectable()
export class HostedDepositsService {
  private readonly logger = new Logger(HostedDepositsService.name);
  private readonly providerEvents: PaymentProviderEventsStore;

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Db,
    private readonly registry: PaymentProviderRegistry,
    private readonly wallets: WalletService,
    private readonly transactions: TransactionsService,
    private readonly paymentMethods: PaymentMethodsService,
    private readonly currencies: CurrenciesService,
    private readonly auditLog: AuditLogStore,
    @Inject(NOTIFICATION_DISPATCH) private readonly notifications: NotificationDispatchPort,
  ) {
    this.providerEvents = new PaymentProviderEventsStore(db);
  }

  /* ── the triggers ───────────────────────────────────────────────────────── */

  /**
   * Settle by the reference its payer holds — the portal's own `POST …/settle`
   * (with `ownerId`; a mismatch is a 404, never a 403: the difference is an
   * existence oracle) and the return bounce.
   */
  async settle(
    method: string | undefined,
    reference: string,
    opts: { ownerId?: number; source?: ProviderEventSource } = {},
  ): Promise<ReturnType<typeof depositStateOf>> {
    const tx = await this.transactions.findDepositByReference(method, reference, opts.ownerId);
    if (!tx) throw new NotFoundError('No deposit matches that reference.');
    if (opts.ownerId !== undefined && tx.userId !== opts.ownerId) {
      throw new NotFoundError('No deposit matches that reference.');
    }
    await this.settleRow(tx, opts.source ?? 'poll');
    // Re-read: settling may have changed the amount to what arrived.
    return depositStateOf(await this.transactions.getById(tx.id));
  }

  /**
   * A verified webhook NOTICE about a payment. A `status` notice is a doorbell:
   * the provider is asked, and its answer applied. An `alarm` (a reversal of a
   * settled deposit) moves no money and may not show in the provider's stored
   * state, so it raises a person's attention as delivered.
   */
  async onNotice(providerCode: string, notice: ProviderNotice): Promise<NoticeOutcome> {
    const [tx] = await this.db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.providerCode, providerCode),
          eq(transactions.providerPaymentId, notice.providerId),
        ),
      )
      .limit(1);
    const log = (outcome: ProviderEventOutcome, reason: string) =>
      this.providerEvents.append({
        providerCode,
        eventType: notice.eventType,
        subjectId: notice.providerId,
        providerType: notice.providerType,
        source: 'webhook',
        transactionId: tx?.id ?? null,
        outcome,
        reason,
      });

    if (!tx) {
      // An alarm names a deposit that SETTLED here; none carries this id, so
      // it is about something else (3pay's `refund` rings both doorbells).
      if (notice.kind === 'alarm') {
        await log('ignored', 'No deposit here carries this payment.');
        return 'not-ours';
      }
      // The start/webhook race: the first delivery can outrun the UPDATE that
      // stores the provider's id. Worth a retry; the sweep sits behind it.
      await log('failed', 'No deposit carries this payment yet; it is retried.');
      return 'unknown-reference';
    }

    if (notice.kind === 'alarm') {
      await this.flag(
        tx,
        'reversed',
        tx.state === 'success'
          ? 'The provider REVERSED this deposit after it settled. The client wallet has not been ' +
              'debited — a compensating entry is a person’s decision (§6.4). Reconcile against ' +
              'the provider.'
          : 'The provider reports a REFUND on this deposit, which was never credited here. ' +
              'Nothing has moved on this side — check with the provider where the money went ' +
              'before finishing it.',
      );
      await log('rejected', 'Reported reversed; nothing is debited without a person.');
      return 'needs-attention';
    }

    // Already credited: a success report is the echo, a failure report history.
    if (tx.state === 'success') {
      return notice.eventType === 'payment.succeeded' ? 'duplicate' : 'stale';
    }
    const channel = this.registry.findChannel(tx, 'deposit');
    if (tx.state === 'failure' && (channel?.creditPolicy ?? 'exact') === 'exact') {
      return this.paidAfterFailure(tx, log);
    }
    const before = tx.state;
    const { state } = await this.settleRow(tx, 'webhook');
    if (state !== before) return 'applied';
    const after = await this.transactions.getById(tx.id);
    if (after.needsAttention && !tx.needsAttention) return 'needs-attention';
    if (state === 'pending') {
      await log(
        'failed',
        'The provider still reports the payment unfinished; checked again later.',
      );
      return 'pending';
    }
    return 'stale';
  }

  /**
   * An `exact` provider reporting money on a deposit already FAILED here. The
   * state machine is never argued backwards — but the provider is ASKED first
   * (the doorbell rule), and only a confirmed payment raises the flag: the
   * money is at the provider and no wallet was credited.
   */
  private async paidAfterFailure(
    tx: TransactionRow,
    log: (outcome: ProviderEventOutcome, reason: string) => Promise<void>,
  ): Promise<NoticeOutcome> {
    if (!tx.providerPaymentId) return 'stale';
    const result = await this.registry.checkPayment(tx, tx.providerPaymentId);
    if (!result.paid) {
      await log('ignored', `Already ${tx.state}; a terminal deposit never moves back.`);
      return 'stale';
    }
    await this.db
      .update(transactions)
      .set({ providerPaidAt: paidAtOnce(new Date()) })
      .where(eq(transactions.id, tx.id));
    await this.flag(
      tx,
      'paid_after_failure',
      'The provider reports this deposit PAID, but this side had already recorded it as ' +
        'failed. The money is at the provider and no wallet was credited — reconcile by hand.',
      { reported: result.amount },
    );
    await log('rejected', 'Reported paid after it was recorded as failed; a person decides.');
    return 'needs-attention';
  }

  /* ── the one path that credits ──────────────────────────────────────────── */

  /** Ask the provider about one deposit and apply its answer. Safe to call any number of times. */
  async settleRow(tx: TransactionRow, source: ProviderEventSource): Promise<{ state: string }> {
    const route: PaymentRoute = { providerCode: tx.providerCode, channelCode: tx.channelCode };
    const channel = this.registry.findChannel(route, 'deposit');
    if (!channel || channel.flow !== 'redirect' || tx.direction !== 'deposit') {
      return { state: tx.state };
    }
    const policy: DepositCreditPolicy = channel.creditPolicy ?? 'exact';
    const lateCredit = tx.state === 'failure' && policy === 'received';
    if (tx.state !== 'pending' && !lateCredit) return { state: tx.state };
    /*
     * A person's: a flagged deposit is finished from the desk (`creditReceived`,
     * `closeWithoutCredit`), never re-judged — re-judging re-flagged and
     * re-paged it on every sweep, for ever (found 30 Sep 2026).
     */
    if (tx.needsAttention) return { state: tx.state };
    // The start never confirmed: the sweep recovers it first.
    if (!tx.providerPaymentId) return { state: tx.state };

    const result = await this.registry.checkPayment(route, tx.providerPaymentId);
    const now = new Date();
    await this.db
      .update(transactions)
      .set({
        providerStatus: result.rawStatus.slice(0, 40),
        providerCheckedAt: now,
        ...(result.fee !== undefined ? { providerFee: result.fee } : {}),
        ...(result.net !== undefined ? { providerNetAmount: result.net } : {}),
        // The provider's balance moved at its confirmation — whatever is decided next (0175).
        ...(result.settled && result.paid ? { providerPaidAt: paidAtOnce(now) } : {}),
      })
      .where(eq(transactions.id, tx.id));

    /*
     * Still payable. `pending` at the provider INCLUDES "the client tried and
     * failed" — the link stays live until it is paid or expires — so an early
     * failure report must not fail the deposit.
     */
    if (!result.settled) return { state: tx.state };

    if (!result.paid) {
      if (tx.state !== 'pending') return { state: tx.state };
      return this.fail(tx, channel, policy, result, source);
    }

    // PAID — check WHAT arrived before crediting it.
    const expectedAsset = channel.asset?.code ?? tx.currency;
    if (result.currency !== undefined && result.currency !== expectedAsset) {
      await this.flag(
        tx,
        'wrong_asset',
        `The provider reports ${result.amount ?? '?'} ${result.currency} for this deposit, but ` +
          `it was created for ${expectedAsset}. Nothing has been credited — confirm what ` +
          'actually arrived before settling it by hand.',
        { reported: result.amount, reportedCurrency: result.currency },
      );
      await this.logEvent(
        tx,
        'payment.succeeded',
        result,
        source,
        'rejected',
        'Wrong asset; nothing credited.',
      );
      return { state: tx.state };
    }

    const credited = await this.creditedAmount(tx, policy, result);
    if (credited.kind === 'refuse') {
      await this.flag(tx, 'amount_mismatch', credited.reason, {
        reported: result.amount,
        reportedCurrency: result.currency ?? tx.currency,
      });
      await this.logEvent(tx, 'payment.succeeded', result, source, 'rejected', credited.reason);
      return { state: tx.state };
    }
    const settled = await this.credit(tx, credited.amount, result, lateCredit, SYSTEM_ACTOR, null);
    if (settled) {
      await this.logEvent(tx, 'payment.succeeded', result, source, 'applied', null);
      await this.afterCredit({ ...tx, amount: credited.amount });
    }
    return { state: settled ? 'success' : tx.state };
  }

  /**
   * The figure to credit, or why a person must decide.
   *
   *  - `exact`: the link's own amount, when the provider agrees (or says
   *    nothing about it). A different figure is refused — crediting the
   *    smaller invents a rule, crediting the larger gives money away.
   *  - `received`: what arrived, rounded DOWN to the wallet currency's places
   *    (the owner, 30 Sep 2026): never more than arrived; the sub-cent
   *    remainder stays with the broker and the full figure is recorded.
   */
  private async creditedAmount(
    tx: TransactionRow,
    policy: DepositCreditPolicy,
    result: PaymentStatus,
  ): Promise<{ kind: 'credit'; amount: string } | { kind: 'refuse'; reason: string }> {
    if (policy === 'exact') {
      if (result.amount !== undefined && !toDecimal(result.amount).equals(toDecimal(tx.amount))) {
        return {
          kind: 'refuse',
          reason:
            `The provider reports ${result.amount} ${result.currency ?? tx.currency} for this ` +
            `deposit, but it was created for ${tx.amount} ${tx.currency}. Nothing has been ` +
            'credited — confirm which figure is real before settling it by hand.',
        };
      }
      return { kind: 'credit', amount: tx.amount };
    }
    if (result.amount === undefined) {
      return {
        kind: 'refuse',
        reason:
          'The provider confirmed this payment without saying how much arrived. Nothing has ' +
          'been credited — confirm the amount against the provider, then credit it by hand.',
      };
    }
    const decimals = (await this.currencies.findOne(tx.currency))?.decimals ?? 2;
    const rounded = toDecimal(result.amount).toDecimalPlaces(decimals, Decimal.ROUND_DOWN);
    if (rounded.lte(0)) {
      return {
        kind: 'refuse',
        reason:
          `The provider confirmed ${result.amount} ${result.currency ?? tx.currency}, which is ` +
          `nothing once rounded to ${tx.currency}'s ${decimals} places. Nothing has been credited.`,
      };
    }
    return { kind: 'credit', amount: money(rounded.toFixed()) };
  }

  /**
   * The credit and the state change, in one transaction: a deposit marked
   * success with no ledger entry behind it — or a credit no transaction points
   * at — is a state this system cannot reach.
   *
   * `late` (a `received` provider confirming a link already failed as expired)
   * moves `failure → success`; everything else `pending → success`. Both are
   * conditional, so the loser of any race changes nothing, and the ledger's
   * unique reference makes a second credit impossible either way.
   */
  private async credit(
    tx: TransactionRow,
    amount: string,
    result: Pick<PaymentStatus, 'amount' | 'fee' | 'net'>,
    late: boolean,
    actor: Actor,
    deskReason: string | null,
  ): Promise<boolean> {
    return this.db.transaction(async (dbTx) => {
      const updated = await dbTx
        .update(transactions)
        .set({
          state: 'success',
          settledAt: new Date(),
          amount,
          // What the link asked, kept when the credited figure differs.
          requestedAmount: toDecimal(amount).equals(toDecimal(tx.amount))
            ? tx.requestedAmount
            : (tx.requestedAmount ?? tx.amount),
          ...(result.amount !== undefined ? { providerAmountReceived: result.amount } : {}),
          ...(result.fee !== undefined ? { providerFee: result.fee } : {}),
          ...(result.net !== undefined ? { providerNetAmount: result.net } : {}),
          ...(deskReason !== null ? { needsAttention: false, attentionReason: null } : {}),
        })
        .where(
          and(
            eq(transactions.id, tx.id),
            eq(transactions.direction, 'deposit'),
            late ? eq(transactions.state, 'failure') : eq(transactions.state, 'pending'),
          ),
        )
        .returning({ id: transactions.id });
      if (updated.length === 0) return false;

      await this.wallets.post(
        {
          userId: tx.userId,
          currency: tx.currency,
          amount,
          entryType: 'deposit',
          referenceType: LEDGER_REFERENCE.transaction,
          referenceId: tx.id,
        },
        dbTx,
      );
      // FR-CORE-07: the client is told, in the same transaction as the credit.
      await this.notifications.notify(
        {
          recipient: { kind: 'client', id: tx.userId },
          kind: 'deposit.succeeded',
          params: { transactionId: tx.id, amount, currency: tx.currency },
          dedupeKey: `deposit.succeeded:${tx.id}`,
        },
        dbTx,
      );
      /*
       * The audit row, in the same transaction as the credit. `details.userId`
       * is LOAD-BEARING: the audit scope predicate resolves a transaction row's
       * client from it.
       */
      const entry = {
        actorId: actor.id,
        actorEmail: actor.email,
        actorKind: actor.id === SYSTEM_ACTOR.id ? ('system' as const) : ('admin' as const),
        subjectType: 'transaction' as const,
        subjectId: tx.id,
        details: {
          userId: tx.userId,
          amount,
          currency: tx.currency,
          requested: tx.amount,
          received: result.amount ?? null,
          method: tx.methodKey ?? tx.provider,
          providerRef: tx.providerRef,
          ...(deskReason !== null ? { reason: deskReason } : {}),
        },
      };
      // Each action named where it is written, so the audit catalogue's
      // coverage census can see it.
      if (deskReason !== null) {
        await this.auditLog.record({ ...entry, action: 'deposit.credit_received' }, dbTx);
      } else if (late) {
        await this.auditLog.record({ ...entry, action: 'deposit.settle_late' }, dbTx);
      } else {
        await this.auditLog.record({ ...entry, action: 'deposit.settle' }, dbTx);
      }
      return true;
    });
  }

  /** After a credit commits: the mail, the onward transfer, the compliance flag. */
  private async afterCredit(tx: TransactionRow): Promise<void> {
    void this.transactions.sendDepositOutcomeEmail(tx.userId, 'succeeded', tx.amount, tx.currency);
    // Gated on winning the transition, so one deposit chains one transfer.
    await this.transactions.chainTransferToAccount(tx);
    /*
     * OVER THE METHOD'S MAXIMUM: credited — the money arrived and is the
     * client's — AND flagged for a compliance look (the owner, 30 Sep 2026).
     * Non-blocking by design: nothing is held back.
     */
    const maximum = tx.methodKey ? await this.paymentMethods.effectiveMaximum(tx.methodKey) : null;
    if (maximum !== null && toDecimal(tx.amount).greaterThan(toDecimal(maximum))) {
      await this.flag(
        tx,
        'over_limit',
        `${tx.amount} ${tx.currency} was credited, above this method's maximum of ${maximum} ` +
          `${tx.currency}. The money arrived and is the client's — review it for compliance, ` +
          'then mark it resolved.',
        { credited: tx.amount, maximum },
      );
    }
  }

  /** The provider says it never will be paid. */
  private async fail(
    tx: TransactionRow,
    channel: PaymentChannel,
    policy: DepositCreditPolicy,
    result: PaymentStatus,
    source: ProviderEventSource,
  ): Promise<{ state: string }> {
    /*
     * Money ARRIVED on a link the provider did not confirm (3pay: a payment
     * after the window "may not be automatically credited"). The money is at
     * the provider and the client may have paid — a person contacts the
     * provider; nothing fails the client's deposit meanwhile.
     */
    if (policy === 'received' && result.amount !== undefined && toDecimal(result.amount).gt(0)) {
      await this.flag(
        tx,
        'unconfirmed_funds',
        `${result.amount} ${result.currency ?? channel.asset?.code ?? tx.currency} arrived on this ` +
          `deposit's link, but the provider has not confirmed it (${result.rawStatus}). Nothing ` +
          'has been credited — ask the provider to confirm it, then credit it by hand.',
        { reported: result.amount },
      );
      await this.logEvent(
        tx,
        'payment.failed',
        result,
        source,
        'rejected',
        'Funds arrived unconfirmed; a person decides.',
      );
      return { state: tx.state };
    }
    const updated = await this.db
      .update(transactions)
      .set({
        state: 'failure',
        settledAt: new Date(),
        rejectionReason: result.expired
          ? 'The payment link expired before the payment arrived.'
          : null,
      })
      .where(and(eq(transactions.id, tx.id), eq(transactions.state, 'pending')))
      .returning();
    if (updated[0]?.state === 'failure') {
      await this.logEvent(tx, 'payment.failed', result, source, 'applied', null);
      void this.notifications.notify({
        recipient: { kind: 'client', id: tx.userId },
        kind: 'deposit.failed',
        params: { transactionId: tx.id, amount: tx.amount, currency: tx.currency },
        dedupeKey: `deposit.failed:${tx.id}`,
      });
      void this.transactions.sendDepositOutcomeEmail(tx.userId, 'failed', tx.amount, tx.currency);
    }
    return { state: updated[0]?.state ?? tx.state };
  }

  /* ── the desk's two ways to finish a flagged deposit ────────────────────── */

  /**
   * CREDIT WHAT WAS RECEIVED — a person decided a flagged hosted deposit is
   * real (an amount a fixed link did not expect, funds the provider did not
   * confirm). Credits the figure the provider REPORTED, rounded down to the
   * wallet's places, with the person's reason, audited, in one transaction.
   */
  async creditReceived(txId: string, actor: Actor, reason: string): Promise<TransactionRow> {
    assertActorCan(actor, 'deposits.approve', 'credit a flagged deposit');
    const tx = await this.flaggedHostedDeposit(txId);
    const received = tx.providerAmountReceived;
    if (received === null) {
      throw new ValidationError(
        'The provider never reported an amount for this deposit — there is nothing to credit ' +
          'from here. Credit the wallet by hand once the amount is confirmed.',
      );
    }
    const decimals = (await this.currencies.findOne(tx.currency))?.decimals ?? 2;
    const amount = money(
      toDecimal(received).toDecimalPlaces(decimals, Decimal.ROUND_DOWN).toFixed(),
    );
    if (toDecimal(amount).lte(0))
      throw new ValidationError('The reported amount rounds to nothing.');
    const credited = await this.credit(
      tx,
      amount,
      { amount: received },
      tx.state === 'failure',
      actor,
      reason,
    );
    if (!credited)
      throw new MoneyRuleError('This deposit was finished by somebody else meanwhile.');
    await this.afterCredit({ ...tx, amount });
    return this.transactions.getById(txId);
  }

  /** CLOSE WITHOUT CREDIT — a person decided nothing should be credited. */
  async closeWithoutCredit(txId: string, actor: Actor, reason: string): Promise<TransactionRow> {
    assertActorCan(actor, 'deposits.reject', 'close a flagged deposit');
    const tx = await this.flaggedHostedDeposit(txId);
    const updated = await this.db.transaction(async (dbTx) => {
      const rows = await dbTx
        .update(transactions)
        .set({
          state: 'failure',
          settledAt: new Date(),
          needsAttention: false,
          attentionReason: null,
          // The CLIENT reads this on their transaction; the desk's own finding
          // stays in the audit row below — it was written for colleagues.
          rejectionReason: CLIENT_SAFE_DEPOSIT_CLOSED,
          reviewedBy: actor.id,
          reviewedAt: new Date(),
        })
        .where(and(eq(transactions.id, txId), inArray(transactions.state, ['pending', 'failure'])))
        .returning();
      if (rows.length === 0) return null;
      await this.auditLog.record(
        {
          actorId: actor.id,
          actorEmail: actor.email,
          actorKind: 'admin',
          action: 'deposit.close_without_credit',
          subjectType: 'transaction',
          subjectId: txId,
          details: { userId: tx.userId, amount: tx.amount, currency: tx.currency, reason },
        },
        dbTx,
      );
      return rows[0];
    });
    if (!updated) throw new MoneyRuleError('This deposit was finished by somebody else meanwhile.');
    if (tx.state === 'pending') {
      void this.transactions.sendDepositOutcomeEmail(tx.userId, 'failed', tx.amount, tx.currency);
    }
    return updated;
  }

  private async flaggedHostedDeposit(txId: string): Promise<TransactionRow> {
    const tx = await this.transactions.getById(txId);
    if (tx.direction !== 'deposit' || !this.registry.isRedirect(tx)) {
      throw new ValidationError('Only a deposit paid on a provider’s page is finished here.');
    }
    if (!tx.needsAttention || (tx.state !== 'pending' && tx.state !== 'failure')) {
      throw new MoneyRuleError('Only an unfinished deposit flagged for a person is finished here.');
    }
    return tx;
  }

  /* ── the sweep ──────────────────────────────────────────────────────────── */

  /**
   * One provider's hosted deposits, brought up to date — the poll behind the
   * webhook. Everything converges on `settleRow`, so the two can race freely.
   *
   *  1. Open deposits quiet for 2+ minutes, least recently asked first: a
   *     start that never answered is RECOVERED; the rest are asked (and, past
   *     30 minutes, re-checked upstream where the provider can).
   *  2. A `received` provider's links failed as EXPIRED in the last 30 days,
   *     re-asked hourly — its late confirmations are credited.
   *
   * A per-row failure logs and moves on: one unreachable payment must not
   * shield the others.
   *
   * Resolves `complete` when every open deposit it is responsible for (all but
   * the last two minutes', which the webhook has) was asked this pass — the
   * provider-balance books start only after such a pass (0175).
   */
  async sweep(providerCode: string): Promise<{ complete: boolean }> {
    const open = await this.db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.providerCode, providerCode),
          eq(transactions.direction, 'deposit'),
          eq(transactions.state, 'pending'),
          eq(transactions.needsAttention, false),
          lt(transactions.createdAt, new Date(Date.now() - QUIET_MS)),
          isNotNull(transactions.providerRef),
        ),
      )
      .orderBy(sql`${transactions.providerCheckedAt} ASC NULLS FIRST`, transactions.createdAt)
      .limit(BATCH);

    let settled = 0;
    let unasked = 0;
    let busy: ProviderBusyError | null = null;
    for (const tx of open) {
      try {
        if (!this.registry.isRedirect(tx)) continue;
        if (!tx.providerPaymentId) {
          await this.recoverStart(tx.id);
          unasked += 1; // found, perhaps, but not asked about its money yet
          continue;
        }
        const age = Date.now() - tx.createdAt.getTime();
        if (age > REFRESH_AFTER_MS) {
          try {
            await this.registry.refreshPayment(tx, tx.providerPaymentId);
          } catch (error) {
            this.logger.warn(
              `Upstream re-check of ${tx.providerPaymentId} failed: ${messageOf(error)}`,
            );
          }
        }
        const { state } = await this.settleRow(tx, 'poll');
        if (state !== 'pending') settled += 1;
        else if (age > STALE_AFTER_MS) {
          await this.flag(
            tx,
            'amount_mismatch',
            'The provider has not finished this payment after 7 days. Check it against the ' +
              'provider and finish it by hand.',
          );
        }
      } catch (error) {
        // At its request limit, the provider answers nothing more this pass:
        // stop, and the next sweep resumes where this one left off.
        if (error instanceof ProviderBusyError) {
          busy = error;
          break;
        }
        unasked += 1;
        this.logger.error(`Sweep could not resolve deposit ${tx.id}: ${messageOf(error)}`);
      }
    }

    const late = busy ? [] : await this.lateCandidates(providerCode);
    for (const tx of late) {
      try {
        const { state } = await this.settleRow(tx, 'poll');
        if (state === 'success') settled += 1;
      } catch (error) {
        if (error instanceof ProviderBusyError) {
          busy = error;
          break;
        }
        this.logger.error(`Late re-check of deposit ${tx.id} failed: ${messageOf(error)}`);
      }
    }
    if (busy) {
      this.logger.warn(
        `${providerCode} deposit sweep paused at the provider's request limit; the rest waits ` +
          `for the next sweep. ${busy.message}`,
      );
    }

    if (open.length + late.length > 0) {
      this.logger.log(
        `${providerCode} deposit sweep: ${open.length} open and ${late.length} expired ` +
          `checked, ${settled} settled.`,
      );
    }
    return { complete: busy === null && unasked === 0 && open.length < BATCH };
  }

  /** Expired links of a `received` provider, failed in the last 30 days, not asked this hour. */
  private async lateCandidates(providerCode: string): Promise<TransactionRow[]> {
    const received = (this.registry.find(providerCode)?.channels ?? [])
      .filter((c) => c.direction === 'deposit' && c.creditPolicy === 'received')
      .map((c) => c.code);
    if (received.length === 0) return [];
    return this.db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.providerCode, providerCode),
          inArray(transactions.channelCode, received),
          eq(transactions.direction, 'deposit'),
          eq(transactions.state, 'failure'),
          eq(transactions.needsAttention, false),
          isNotNull(transactions.providerPaymentId),
          sql`${transactions.settledAt} > now() - make_interval(secs => ${LATE_WATCH_MS / 1000})`,
          sql`coalesce(${transactions.providerCheckedAt}, 'epoch') < now() - make_interval(secs => ${
            LATE_RECHECK_MS / 1000
          })`,
        ),
      )
      .orderBy(sql`${transactions.providerCheckedAt} ASC NULLS FIRST`)
      .limit(BATCH);
  }

  /**
   * A start whose answer was lost: the provider finds or re-makes it by our
   * reference (Rival replays its create under the same key). One the provider
   * provably never made, an hour on, is failed — it never began, and nobody
   * holds a link to pay.
   */
  async recoverStart(txId: string): Promise<boolean> {
    const tx = await this.transactions.getById(txId);
    // Only an open hosted deposit with no provider id: replaying a start for a
    // settled one would mint a payable link for money that already arrived.
    if (tx.state !== 'pending' || tx.providerPaymentId || !tx.providerRef) return false;
    if (tx.direction !== 'deposit' || !this.registry.isRedirect(tx)) return false;
    const route: PaymentRoute = { providerCode: tx.providerCode, channelCode: tx.channelCode };
    const reference = tx.providerRef ?? '';
    const started = await this.registry.recoverPayment(route, {
      amount: tx.amount,
      currency: tx.currency,
      invoice: `Deposit ${reference}`,
      idempotencyKey: reference,
      successRedirectUrl: this.transactions.payerRedirectUrl(tx.provider, reference, 'success'),
      failureRedirectUrl: this.transactions.payerRedirectUrl(tx.provider, reference, 'failure'),
      callbackUrl: this.transactions.providerCallbackUrl(route.providerCode),
    });
    if (started) {
      await this.db
        .update(transactions)
        .set({
          providerPaymentId: started.externalId,
          providerPaymentUrl: started.paymentUrl || null,
          providerPaymentExpiresAt: started.expiresAt ?? null,
        })
        .where(and(eq(transactions.id, tx.id), sql`${transactions.providerPaymentId} IS NULL`));
      return true;
    }
    if (Date.now() - tx.createdAt.getTime() < START_ABANDONED_MS) return false;
    await this.db
      .update(transactions)
      .set({
        state: 'failure',
        settledAt: new Date(),
        rejectionReason: 'The payment could not be started.',
      })
      .where(and(eq(transactions.id, tx.id), eq(transactions.state, 'pending')));
    return false;
  }

  /* ── small shared bits ──────────────────────────────────────────────────── */

  /**
   * A person must decide: the flag (the desk, the Financial filter), a page
   * (for anyone reading the alert channel) and a task on the deposit desk's
   * bell — keyed per reason, so a replay rings once.
   */
  private async flag(
    tx: TransactionRow,
    reason: DepositAttentionReason,
    sentence: string,
    context: Record<string, string | undefined> = {},
  ): Promise<void> {
    await this.db
      .update(transactions)
      .set({
        needsAttention: true,
        attentionReason: sentence,
        ...(context['reported'] !== undefined
          ? { providerAmountReceived: context['reported'] }
          : {}),
      })
      .where(eq(transactions.id, tx.id));
    raiseAlert(
      this.logger,
      ALERT_KINDS.PAYMENT_STATE_MISMATCH,
      reason === 'over_limit' ? 'notify' : 'page',
      sentence,
      {
        transactionId: tx.id,
        provider: tx.providerCode,
        state: tx.state,
        ...Object.fromEntries(
          Object.entries(context).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        ),
      },
    );
    this.transactions.announceDepositAttention(tx, reason);
  }

  private async logEvent(
    tx: TransactionRow,
    eventType: 'payment.succeeded' | 'payment.failed',
    result: PaymentStatus,
    source: ProviderEventSource,
    outcome: ProviderEventOutcome,
    reason: string | null,
  ): Promise<void> {
    await this.providerEvents.append({
      providerCode: tx.providerCode,
      eventType,
      subjectId: tx.providerPaymentId ?? tx.id,
      providerType: result.rawStatus,
      source,
      transactionId: tx.id,
      outcome,
      reason,
    });
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The FIRST time the provider was seen confirming the money — never moved by a later check. */
function paidAtOnce(now: Date) {
  return sql`coalesce(${transactions.providerPaidAt}, ${now}::timestamptz)`;
}
