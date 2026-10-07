import { TransactionRecords } from './transaction-records';
import type { WithinTransaction } from './core/payments-ledger.port';
import { payerRedirectUrl, providerCallbackUrl } from './core/payer-urls';
import { depositStateOf } from './core/deposit-state';
import { Logger } from '@nestjs/common';
import { readProofDetails } from '../../common/payments/proof-fields';
import { payToSnapshot } from '../../common/payments/pay-to-fields';
import Decimal from 'decimal.js';
import { randomBytes } from 'crypto';
import { and, desc, eq } from 'drizzle-orm';
import { tradingAccounts, transactions, users, wallets } from '../../database/schema';
import { TransfersService } from './transfers.service';
import { TransferExecutor } from './transfer-executor.service';
import { LEDGER_REFERENCE } from '../../database/ledger-reference';
import { available, money, toDecimal } from '../wallet/money';
import { displayMoney } from '../../common/money-display';
import { PaymentMethodsService } from './payment-methods.service';
import { Currency, WalletService } from '../wallet/wallet.service';
import { CurrenciesService } from '../currencies/currencies.service';
import type { Db } from '../../database/db';
import { ConfigService } from '@nestjs/config';
import { EmailService } from '../email/email.service';
import { type NotificationDispatchPort } from '../../common/provisioning/notification-dispatch.port';
import { depositNamespace, PaymentProviderRegistry } from './providers/payment-provider-registry';
import type { PaymentRoute } from './providers/payment-provider';
import type { DepositAttentionReason } from '../../common/notifications/admin-notification-catalogue';
import {
  MoneyRuleError,
  NotFoundError,
  PaymentIndeterminateError,
  ValidationError,
} from '../../common/errors/domain-errors';
import { systemSentenceArabic } from '../../common/i18n/reason-arabic';
import { parseLocale } from '../../common/i18n/locale';

type TransactionRow = typeof transactions.$inferSelect;

/** The deposit commands: request, the desk's decisions, the credit, and the onward transfer. */
export class DepositCommands {
  private readonly logger = new Logger(DepositCommands.name);

  constructor(
    private readonly db: Db,
    private readonly wallets: WalletService,
    private readonly paymentMethods: PaymentMethodsService,
    private readonly currencies: CurrenciesService,
    private readonly providers: PaymentProviderRegistry,
    private readonly config: ConfigService,
    private readonly email: EmailService,
    private readonly notifications: NotificationDispatchPort,
    private readonly transfers: TransfersService,
    private readonly transferExecutor: TransferExecutor,
    private readonly records: TransactionRecords,
  ) {}

  /**
   * A client DECLARES a deposit they are about to send — CORE-06.
   *
   * This is not `creditDeposit` below and must never become it. Nothing is
   * credited here: the row is `pending`, the wallet is untouched, and the money
   * only lands when an operator confirms the transfer actually arrived.
   *
   * ## Why this exists when the payment providers do not
   *
   * The deposit screen said "waiting on backend endpoints" and named
   * `POST /payments/deposits` and a provider webhook. Both were blocked on
   * Whish/USDT credentials (§12.5, D-05) — but only the AUTOMATED flow was.
   * The flow every broker runs regardless needs no third-party credential: the
   * client says what they are sending, quotes a reference, and the operator
   * reconciles it against the bank statement.
   *
   * So the endpoint the screen was waiting for is still unbuilt, and this is a
   * different endpoint for a flow that was available all along.
   *
   * ## The reference
   *
   * The response's whole point. An operator working through a bank statement
   * has an amount and a name, and both repeat across clients; the reference is
   * what ties one incoming payment to one declared deposit without a phone
   * call. It doubles as the row's `providerRef`, so the UNIQUE(provider,
   * provider_ref) index that makes provider callbacks idempotent also
   * guarantees no two declarations can ever share a reference.
   */
  async requestDeposit(params: {
    userId: number;
    amount: string;
    currency: Currency;
    method: string;
    /** Set when the client chose to fund a trading account rather than the wallet. */
    destinationTradingAccountId?: string;
    /*
     * The receipt for an OFFLINE deposit — the stored `<uuid>.jpg`, already
     * written to DEPOSIT_PROOF_BUCKET by the caller.
     *
     * Passed in rather than uploaded here because this service does not touch
     * files: the controller writes the object, then hands over a name. The two
     * are tied together by the caller's rollback — if this method throws, the
     * object it just wrote is removed.
     */
    proofFilename?: string;
    /*
     * The client's answers to the method's `proofFields` (0163), as submitted —
     * `details[<fieldId>]` parts of the offline form. Judged here against the
     * fields the method asks NOW; see `readProofDetails`.
     */
    details?: unknown;
  }) {
    const amount = toDecimal(params.amount);
    // `lessThanOrEqualTo(0)`, NOT `!isPositive()` — see the withdrawal guard
    // above: decimal.js gives ZERO a sign of 1, so the obvious spelling is a
    // no-op for zero and the refusal arrives from the ledger instead.
    if (amount.lessThanOrEqualTo(0)) throw new ValidationError('Deposit amount must be positive.');

    const paymentMethod = await this.usableMethodFor(params.userId, params.method);

    /*
     * The method's currency wins over whatever the client sent.
     *
     * A Whish deposit is a USD deposit — that is a property of the method, not
     * a choice. Taking the caller's currency here would let a request name a
     * method denominated in one currency and a wallet in another, and the money
     * would land somewhere the operator never agreed to receive it.
     */
    const { code: currency, decimals } = await this.currencies.assertUsableDetail(
      paymentMethod.currency,
    );

    /*
     * Does this deposit go through a hosted payment page, or is it a declaration
     * an operator confirms by hand?
     *
     * Asked of `PaymentGateways` rather than read off the row. The `kind` column
     * went in migration 0043: it claimed to say how a method behaved, while the
     * real answer is whether THIS BUILD has an implementation for the key —
     * which is what is asked here, and what `PaymentMethodsService` was already
     * overriding the column with on every read.
     *
     * `isImplemented`, not `isConfigured`. By this point `assertUsable` has
     * already refused a gateway whose credentials are missing, and treating one
     * as manual here would file a bank-transfer declaration against a provider
     * with no bank account.
     */
    /*
     * The method's ROUTE decides the flow (0168) — not its key. A deposit on a
     * `redirect` channel opens the provider's hosted page and settles from the
     * provider; anything else is paid outside and confirmed by the desk.
     */
    const route: PaymentRoute = {
      providerCode: paymentMethod.providerCode,
      channelCode: paymentMethod.channelCode,
    };
    const depositChannel = this.providers.channel(route, 'deposit');
    const isGateway = depositChannel.flow === 'redirect';
    // `provider`, the idempotency namespace of UNIQUE(provider, provider_ref).
    const namespace = depositNamespace(route, paymentMethod.key);

    const proofDetails = this.proofDetailsFor(paymentMethod, isGateway, params);
    // What the client was told — where to send the money — as it reads NOW (0199).
    const payToDetails = payToSnapshot(paymentMethod.payToFields, paymentMethod.offline);

    this.assertPayableScale(
      paymentMethod,
      depositChannel.settlementScale,
      amount,
      currency,
      decimals,
    );

    /*
     * The method's resolved range: the tighter of its CURRENCY's deposit limits
     * and its own optional one (0162).
     */
    this.paymentMethods.assertAmountWithin(paymentMethod, amount);

    if (params.destinationTradingAccountId) {
      await this.assertFundableAccount(
        params.userId,
        params.destinationTradingAccountId,
        amount,
        currency,
        decimals,
      );
    }

    const wallet = await this.wallets.getOrCreateWallet(params.userId, currency);
    const reference = depositReference();

    const [tx] = await this.db
      .insert(transactions)
      .values({
        userId: params.userId,
        walletId: wallet.id,
        direction: 'deposit',
        amount: money(params.amount),
        currency,
        // What the client asked to FUND. The money still lands in the wallet —
        // that is the CRM's ledger — and settlement chains a transfer to move
        // it on. Null for an ordinary wallet deposit.
        destinationTradingAccountId: params.destinationTradingAccountId ?? null,
        // PENDING. The client has promised money, not sent it. Anything else
        // here would credit a balance off an unverified claim.
        state: 'pending',
        /*
         * The method the client chose, as a real foreign key.
         *
         * `provider` keeps the `manual_` prefix beside it: it is what
         * UNIQUE(provider, provider_ref) is scoped on, and keeping manual
         * declarations obviously distinct from a future gateway's rows means a
         * reconciliation job cannot confuse the two. When Whish becomes a
         * `gateway` method its rows will carry `whish` there instead, and the
         * two eras stay tellable apart.
         */
        methodKey: paymentMethod.key,
        /*
         * The idempotency namespace — `whish` for Rival's Whish, `manual_<key>`
         * for a deposit paid outside, as before 0168 (see `depositNamespace`).
         * UNIQUE(provider, provider_ref) is scoped on this column; nothing
         * routes on it any more.
         */
        provider: namespace,
        providerRef: reference,
        // The route it is filed on, recorded once (0168).
        providerCode: route.providerCode,
        channelCode: route.channelCode,
        providerEnvironment: await this.records.environmentOf(route.providerCode),
        // The receipt, or null on every method that does not ask for one.
        proofFilename: params.proofFilename ?? null,
        // Each answer with its label AS ASKED; immutable from here (0163 trigger).
        proofDetails: proofDetails.length > 0 ? proofDetails : null,
        // Where the client was told to send it; immutable from here (0199 trigger).
        payToDetails: payToDetails.length > 0 ? payToDetails : null,
      })
      .returning();

    const { paymentUrl, paymentExpiresAt } = isGateway
      ? await this.startHostedPayment(tx.id, route, namespace, reference, params.amount, currency)
      : { paymentUrl: null, paymentExpiresAt: null };

    if (!isGateway) this.announceDepositSubmitted(tx, paymentMethod.internalLabel, reference);

    return {
      id: tx.id,
      reference,
      amount: tx.amount,
      currency: tx.currency,
      method: paymentMethod.key,
      state: tx.state,
      createdAt: tx.createdAt.toISOString(),
      /*
       * Null for a manual method, and the portal branches on it. A screen that
       * assumed a link would send a bank-transfer client to nowhere; one that
       * assumed instructions would leave a gateway client with an account
       * number that is not how this method works.
       */
      paymentUrl,
      ...this.hostedPaymentFacts(route, paymentExpiresAt),
    };
  }

  /** The method is usable, judged on the client's country of residence. */
  private async usableMethodFor(userId: number, method: string) {
    /*
     * The METHOD decides the currency, and is checked before it.
     *
     * `assertUsable` refuses one that is unknown, disabled, or has no pay-to
     * details configured — a client cannot deposit through an account nobody
     * has set up. It returns the row, so the currency and the per-method bounds
     * come back without a second read.
     *
     * This replaced an `@IsIn(DEPOSIT_METHODS)` over a hardcoded two-element
     * union. Methods are operator data now: adding one is a row, and disabling
     * one when a provider goes down does not need a deploy.
     */
    const [depositor] = await this.db
      .select({ country: users.country })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const paymentMethod = await this.paymentMethods.assertUsable(
      method,
      depositor?.country ?? null,
    );
    return paymentMethod;
  }

  /** A receipt exactly when the method needs one, and its typed details. */
  private proofDetailsFor(
    paymentMethod: Awaited<ReturnType<PaymentMethodsService['assertUsable']>>,
    isGateway: boolean,
    params: { proofFilename?: string; details?: unknown },
  ) {
    /*
     * ── OFFLINE METHODS: the receipt is not optional ────────────────────────
     *
     * `requires_proof` is the method saying "the client pays outside this
     * system, so the only evidence anybody will ever have is the image". The
     * check lives HERE, not in a DTO, because it is a property of the method
     * the client chose and DTO validation cannot see the row.
     *
     * Both directions are refused, and each closes a real door:
     *
     *   proof missing on an offline method — the JSON route has no file field
     *   at all, so this is what stops a client bypassing the multipart door and
     *   filing a declaration with nothing attached. Without it the desk gets a
     *   queue of rows it cannot act on.
     *
     *   proof present on a method that did not ask for one — a gateway deposit
     *   is settled by the provider's webhook, so an attached image is evidence
     *   of nothing and would sit beside a payment this platform never handled.
     *
     * A method configured as BOTH a gateway and requires_proof is a
     * contradiction, and it is refused rather than resolved: guessing which half
     * the operator meant is how money ends up on a rail nobody chose.
     */
    if (paymentMethod.requiresProof && isGateway) {
      throw new ValidationError(
        `Payment method "${paymentMethod.key}" is configured to need a receipt and is also a ` +
          'hosted gateway. Those cannot both be true — fix the method before taking deposits on it.',
      );
    }
    if (paymentMethod.requiresProof && !params.proofFilename) {
      throw new ValidationError(
        'This payment method needs a picture of your transfer receipt. Please attach one.',
      );
    }
    if (!paymentMethod.requiresProof && params.proofFilename) {
      throw new ValidationError(`Payment method "${paymentMethod.key}" does not take a receipt.`);
    }
    /*
     * The details that identify the payment — the phone it was sent from, a
     * transfer code — judged before anything is written, so a refusal leaves
     * nothing behind (the controller removes the receipt it stored). Only an
     * offline method asks; a gateway deposit never carries any.
     */
    return paymentMethod.requiresProof
      ? readProofDetails(paymentMethod.proofFields, true, params.details)
      : [];
  }

  /** The amount is representable at the rail's settlement scale. */
  private assertPayableScale(
    paymentMethod: Awaited<ReturnType<PaymentMethodsService['assertUsable']>>,
    railScale: number | null,
    amount: Decimal,
    currency: string,
    decimals: number,
  ): void {
    // Per-method bounds AND the platform's own, because neither is derivable
    // from the other — a provider may refuse under $20 while the platform's
    // floor is $10.
    /*
     * Same two-scale rule as a withdrawal (D-77), and the deposit side is the
     * one where it bites harder.
     *
     * A deposit CREDITS `tx.amount` while the payment link is created at the
     * rail's scale (`quantiseIn`), so an amount with more places than the rail
     * can handle asks the client to pay one figure and credits them another.
     * Money-in rounds to NEAREST rather than down, so it can credit MORE than
     * was collected — the broker pays the difference, on every such deposit.
     *
     * Bounded by the SMALLER of the currency's decimals and the rail's scale,
     * for the reason the withdrawal path spells out: `currencies.decimals` is
     * operator data accepting 0 to 8, so checking it alone leaves the whole rule
     * inert the moment a currency is configured past what the rail supports.
     *
     * A MANUAL method has no rail and is bounded by the currency alone — an
     * operator reconciling a bank statement can handle whatever it expresses.
     */
    const payableDecimals = railScale === null ? decimals : Math.min(decimals, railScale);
    if (amount.decimalPlaces() > payableDecimals) {
      /*
       * HALF-UP, and this was wrong the other way round for a while.
       *
       * It rounded DOWN "for consistency with the withdrawal message", which
       * sounded reasonable and put two different numbers on one screen: the pay
       * button renders the amount through the portal's `formatMoney`, which
       * rounds HALF-UP for display, so `50.129` produced a button promising
       * "Pay $50.13" beside this message saying "Try 50.12 USD" — and clicking
       * the button failed.
       *
       * Consistency with the OTHER endpoint's wording mattered far less than
       * consistency with the number the client is looking at. A deposit also has
       * no balance to overshoot: the client is paying, so there is nothing to
       * protect by rounding down, and half-up is what they meant by 50.129.
       *
       * A WITHDRAWAL still floors, for the reason that does not apply here —
       * suggesting more than the client holds trades one refusal for another.
       */
      throw new ValidationError(
        `${paymentMethod.name} takes ${currency} to ${payableDecimals} decimal ` +
          `${payableDecimals === 1 ? 'place' : 'places'}. Use ` +
          `${amount.toDecimalPlaces(payableDecimals, Decimal.ROUND_HALF_UP).toFixed(payableDecimals)} ` +
          `${currency} instead.`,
      );
    }
  }

  /** A deposit may be routed on only to the client's own LIVE account. */
  private async assertFundableAccount(
    userId: number,
    accountId: string,
    amount: Decimal,
    currency: string,
    decimals: number,
  ): Promise<void> {
    /*
     * The chosen trading account, validated NOW rather than at settlement.
     *
     * The alternative — storing whatever id arrived and checking when the
     * operator confirms the payment — means the client's money has already been
     * received before anybody discovers the destination is a demo account, a
     * deleted one, or somebody else's. At that point the deposit cannot be
     * completed as declared and someone has to unpick it by hand.
     *
     * `userId` in the WHERE clause, so not-found and not-yours are the same
     * answer: an equality check after the fetch is one refactor away from being
     * dropped, and the consequence is funding a stranger's account.
     */
    const [account] = await this.db
      .select()
      .from(tradingAccounts)
      .where(and(eq(tradingAccounts.id, accountId), eq(tradingAccounts.userId, userId)))
      .limit(1);
    if (!account) throw new NotFoundError('Trading account not found.');
    if (account.environment !== 'live') {
      throw new ValidationError(
        'Only live trading accounts can be funded. Demo accounts trade practice money and are not linked to your wallet.',
      );
    }
    /*
     * The account's product minimum (0201), refused HERE rather than by the
     * onward transfer: that leg runs after the money has landed and never fails
     * the deposit, so a deposit below the minimum would quietly stop in the
     * wallet. Only in the account's own currency — another currency cannot be
     * transferred onward at all, which the transfer refuses with its own reason.
     */
    if (account.currency === currency) {
      await this.transfers.assertMeetsMinimum(account.id, amount, currency, decimals);
    }
  }

  /** Start the hosted payment and record its link; a failure fails the row. */
  private async startHostedPayment(
    txId: string,
    route: PaymentRoute,
    namespace: string,
    reference: string,
    rawAmount: string,
    currency: string,
  ): Promise<{ paymentUrl: string | null; paymentExpiresAt: Date | null }> {
    /*
     * A gateway deposit gets a payment LINK; a manual one gets instructions.
     *
     * The row is written FIRST and the provider called second, deliberately. If
     * the call fails, what is left behind is a pending deposit with no link —
     * visible, refusable, and re-startable. The other order risks a payment
     * existing at Whish that this system has no record of, which is money
     * arriving against a reference nobody can reconcile.
     *
     * `reference` is the externalId: it is already unique (the insert above
     * would have failed otherwise), it is what support quotes, and Whish treats
     * a reused one as a replay — so a retried request converges on one payment
     * rather than creating a second.
     *
     * ## ⚠️ WHAT THE ROW MUST SAY IF THE PROVIDER REFUSES
     *
     * Writing first is right and stays. What was wrong is what the row said
     * afterwards: it kept its `pending` state, which the client's transaction
     * list renders as money on its way. So a deposit that never started — the
     * gateway unreachable, credentials rejected, the request refused — sat in
     * the client's own history as processing, indefinitely, with no payment link
     * and nothing to reconcile it against. The client waits for a balance that
     * is not coming, and support has a queue of pending deposits that are not.
     *
     * A definite refusal now marks the row `failure`. It is NOT deleted: the
     * attempt happened, the client made it, and it is the row support quotes
     * when the client says "I tried and it did not work".
     *
     * ## The one case that must STAY pending
     *
     * `PaymentIndeterminateError` — the provider answered "I do not know"
     * (Whish's code `500`). A payment link may exist and may still be paid.
     * Marking that failed would tell a client who went on to pay that their
     * money did not arrive, which is far more expensive than a stale pending
     * row, and the reconciler settles it from `getStatus` either way.
     *
     * Nothing is credited or reversed on this path. It is a state correction on
     * a row that never touched a balance — `requestDeposit` writes no ledger
     * entries at all.
     */
    let paymentUrl: string | null = null;
    let paymentExpiresAt: Date | null = null;
    try {
      const started = await this.providers.startPayment(route, {
        amount: money(rawAmount),
        currency,
        invoice: `Deposit ${reference}`,
        /*
         * Our reference as the idempotency key: a retried request converges
         * on ONE Rival payment. No callback URLs any more — Rival owns the
         * provider relationship and reports back through the signed CRM
         * webhook and the poll backstop, never through an anonymous GET.
         */
        idempotencyKey: reference,
        // The return link names the NAMESPACE the status and settle routes
        // match on — not the method key, which differs for any method but
        // the original `whish`.
        successRedirectUrl: payerRedirectUrl(this.config, namespace, reference, 'success'),
        failureRedirectUrl: payerRedirectUrl(this.config, namespace, reference, 'failure'),
        // For providers that take their callback per request (3pay).
        callbackUrl: providerCallbackUrl(this.providers, this.config, route.providerCode),
      });
      paymentUrl = started.paymentUrl;
      paymentExpiresAt = started.expiresAt ?? null;
      /*
       * The provider's id, stored the moment it is known (0173's neutral
       * column). It is the ONLY key inbound events address this payment by,
       * so a row without it is invisible to the event stream and settles by
       * poll alone. The page and its expiry are kept for the client's
       * waiting card, which must survive a reload.
       */
      await this.db
        .update(transactions)
        .set({
          providerPaymentId: started.externalId,
          providerPaymentUrl: started.paymentUrl,
          providerPaymentExpiresAt: started.expiresAt ?? null,
        })
        .where(eq(transactions.id, txId));
    } catch (error) {
      if (error instanceof PaymentIndeterminateError) {
        /*
         * The create may have landed at Rival without a usable answer. If
         * Rival got far enough to assign an externalId, keep it — the
         * poller can then ask directly; without one, the poller replays the
         * create under the same idempotency key and converges either way.
         */
        const externalId = error.details?.['providerPaymentId'];
        if (typeof externalId === 'string' && externalId.length > 0) {
          await this.db
            .update(transactions)
            .set({ providerPaymentId: externalId })
            .where(eq(transactions.id, txId));
        }
      }
      if (!(error instanceof PaymentIndeterminateError)) {
        await this.db
          .update(transactions)
          .set({
            state: 'failure',
            /*
             * The provider's own reason, kept on the row. These messages are
             * already written to be shown to a client, so this leaks nothing
             * — and "the payment provider refused the request" is exactly what
             * support needs when the client asks why, months later, from a row
             * that would otherwise say only `failure`.
             */
            rejectionReason:
              error instanceof Error ? error.message : 'The payment could not be started.',
            /*
             * Its Arabic (0179): the provider's own words are English, so an
             * Arabic reader is told the fixed sentence instead of reading them.
             */
            rejectionReasonAr:
              (error instanceof Error ? systemSentenceArabic(error.message) : null) ??
              systemSentenceArabic('The payment could not be started.'),
            settledAt: new Date(),
          })
          .where(eq(transactions.id, txId));
      }
      /*
       * Rethrown either way. The client asked to deposit and no deposit is
       * possible; swallowing this would return a confirmation screen for a
       * payment with no link and no chance of arriving.
       */
      throw error;
    }
    return { paymentUrl, paymentExpiresAt };
  }

  /** A deposit a person must check rings the desk (never a hosted one). */
  private announceDepositSubmitted(
    tx: { id: string; amount: string; currency: string; userId: number },
    methodLabel: string,
    reference: string,
  ): void {
    /*
     * Ring the bells of whoever will have to ACTION this — manual methods only.
     *
     * A manual declaration ("I sent a bank transfer, reference X") settles by an
     * admin looking at the receipt and approving it — `PATCH
     * /admin/deposits/:id/approve`, gated on `deposits.approve`, which is the
     * permission this rings.
     *
     * It rang `wallets.credit` until the offline deposit desk existed, because
     * there was no deposit approval route at all and the only way to settle one
     * was to type the amount into `POST /admin/wallets/credit` — which minted a
     * SECOND, unrelated row and left the client's declaration pending for ever.
     * Ringing the old key now would page the people who can mint arbitrary
     * credit rather than the people who work this queue. Until somebody looks,
     * the client's money is sitting in a real bank account against a row nobody
     * has been told about — which is exactly the case that used to be found only
     * when the client chased it.
     *
     * A GATEWAY deposit rings nothing, deliberately. It settles from the signed
     * webhook (or the poll backstop) with no human in the path, so a bell would
     * announce a queue item that does not exist and train operators to ignore
     * the ones that do. The client still hears about it — `deposit.succeeded`
     * fires on settlement.
     *
     * Post-write and never-throws, like the withdrawal fan-out above: the row is
     * already committed, and the polled queue badge stays the durable signal.
     * The dedupe key is the transaction id, so a retried request that converged
     * on one row also converges on one bell.
     */
    void this.notifications.notifyAdmins({
      kind: 'admin.deposit.submitted',
      params: {
        transactionId: tx.id,
        amount: tx.amount,
        currency: tx.currency,
        // The DESK's name (0161), never the key: this is the sentence an
        // operator reads ("…sent 100 USD by OMT – Hamra"). Snapshot at filing.
        method: methodLabel,
        reference,
      },
      dedupeKey: `admin.deposit.submitted:${tx.id}`,
      subject: { id: tx.id, clientId: tx.userId },
    });
  }

  /**
   * What the client's screen needs about a hosted payment beyond its link
   * (0173): when the link stops accepting money, whether the provider sends
   * the payer back afterwards (3pay does not — the portal then keeps them on a
   * live waiting card), and what to send when it is not the wallet currency
   * ("USDT on Tron (TRC20)", credited at par).
   */
  hostedPaymentFacts(
    route: PaymentRoute,
    expiresAt: Date | null,
  ): { paymentExpiresAt: string | null; returnsAfterPayment: boolean; payWith: string | null } {
    const channel = this.providers.findChannel(route, 'deposit');
    return {
      paymentExpiresAt: expiresAt ? expiresAt.toISOString() : null,
      returnsAfterPayment: channel?.hostedPageReturns ?? true,
      payWith: channel?.asset?.label ?? null,
    };
  }

  /**
   * The deposit's CURRENT state, for the owner only — reads nothing from the
   * provider and changes nothing. The GET the portal polls used to be
   * `settleGatewayDeposit`, i.e. a state change (and a wallet credit) behind a
   * GET, outside the anti-forgery guard, reachable by a prefetcher, a link
   * scanner or the back button. Settling is `POST …/settle` now; this is what
   * a GET is allowed to be.
   */
  async gatewayDepositState(
    method: string | undefined,
    reference: string,
    ownerId: number,
  ): Promise<ReturnType<typeof depositStateOf>> {
    const tx = await this.findDepositByReference(method, reference, ownerId);
    if (!tx || tx.userId !== ownerId) throw new NotFoundError('No deposit matches that reference.');
    return depositStateOf(tx);
  }

  /**
   * A deposit by the reference its payer holds. With the namespace (`?method=`,
   * what the return link carries) it is the exact UNIQUE(provider, provider_ref)
   * row; without one (a link from before 0168, or trimmed by a browser) the
   * reference and its OWNER find it — never a guessed provider, which is what
   * the old `whish` fallback was.
   */
  async findDepositByReference(
    method: string | undefined,
    reference: string,
    ownerId: number | undefined,
  ) {
    const [tx] = await this.db
      .select()
      .from(transactions)
      .where(
        method
          ? and(eq(transactions.provider, method), eq(transactions.providerRef, reference))
          : and(
              eq(transactions.providerRef, reference),
              eq(transactions.direction, 'deposit'),
              ownerId !== undefined ? eq(transactions.userId, ownerId) : undefined,
            ),
      )
      .orderBy(desc(transactions.createdAt))
      .limit(1);
    return tx ?? null;
  }

  /**
   * APPROVE an offline deposit: the client says they sent money, an operator has
   * seen the receipt, and this is the credit.
   *
   * ## It is `settleGatewayDeposit` with a person where the webhook was
   *
   * Identical write, same order, same guarantees — the only difference is what
   * authorises it. A gateway deposit is settled by the provider confirming the
   * payment; an offline deposit is settled by somebody looking at an image and
   * their own bank statement. Everything after that decision is the same money
   * movement, which is why this method mirrors that one rather than inventing a
   * second way to credit a wallet.
   *
   * ## What makes a double-click safe — three layers, and the middle one carries it
   *
   *   1. `@Idempotent()` on the route: a replayed HTTP request never reaches here.
   *   2. The §8.7 conditional transition. The loser of a race throws, and because
   *      the throw happens INSIDE this transaction its own `wallets.post` is
   *      rolled back with it. This is the layer that actually stops a second
   *      credit.
   *   3. `ledger_entries_wallet_reference_uq` on (wallet, 'transaction', id).
   *      Even if two credits somehow committed, the second returns the existing
   *      entry and the balance does not move.
   *
   * ## Credit first, then transition
   *
   * The order `settleGatewayDeposit` uses. Correctness is identical either way
   * inside one transaction, so the reason is serialisation: `post` takes
   * `SELECT … FOR UPDATE` on the wallet, and taking it first means two approvals
   * for one client queue on the wallet in a consistent order rather than
   * deadlocking against each other.
   */
  async approveDeposit(id: string, adminId: string, withinTx?: WithinTransaction) {
    const tx = await this.records.getById(id);
    if (tx.direction !== 'deposit') {
      throw new ValidationError('That transaction is not a deposit.');
    }
    /*
     * ⚠️ A GATEWAY DEPOSIT MAY NEVER BE CREDITED BY HAND.
     *
     * Its money arrives through the provider and is confirmed by the webhook. An
     * operator approving one here would credit a client for a payment the
     * platform has no confirmation of — and the webhook would then settle it
     * again, which the ledger constraint absorbs silently, leaving a credited
     * deposit nobody can trace to a payment.
     *
     * `manual_` is the prefix `requestDeposit` writes for every non-gateway
     * method, and UNIQUE(provider, provider_ref) is scoped on that column, so it
     * is the reliable marker rather than a guess from the method key.
     */
    // Only a deposit paid OUTSIDE the platform is the desk's to decide (0168);
    // a hosted one settles from its provider.
    if (
      !this.providers.isDeskDecided({ providerCode: tx.providerCode, channelCode: tx.channelCode })
    ) {
      throw new MoneyRuleError(
        'That deposit settles from the payment provider, not by hand. Nothing was credited.',
      );
    }

    const row = await this.db.transaction(async (dbTx) => {
      await this.wallets.post(
        {
          userId: tx.userId,
          currency: tx.currency,
          amount: tx.amount,
          entryType: 'deposit',
          referenceType: LEDGER_REFERENCE.transaction,
          // NO suffix: this IS the deposit, not a compensation for one. The
          // reference is what ties the ledger entry to the row an operator
          // approved, and what makes a second credit impossible.
          referenceId: tx.id,
        },
        dbTx,
      );

      const now = new Date();
      const updated = await this.records.transition(
        id,
        'pending',
        /*
         * `settledAt` is set here, unlike an approved WITHDRAWAL, and the
         * difference is real rather than an oversight: a withdrawal waits for a
         * payout rail to move the money, so approval and settlement are two
         * events. Here the operator confirming IS the settlement — no second
         * event is coming, and the money is in the wallet the moment this
         * commits.
         */
        { state: 'success', reviewedBy: adminId, reviewedAt: now, settledAt: now },
        dbTx,
      );
      if (!updated) {
        const current = await this.records.getById(id);
        throw new MoneyRuleError(
          `Only a pending deposit can be approved; this one is ${current.state}.`,
        );
      }

      /*
       * The client is told in the SAME transaction as the credit, so money can
       * never be credited with the client untold (FR-CORE-07). `deposit.succeeded`
       * is the kind the portal already renders — an offline deposit reaching the
       * wallet is the same fact as a Whish one, and the client does not care that
       * an operator was involved.
       */
      await this.notifications.notify(
        {
          recipient: { kind: 'client', id: tx.userId },
          kind: 'deposit.succeeded',
          params: { transactionId: tx.id, amount: tx.amount, currency: tx.currency },
          dedupeKey: `deposit.succeeded:${tx.id}`,
        },
        dbTx,
      );

      // The admin audit row, written by the caller inside this transaction (R-6.5):
      // if it cannot be written, the money does not move.
      await withinTx?.(dbTx, updated);
      return updated;
    });

    void this.sendDepositOutcomeEmail(tx.userId, 'succeeded', tx.amount, tx.currency);

    /*
     * A deposit aimed at a trading account becomes TWO movements, and this is the
     * second — the same call `settleGatewayDeposit` makes, so both deposit paths
     * end in the same place. POST-COMMIT and reached only by the winner of the
     * conditional transition above, which is what stops one deposit chaining two
     * transfers. It keeps its own catch: an MT5 outage must not fail an approval
     * whose ledger entry is already committed.
     */
    await this.chainTransferToAccount(tx);
    return row;
  }

  /**
   * REJECT an offline deposit — the receipt does not match, is unreadable, or
   * the money never arrived.
   *
   * ## ⚠️ THERE IS NO REFUND HERE, AND THAT IS NOT AN OMISSION
   *
   * The symmetry with `reject` for a withdrawal is a trap, because the two mean
   * opposite things. A withdrawal is DEBITED when the client asks, so refusing
   * it must post a compensating credit or the client is permanently short —
   * `rejected` is terminal.
   *
   * A deposit debits nothing. `requestDeposit` writes no ledger entry at all: it
   * records a claim that money is coming. So there is nothing to give back, and
   * posting a credit here would CREATE money the platform never received — a
   * refused deposit would become a free balance, which is the one outcome this
   * whole approval step exists to prevent.
   *
   * What the client is owed instead is an EXPLANATION, and possibly their money
   * back from wherever they actually sent it — which is support's job, not the
   * ledger's. The notification, the email and the admin copy all say so.
   *
   * `settledAt` stays null: nothing settled.
   */
  async rejectDeposit(
    id: string,
    adminId: string,
    reason: string,
    withinTx?: WithinTransaction,
    /** The reason in Arabic (0179); omitted = the catalogue's Arabic of a system sentence. */
    reasonAr?: string | null,
  ) {
    const arabic = reasonAr === undefined ? systemSentenceArabic(reason) : reasonAr;
    const tx = await this.records.getById(id);
    if (tx.direction !== 'deposit') {
      throw new ValidationError('That transaction is not a deposit.');
    }
    // Only a deposit paid OUTSIDE the platform is the desk's to decide (0168);
    // a hosted one settles from its provider.
    if (
      !this.providers.isDeskDecided({ providerCode: tx.providerCode, channelCode: tx.channelCode })
    ) {
      throw new MoneyRuleError(
        'That deposit settles from the payment provider, so it cannot be rejected by hand.',
      );
    }

    const row = await this.db.transaction(async (dbTx) => {
      const rejected = await this.records.transition(
        id,
        'pending',
        {
          state: 'rejected',
          rejectionReason: reason,
          rejectionReasonAr: arabic,
          reviewedBy: adminId,
          reviewedAt: new Date(),
        },
        dbTx,
      );
      if (!rejected) {
        const current = await this.records.getById(id);
        throw new MoneyRuleError(
          `Only a pending deposit can be rejected; this one is ${current.state}.`,
        );
      }

      await this.notifications.notify(
        {
          recipient: { kind: 'client', id: tx.userId },
          kind: 'deposit.rejected',
          // The REASON travels with it. A client told only that their deposit was
          // refused, after they have already sent money, has nothing to act on.
          params: {
            transactionId: tx.id,
            amount: tx.amount,
            currency: tx.currency,
            reason,
            ...(arabic ? { reasonAr: arabic } : {}),
          },
          dedupeKey: `deposit.rejected:${tx.id}`,
        },
        dbTx,
      );

      await withinTx?.(dbTx, rejected);
      return rejected;
    });

    /*
     * POST-COMMIT, like every decision mail. Inside the transaction it would go
     * out before the rejection was durable — and a client told their deposit was
     * refused by a transaction that then rolled back is worse than a late email.
     */
    void this.sendDepositOutcomeEmail(
      tx.userId,
      'rejected',
      tx.amount,
      tx.currency,
      reason,
      arabic,
    );
    return row;
  }

  /**
   * Put a deposit only a person can settle in front of the people who can.
   *
   * The pager alert beside each call reaches whoever reads the alert channel
   * — on a deployment with no sink registered, nobody. This is the task on the
   * deposit desk's own bell, scoped to the client's territory like every task.
   * A reason CODE, not the sentence above: the frontends own the copy, and the
   * provider's wording never reaches a bell. Keyed per reason, so a replayed
   * webhook rings once, and resolved when somebody clears the flag ("Mark
   * resolved") or settles the row — migration 0140's trigger, not this code.
   * Post-write and never-throws, like every fan-out.
   */
  announceDepositAttention(
    tx: { id: string; userId: number; amount: string; currency: string },
    reason: DepositAttentionReason,
  ): void {
    void this.notifications.notifyAdmins({
      kind: 'admin.deposit.attention',
      params: { transactionId: tx.id, amount: tx.amount, currency: tx.currency, reason },
      dedupeKey: `admin.deposit.attention:${tx.id}:${reason}`,
      subject: { id: tx.id, clientId: tx.userId },
    });
  }

  /**
   * The FR-CORE-07 outcome mail, looked up and sent AFTER the outcome is
   * committed. Never throws: the send itself is log-and-swallow inside
   * `EmailService`, and the user lookup here gets the same treatment — this
   * helper is `void`-dispatched, so a rejection would surface as an unhandled
   * rejection about a courtesy.
   */
  async sendDepositOutcomeEmail(
    userId: number,
    outcome: 'succeeded' | 'failed' | 'rejected',
    amount: string,
    currency: string,
    reason?: string,
    /** The reason's stored Arabic (0179). */
    reasonAr?: string | null,
  ): Promise<void> {
    try {
      const [user] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
      if (!user) return;
      await this.email.sendDepositOutcomeEmail(
        user.email,
        user.firstName,
        outcome,
        amount,
        currency,
        reason,
        // Settled by a webhook, a sweep or the desk: the client's stored language.
        parseLocale(user.locale),
        reasonAr,
      );
    } catch (error) {
      this.logger.warn(
        `Could not send the deposit ${outcome} email for transaction owner ${userId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Deposit credit — the desk's hand credit. ONE transaction: the row, the
   * ledger entry and (through `withinTx`) the audit row commit together, so a
   * crash can never leave a 'success' deposit without its credit. Idempotent on
   * UNIQUE(provider, provider_ref): a replay finds the committed row and posts
   * nothing.
   */
  async creditDeposit(
    params: {
      userId: number;
      amount: string;
      currency: Currency;
      provider: string;
      providerRef: string;
    },
    withinTx?: WithinTransaction,
  ) {
    const wallet = await this.wallets.getOrCreateWallet(params.userId, params.currency);
    return this.db.transaction(async (dbTx) => {
      const [tx] = await dbTx
        .insert(transactions)
        .values({
          userId: params.userId,
          walletId: wallet.id,
          direction: 'deposit',
          amount: money(params.amount),
          currency: params.currency,
          state: 'success',
          provider: params.provider,
          providerRef: params.providerRef,
          // The desk's own credit: Manual's `adjustment`, never a client's method (0168).
          providerCode: 'manual',
          channelCode: 'adjustment',
          providerEnvironment: 'live',
          settledAt: new Date(),
        })
        .onConflictDoNothing({ target: [transactions.provider, transactions.providerRef] })
        .returning();

      if (!tx) {
        // Replay — the original transaction and its credit committed together.
        const [existing] = await dbTx
          .select()
          .from(transactions)
          .where(
            and(
              eq(transactions.provider, params.provider),
              eq(transactions.providerRef, params.providerRef),
            ),
          )
          .limit(1);
        return { transaction: existing, replayed: true as const };
      }

      await this.wallets.post(
        {
          userId: params.userId,
          currency: params.currency,
          amount: params.amount,
          entryType: 'deposit',
          referenceType: LEDGER_REFERENCE.transaction,
          referenceId: tx.id,
        },
        dbTx,
      );
      // No commission here: a deposit is client money, not revenue (see
      // `CommissionService.accrueForClosedPosition`).
      await withinTx?.(dbTx, tx);
      return { transaction: tx, replayed: false as const };
    });
  }

  /**
   * Withdrawal debit — the desk's hand withdrawal (owner, 7 Oct 2026), the
   * mirror of `creditDeposit`: money LEAVES the platform from the wallet, as a
   * completed `withdrawal` row. ONE transaction: the row, the ledger debit and
   * (through `withinTx`) the audit row commit together. Idempotent on
   * UNIQUE(provider, provider_ref).
   *
   * Refused beyond the AVAILABLE balance — balance less what in-flight
   * transfers hold — checked under the wallet's row lock. `post` checks the
   * balance alone, and a debit into held money would be refused by
   * `wallets_hold_within_balance` as a 500 rather than a sentence.
   */
  async debitAdjustment(
    params: {
      userId: number;
      amount: string;
      currency: Currency;
      provider: string;
      providerRef: string;
    },
    withinTx?: WithinTransaction,
  ) {
    const wallet = await this.wallets.getOrCreateWallet(params.userId, params.currency);
    return this.db.transaction(async (dbTx) => {
      const [existing] = await dbTx
        .select()
        .from(transactions)
        .where(
          and(
            eq(transactions.provider, params.provider),
            eq(transactions.providerRef, params.providerRef),
          ),
        )
        .limit(1);
      if (existing) return { transaction: existing, replayed: true as const };

      const [locked] = await dbTx
        .select({ balance: wallets.balance, onHold: wallets.onHold })
        .from(wallets)
        .where(eq(wallets.id, wallet.id))
        .for('update');
      const free = toDecimal(available(locked.balance, locked.onHold));
      if (free.lessThan(toDecimal(params.amount))) {
        throw new MoneyRuleError(
          `Insufficient available balance: the wallet has ` +
            `${displayMoney(money(free), params.currency)} available, and this needs ` +
            `${displayMoney(money(params.amount), params.currency)}.`,
        );
      }

      const [tx] = await dbTx
        .insert(transactions)
        .values({
          userId: params.userId,
          walletId: wallet.id,
          direction: 'withdrawal',
          amount: money(params.amount),
          currency: params.currency,
          state: 'success',
          provider: params.provider,
          providerRef: params.providerRef,
          // The desk's own debit: Manual's `adjustment`, never a client's method (0168).
          providerCode: 'manual',
          channelCode: 'adjustment',
          providerEnvironment: 'live',
          settledAt: new Date(),
        })
        .onConflictDoNothing({ target: [transactions.provider, transactions.providerRef] })
        .returning();
      if (!tx) {
        // A racing replay committed first; the wallet lock serialised us behind it.
        const [raced] = await dbTx
          .select()
          .from(transactions)
          .where(
            and(
              eq(transactions.provider, params.provider),
              eq(transactions.providerRef, params.providerRef),
            ),
          )
          .limit(1);
        return { transaction: raced, replayed: true as const };
      }

      await this.wallets.post(
        {
          userId: params.userId,
          currency: params.currency,
          amount: toDecimal(params.amount).negated(),
          entryType: 'withdrawal',
          referenceType: LEDGER_REFERENCE.transaction,
          referenceId: tx.id,
        },
        dbTx,
      );
      await withinTx?.(dbTx, tx);
      return { transaction: tx, replayed: false as const };
    });
  }

  /**
   * Move a settled deposit on to the trading account it was aimed at.
   *
   * ## Two movements, and the client sees both
   *
   * A deposit routed to an account is a DEPOSIT into the wallet followed by a
   * TRANSFER out of it. It is not one operation with a different endpoint: the
   * wallet is this system's ledger, every deposit lands there, and the money
   * reaches MT5 the same way any other transfer does — through
   * `TransferExecutor`, with the same idempotency key, the same hold, and the
   * same settlement.
   *
   * That also means the client's history shows the two rows that actually
   * happened, rather than one row implying money went somewhere it never was.
   *
   * ## AFTER the credit commits, never inside it
   *
   * The transfer debits the wallet, so the deposit's credit has to be durable
   * first — chaining inside the settlement transaction would take money out of a
   * balance that does not exist yet if the outer commit then failed.
   *
   * ## A failed transfer must NOT fail the deposit
   *
   * The money is legitimately in the wallet by this point. Leaving it there is
   * safe, visible and recoverable: the client can transfer it themselves, and
   * nothing is lost. Unwinding a settled deposit to punish a failed onward leg
   * would be far worse, and the reasons this can fail are ordinary — an
   * unverified client (transfers need KYC level 1), a suspended account, or an
   * unreachable bridge.
   *
   * So it is logged with the transaction id and swallowed. The deposit stands.
   */
  async chainTransferToAccount(tx: TransactionRow): Promise<void> {
    if (!tx.destinationTradingAccountId) return;

    try {
      const transfer = await this.transfers.request({
        userId: tx.userId,
        tradingAccountId: tx.destinationTradingAccountId,
        direction: 'wallet_to_account',
        amount: tx.amount,
        currency: tx.currency,
      });

      /*
       * Executed here rather than left pending, so the common case finishes
       * while the client is still looking at the screen. `execute` is the same
       * call the transfer endpoint makes, and it is idempotent on the transfer
       * id — a retry cannot move the money twice.
       */
      await this.transferExecutor.execute(transfer.id);

      this.logger.log(
        `Deposit ${tx.id} chained transfer ${transfer.id}: ${tx.amount} ${tx.currency} ` +
          `to trading account ${tx.destinationTradingAccountId}`,
      );
    } catch (error) {
      this.logger.error(
        `Deposit ${tx.id} settled but its onward transfer to trading account ` +
          `${tx.destinationTradingAccountId} could not be made: ` +
          `${error instanceof Error ? error.message : String(error)}. ` +
          'The money is credited to the wallet and can be transferred from there.',
      );
    }
  }
}

/**
 * A short reference a human can read down a phone line and type into a bank
 * form.
 *
 * Crockford's base32 — no I, L, O or U — because this string is transcribed by
 * people: `0`/`O` and `1`/`I` are the transcription errors that turn a
 * reconciled payment into a support ticket, and U is dropped so the alphabet
 * cannot spell anything unfortunate.
 *
 * Six characters is ~1.07 billion values. It is NOT a secret and does not need
 * to be — quoting somebody else's reference on your own transfer credits THEIR
 * declaration with YOUR money, which is a strange attack to mount. Collisions
 * are what matter, and the UNIQUE(provider, provider_ref) index turns one into
 * a failed insert rather than two clients sharing a reference.
 */
function depositReference(): string {
  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const bytes = randomBytes(6);
  let out = '';
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return `OX-${out}`;
}
