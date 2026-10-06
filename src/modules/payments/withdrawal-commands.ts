import { TransactionRecords } from './transaction-records';
import type { WithinTransaction } from './core/payments-ledger.port';
import { COUNTRY_REFUSAL, countryEligible } from '../../common/payments/method-eligibility';
import Decimal from 'decimal.js';
import { asc, eq } from 'drizzle-orm';
import { transactions, users, withdrawalPaymentMethods } from '../../database/schema';
import { LEDGER_REFERENCE } from '../../database/ledger-reference';
import { assertActorCan, type Actor } from '../../common/security/actor';
import { money, toDecimal } from '../wallet/money';
import { formatLimit } from '../../common/currency-limits';
import { channelSwitchKey, readOffSwitches } from './core/channel-switches.service';
import { Currency, WalletService } from '../wallet/wallet.service';
import { CurrenciesService } from '../currencies/currencies.service';
import type { Db } from '../../database/db';
import { type NotificationDispatchPort } from '../../common/provisioning/notification-dispatch.port';
import { PaymentProviderRegistry } from './providers/payment-provider-registry';
import type { PaymentRoute } from './providers/payment-provider';
import {
  AuthorizationError,
  MoneyRuleError,
  NotFoundError,
  ValidationError,
} from '../../common/errors/domain-errors';
import { systemSentenceArabic } from '../../common/i18n/reason-arabic';
import { registerLabelTwins } from '../../common/i18n/localize-message';
import { payToSnapshot, shownPayToFields } from '../../common/payments/pay-to-fields';

/**
 * Which withdrawal lifecycle an approval follows — see `approve()`.
 *
 * Not a boolean parameter, and not defaulted. Both lifecycles are correct for
 * their own rail and dangerous for the other, so the caller has to have thought
 * about it: a default would silently pick one the day a new payout rail is added.
 */
export interface ApproveWithdrawalOptions {
  /**
   * True when a payout rail will send the money and its event will settle the row.
   * False when a human is sending it, so approval records a completed payout.
   */
  awaitsProviderPayout: boolean;
}

type WithdrawalMethodRow = typeof withdrawalPaymentMethods.$inferSelect;

/**
 * Withdrawal lifecycle (§8.4 + FR-ADM-03).
 *
 *   request  → post the DEBIT, state=pending
 *   approve  → state=approved                    (no balance change)
 *   settle   → state=success                     (no balance change)
 *   reject   → post a compensating CREDIT, state=rejected, reason emailed
 *   fail     → post a compensating CREDIT, state=failure, client emailed
 *
 * ## Debit on request, not a hold — changed deliberately
 *
 * The earlier version reserved the funds in `wallets.on_hold` and posted the
 * debit only at settlement, so a pending withdrawal left the balance looking
 * untouched. That let a client request two withdrawals each within their
 * balance but not within it together, be told both were submitted, and have the
 * second refused later by an admin reading a number the client had never seen.
 *
 * Debiting at request means the balance always shows committed funds. The cost
 * is that a refusal has to give the money back, and it does so with a
 * COMPENSATING ENTRY (§6.4) — the original debit is never edited or deleted.
 * See `refund()` for why its reference carries a `:refund` suffix.
 *
 * `on_hold` still exists and is still used, by TRANSFERS: the wallet→account
 * leg holds while the bridge confirms, because there the counterparty really
 * can refuse after the fact.
 */
export class WithdrawalCommands {
  constructor(
    private readonly db: Db,
    private readonly wallets: WalletService,
    private readonly currencies: CurrenciesService,
    private readonly providers: PaymentProviderRegistry,
    private readonly notifications: NotificationDispatchPort,
    private readonly records: TransactionRecords,
  ) {}

  /**
   * The payout rails on offer — what the portal's method picker renders.
   *
   * ENABLED only, ordered by `sort_order` then name, which is exactly the index
   * migration 0062 creates. Disabled rails are omitted rather than shown
   * greyed: a client cannot act on the difference, and a method they can see
   * but not choose reads as a fault in the page.
   *
   * The list is presentation. `requestWithdrawal` re-checks the key against the
   * same table and refuses anything absent or disabled, so hiding a rail here
   * is never what stops it being used (R-4.3).
   */
  /** `clientCountry`: a method's country rule applies (0178). */
  async listWithdrawalMethods(clientCountry: string | null) {
    const rows = await this.db
      .select({
        key: withdrawalPaymentMethods.key,
        name: withdrawalPaymentMethods.name,
        nameAr: withdrawalPaymentMethods.nameAr,
        logoUrl: withdrawalPaymentMethods.logoUrl,
        providerCode: withdrawalPaymentMethods.providerCode,
        channelCode: withdrawalPaymentMethods.channelCode,
        countryRule: withdrawalPaymentMethods.countryRule,
        countryCodes: withdrawalPaymentMethods.countryCodes,
        payToFields: withdrawalPaymentMethods.payToFields,
      })
      .from(withdrawalPaymentMethods)
      .where(eq(withdrawalPaymentMethods.enabled, true))
      .orderBy(asc(withdrawalPaymentMethods.sortOrder), asc(withdrawalPaymentMethods.name));
    const off = await readOffSwitches(this.db);
    const offered: typeof rows = [];
    for (const row of rows) {
      if (!countryEligible(row, clientCountry)) continue;
      if (await this.payoutMethodOffered(row, off)) offered.push(row);
    }
    // What the client must give, from the method's payout channel (0168) — the
    // portal renders the field by its kind, never by the method's key.
    // The country rule decided WHETHER it is offered; it is the desk's configuration
    // and not part of what a client is sent (`WithdrawalMethodDto` does not name it).
    return offered.map(
      ({
        providerCode,
        channelCode,
        countryRule: _rule,
        countryCodes: _codes,
        payToFields,
        ...method
      }) => {
        const channel = this.providers.findChannel({ providerCode, channelCode }, 'payout');
        const destination = channel?.destination;
        return {
          ...method,
          destinationKind: destination?.kind ?? 'text',
          destinationNetwork: destination?.network ?? null,
          // The wallet currencies it pays out, or null for any (0173).
          currencies: !channel || channel.currencies === 'any' ? null : [...channel.currencies],
          // What it tells the client (0202): shown details, on every payout route.
          payToFields: shownPayToFields(payToFields, true),
        };
      },
    );
  }

  /**
   * Is a payout method one a client can use right now (0173)? Its network must
   * be switched on for payouts, and an AUTOMATED one whose provider cannot pay
   * must be one the desk may pay by hand instead (`whenUnavailable: 'desk'` —
   * Rival). A `wait` provider (3pay) switched off takes no new requests.
   */
  private async payoutMethodOffered(
    route: PaymentRoute,
    off?: Awaited<ReturnType<typeof readOffSwitches>>,
  ): Promise<boolean> {
    if ((off ?? (await readOffSwitches(this.db))).has(channelSwitchKey(route, 'payout')))
      return false;
    const found = this.providers.payoutRail(route);
    if (!found || found.rail.whenUnavailable === 'desk') return true;
    return found.adapter.isUsable();
  }

  async requestWithdrawal(params: {
    userId: number;
    amount: string;
    currency: Currency;
    destination: string;
    /**
     * A `withdrawal_payment_methods.key` — the rail the client chose.
     *
     * This replaced a `provider` string the client sent from a closed union
     * (`'whish' | 'usdt'`). The rails are DATA now (migration 0062), so the set
     * a client may choose from is a table the desk controls rather than a union
     * a deploy controls, and the check below is against what is actually
     * enabled rather than against what the code was compiled knowing about.
     */
    methodKey: string;
  }) {
    const { currency, decimals, amount } = await this.withinCurrencyLimits(params);
    const method = await this.offeredMethodFor(params.userId, params.methodKey);
    const { payoutRoute, payoutChannel } = await this.payableRoute(
      method,
      amount,
      currency,
      decimals,
    );
    const destination = this.payoutDestination(params.destination, payoutChannel);
    await this.assertVerified(params.userId);

    return this.postWithdrawal(
      params.userId,
      currency,
      amount,
      method,
      payoutRoute,
      destination,
    ).then((row) => {
      /*
       * Ring the reviewers' bells AFTER the request has committed, never
       * inside it: resolving who can act on it (the catalogue's permissions,
       * each admin's scope) is several reads, and a money transaction does not
       * stay open for a courtesy (§6.2 keeps that transaction to lock →
       * compute → insert → update). The port never throws, and the polled
       * queue badge remains the durable signal — this row is the per-item task
       * with a deep link on top. Approving or rejecting it resolves it for
       * every reviewer at once (the `transactions` trigger, migration 0140).
       */
      void this.notifications.notifyAdmins({
        kind: 'admin.withdrawal.requested',
        params: { transactionId: row.id, amount: row.amount, currency: row.currency },
        dedupeKey: `admin.withdrawal.requested:${row.id}`,
        subject: { id: row.id, clientId: row.userId },
      });
      return row;
    });
  }

  /** The currency is usable and the amount is inside its per-request range. */
  private async withinCurrencyLimits(params: { amount: string; currency: Currency }) {
    /*
     * The CURRENCY, checked against the catalogue rather than against a list in
     * a DTO.
     *
     * `@IsIn(['USD','USDT'])` used to do this at the edge, which refused a
     * withdrawal in any currency an operator had added since — EUR, GBP, AED and
     * TRY were all enabled and all unspendable. Currencies stopped being a
     * `pgEnum` for exactly that reason; the DTO was the last copy of the old
     * closed set.
     *
     * `assertUsable` is the stronger check the edge could not make: it refuses
     * an unknown code AND a DISABLED one, against what is actually on offer.
     * The `wallets_currency_currencies_code_fk` foreign key catches an unknown
     * code again below if a caller ever skips this — but a foreign key cannot
     * tell "disabled" from "available", which is why this runs first.
     */
    // The NORMALISED code is what the rest of this method uses: `assertUsable`
    // upper-cases and trims, so 'usd' and 'USD' cannot become two currencies on
    // the rows this writes.
    const {
      code: currency,
      decimals,
      limits,
    } = await this.currencies.assertUsableDetail(params.currency);

    const amount = toDecimal(params.amount);
    /*
     * `lessThanOrEqualTo(0)`, NOT `!isPositive()`.
     *
     * decimal.js reads the SIGN, and it gives ZERO a sign of 1 — so
     * `!amount.isPositive()` is FALSE for "0" and "0.00000000", and this guard
     * never fired for the one input it most obviously exists to reject. The
     * request then ran on to the ledger, which refused it with
     * "A ledger entry must move a non-zero amount" — a sentence naming a table
     * the client has never heard of, instead of the amount they typed.
     */
    if (amount.lessThanOrEqualTo(0))
      throw new ValidationError('Withdrawal amount must be positive.');

    /*
     * Absolute bounds — PLATFORM-CONVENTIONS R-5.1 — in THIS CURRENCY's units.
     *
     * Balance and KYC level were already checked below, and they are the RIGHT
     * checks. What was missing is a ceiling that holds when something upstream
     * is wrong: a mispriced wallet, a bad rate, a compromised session draining
     * an account in one move.
     *
     * The currency's own limits since 0162. They were one config number for
     * every currency, so a client could not withdraw more than 50,000 LBP —
     * about fifty cents — while the same number was a large USD withdrawal.
     */
    const min = toDecimal(limits.minWithdrawal);
    const max = toDecimal(limits.maxWithdrawal);
    if (amount.lessThan(min)) {
      throw new ValidationError(`The minimum withdrawal is ${formatLimit(min)} ${currency}.`);
    }
    if (amount.greaterThan(max)) {
      throw new ValidationError(
        `The maximum single withdrawal is ${formatLimit(max)} ${currency}. ` +
          'Please split the request or contact support.',
      );
    }
    return { currency, decimals, amount };
  }

  /** The method exists, is enabled, and the client's country may use it. */
  private async offeredMethodFor(userId: number, methodKey: string) {
    /*
     * The rail must exist and be ENABLED, read live rather than trusted.
     *
     * The client sends a key; this is the only thing standing between that key
     * and a payout instruction, so a disabled rail is refused here rather than
     * merely hidden from the picker. Hiding it in the portal is presentation;
     * this is the rule (R-4.3 — every precondition checked in the service, so a
     * future admin tool or job satisfies the same one).
     */
    const [method] = await this.db
      .select()
      .from(withdrawalPaymentMethods)
      .where(eq(withdrawalPaymentMethods.key, methodKey))
      .limit(1);
    if (!method || !method.enabled) {
      throw new ValidationError('That withdrawal method is not available.');
    }
    // A refusal below that names the method names it in Arabic for an Arabic reader.
    registerLabelTwins([[method.name, method.nameAr]]);
    const [withdrawer] = await this.db
      .select({ country: users.country })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!countryEligible(method, withdrawer?.country ?? null)) {
      throw new ValidationError(COUNTRY_REFUSAL);
    }
    return method;
  }

  /** The method's payout rail is on and can pay this amount in this currency. */
  private async payableRoute(
    method: WithdrawalMethodRow,
    amount: Decimal,
    currency: string,
    decimals: number,
  ) {
    /*
     * The amount must be one this withdrawal can actually PAY — D-77.
     *
     * Two scales bound a payout and only one of them used to be checked:
     *
     *   currencies.decimals   what the OPERATOR says the currency holds.
     *                         Editable from 0 to 8 on the admin screen.
     *   gateways.payoutScale  what the PROVIDER can send exactly.
     *                         Rival settles at 2 (RIVAL_MONEY_SCALE).
     *
     * Checking only the first closed this for USD — which declares 2 — and left
     * it wide open the moment anybody configured a currency to more places than
     * Rival supports: the CRM would accept 100.12345678, debit all of it, and
     * Rival would be asked for 100.12, keeping the difference exactly as before.
     * The fix would have LOOKED applied while doing nothing, which is worse than
     * not having it.
     *
     * So the bound is the SMALLER of the two. A desk-paid withdrawal has no rail
     * and is bounded by the currency alone — a human settling it can send
     * whatever the currency expresses.
     *
     * `quantiseOut` refuses rather than rounds, so a value that somehow reaches
     * Rival with too many places is a loud, recoverable failure instead of
     * silent dust. This check is what stops the client meeting that refusal at
     * approval time, hours after they asked.
     */
    /*
     * The method's payout channel answers for the rail (0168): the decimals its
     * provider settles in, and what a destination must look like. Nothing here
     * names a provider — Whish's phone rule is Rival's channel's own validator.
     */
    const payoutRoute: PaymentRoute = {
      providerCode: method.providerCode,
      channelCode: method.channelCode,
    };
    const payoutChannel = this.providers.channel(payoutRoute, 'payout');
    /*
     * CAN IT BE PAID AT ALL right now (0173)? Refused at the door, with the
     * same sentence the picker's absence implies — never accepted into a queue
     * nobody can pay:
     *   - its network is switched off in this direction (an admin's switch);
     *   - it is an automated payout whose provider cannot pay and does not let
     *     the desk pay by hand instead (`whenUnavailable: 'wait'` — 3pay).
     * And the WALLET currency must be one the channel serves: a USD-only
     * payout channel (3pay, USDT at par) never pays out a EUR wallet — this was
     * not checked at all before 0173.
     */
    if (!(await this.payoutMethodOffered(method))) {
      throw new ValidationError('That withdrawal method is not available.');
    }
    if (payoutChannel.currencies !== 'any' && !payoutChannel.currencies.includes(currency)) {
      throw new ValidationError(
        `${method.name} pays out ${payoutChannel.currencies.join(', ')} only — choose a ` +
          `${payoutChannel.currencies.join(' or ')} wallet or another method.`,
      );
    }
    // The provider's own floor on this channel (0175) — 3pay pays at least 1.
    if (
      payoutChannel.minimumAmount !== undefined &&
      amount.lessThan(toDecimal(payoutChannel.minimumAmount))
    ) {
      throw new ValidationError(
        `${method.name} pays out at least ${formatLimit(toDecimal(payoutChannel.minimumAmount))} ` +
          `${currency}.`,
      );
    }
    const railScale = payoutChannel.settlementScale;
    const payableDecimals = railScale === null ? decimals : Math.min(decimals, railScale);
    if (amount.decimalPlaces() > payableDecimals) {
      /*
       * The message names the largest amount that WOULD be accepted, rounded
       * DOWN so it is never more than the client has.
       *
       * A client's balance can legitimately carry sub-cent value — commission
       * and rebates are percentages stored at the full NUMERIC(28,8) scale — so
       * "withdraw everything" can produce an amount this rule refuses. Without
       * the figure the refusal is a dead end on the one action the client most
       * wants; with it, it is an instruction they can act on immediately.
       */
      throw new ValidationError(
        `${method.name} settles ${currency} to ${payableDecimals} decimal ` +
          `${payableDecimals === 1 ? 'place' : 'places'}. The most you can withdraw from this ` +
          `request is ` +
          `${amount.toDecimalPlaces(payableDecimals, Decimal.ROUND_DOWN).toFixed(payableDecimals)} ` +
          `${currency}.`,
      );
    }
    return { payoutRoute, payoutChannel };
  }

  /** Where the money goes, as the rail's destination kind requires it. */
  private payoutDestination(
    raw: string,
    payoutChannel: ReturnType<PaymentProviderRegistry['channel']>,
  ): string {
    /*
     * A whish withdrawal's destination is a phone number Rival will pay over
     * Whish-to-Whish, validated NOW with Rival's own rules (wish-phone.ts):
     * refusing at request time bounces the typo on the client in the moment
     * they can fix it, instead of days later as a failed submission on an
     * approval the admin cannot explain.
     */
    // What the channel needs from the client (0168): a cash pickup needs
    // nothing; every other payout needs somewhere to send the money.
    const destination = raw.trim();
    const destinationKind = payoutChannel.destination?.kind ?? 'text';
    if (destinationKind !== 'none' && destination === '') {
      throw new ValidationError('Enter where the money should be sent.');
    }
    const destinationIssue =
      destination === '' ? undefined : payoutChannel.destination?.validate?.(destination);
    if (destinationIssue) throw new ValidationError(destinationIssue);
    return destination;
  }

  /** Withdrawals need KYC level 1. */
  private async assertVerified(userId: number): Promise<void> {
    const [user] = await this.db.select().from(users).where(eq(users.id, userId)).limit(1);
    if (!user) throw new NotFoundError('User not found.');
    // §8.4: funded features are gated on KYC level 1 (FR-CORE-15).
    if (user.verificationLevel < 1) {
      throw new AuthorizationError('Withdrawals require a verified account (KYC level 1).');
    }
  }

  /** One transaction: the pending row, then the debit that references it. */
  private postWithdrawal(
    userId: number,
    currency: string,
    amount: Decimal,
    method: WithdrawalMethodRow,
    payoutRoute: PaymentRoute,
    destination: string,
  ) {
    /*
     * DEBIT ON REQUEST, not a hold. Changed from the version this restores.
     *
     * The old flow reserved the funds (`on_hold`) and posted the debit only at
     * settlement. That kept the balance looking untouched while a withdrawal
     * was pending, which is the problem: a client could request two withdrawals
     * each within their balance but not within it together, be told both were
     * submitted, and have the second refused at approval time by an admin
     * looking at a number the client never saw.
     *
     * Debiting now means the balance always reflects committed funds. The
     * refusal path writes a COMPENSATING CREDIT (§6.4) rather than editing
     * anything — see `reject` and `markFailed` below.
     *
     * The row is inserted BEFORE the ledger post because the post needs the
     * transaction id as its reference, and that id is what makes the debit
     * idempotent. Both are in one transaction, so a failure at either step
     * leaves neither — the previous ordering bug this comment replaces was the
     * mirror of that: a hold committed before a failed INSERT left funds
     * reserved against a withdrawal that did not exist, invisible and
     * unreleasable.
     */
    // What the rail tells the client (0202), recorded with the request.
    const shownToClient = payToSnapshot(method.payToFields, true);
    return this.db.transaction(async (dbTx) => {
      const wallet = await this.wallets.getOrCreateWallet(userId, currency, 'main', dbTx);
      const [row] = await dbTx
        .insert(transactions)
        .values({
          userId: userId,
          walletId: wallet.id,
          direction: 'withdrawal',
          amount: money(amount),
          currency: currency,
          state: 'pending',
          /*
           * `provider` carries the method key, and the new
           * `withdrawalMethodKey` carries it again as a real foreign key.
           *
           * That is not redundancy worth removing. `provider` is half of
           * `UNIQUE(provider, provider_ref)` — the §6.3 idempotency guarantee
           * for replayed payment callbacks — so it has to stay populated and
           * has to keep meaning "which rail" to the reconciler. The foreign
           * key is what makes the rail a referenced row rather than a string,
           * which is what lets the admin list join its display name and what
           * stops a method with history being deleted.
           */
          provider: method.key,
          withdrawalMethodKey: method.key,
          // The route it is filed on, recorded once (0168).
          providerCode: payoutRoute.providerCode,
          channelCode: payoutRoute.channelCode,
          providerEnvironment: await this.records.environmentOf(payoutRoute.providerCode, dbTx),
          destination: destination === '' ? null : destination,
          // What the rail told the client, as it read NOW; immutable from here (0199 trigger).
          payToDetails: shownToClient.length > 0 ? shownToClient : null,
        })
        .returning();

      /*
       * `post` locks the wallet and refuses an overdraft, so this is also the
       * balance check — and it is the only one that cannot be raced. A check
       * before the insert would be a read-then-write, and two withdrawals
       * submitted together would both pass it.
       */
      await this.wallets.post(
        {
          userId: userId,
          currency: currency,
          amount: amount.negated(),
          entryType: 'withdrawal',
          referenceType: LEDGER_REFERENCE.transaction,
          referenceId: row.id,
        },
        dbTx,
      );

      return row;
    });
  }

  /**
   * Approve a withdrawal. Whether that also PAYS it depends on who pays.
   *
   * ## Two lifecycles, and the rule that picks between them
   *
   * - **A desk payout is one step.** `pending → success`. An operator approving a
   *   withdrawal they are about to send by hand has already done the only other
   *   thing that was ever going to happen, so a separate `settle` click was an
   *   operator confirming to the system what the system had just told them to do.
   *   What that produced in practice was a queue of `approved` rows already paid in
   *   the real world and never marked, and two states a desk reconciled by memory.
   *
   * - **A provider payout is two steps.** `pending → approved → success`. Here
   *   something really does happen in between: the row is submitted to the payout
   *   rail, and the provider's own event is what says the money left. Collapsing
   *   these would mark a withdrawal PAID before anybody had been asked to pay it —
   *   and since the client's balance is debited at request time, nothing would look
   *   wrong until they asked where their money was.
   *
   * The caller states which, because the caller is what knows about payout rails;
   * this service must not. `admin-money.service.ts` asks
   * `RivalWithdrawalsService.willPayOut()`, whose conditions are pinned to the
   * claim that does the submitting.
   *
   * ## Neither step moves money
   *
   * That is the point of debiting on request: the wallet changed when the client
   * asked. Approval authorises, settlement records. `reject` and `markFailed` are
   * the paths that give money back.
   *
   * ## The control that replaced the two-person rule
   *
   * The permission, not the step count. The controller gates this on
   * `withdrawals.settle` rather than `withdrawals.approve`: holding the weaker
   * permission does not let anybody release funds. Segregation of duties is gone;
   * authority over payout is not, and that is recorded as a real reduction.
   *
   * Still the §8.7 conditional transition from `pending`, so a double-clicked
   * button cannot pay twice.
   */
  async approve(
    id: string,
    adminId: string,
    options: ApproveWithdrawalOptions,
    withinTx?: WithinTransaction,
  ) {
    // Wrapped in a transaction it did not previously need, so `withinTx` — the
    // admin audit row — commits with the state change or not at all (R-6.5).
    return this.db.transaction(async (dbTx) => {
      const now = new Date();
      const row = await this.records.transition(
        id,
        'pending',
        options.awaitsProviderPayout
          ? {
              /*
               * AUTHORISED, not paid. `settledAt` stays null because nothing has
               * settled: the payout rail has not been asked yet. Leaving it null is
               * what makes "approved but never submitted" visible to the
               * reconciler rather than indistinguishable from a completed payout.
               */
              state: 'approved',
              reviewedBy: adminId,
              reviewedAt: now,
            }
          : {
              /* Paid by hand. Approval records what the operator has done. */
              state: 'success',
              reviewedBy: adminId,
              reviewedAt: now,
              settledAt: now,
            },
        dbTx,
      );
      if (!row) {
        const current = await this.records.getById(id);
        throw new MoneyRuleError(
          `Only a pending withdrawal can be approved; this one is ${current.state}.`,
        );
      }
      await withinTx?.(dbTx, row);
      return row;
    });
  }

  async reject(
    id: string,
    adminId: string,
    reason: string,
    withinTx?: WithinTransaction,
    /** The reason in Arabic (0179); omitted = the catalogue's Arabic of a system sentence. */
    reasonAr?: string | null,
  ) {
    /*
     * One transaction: the state change and the REFUND commit together, so a
     * failure can never leave a rejected withdrawal with the client's money
     * still debited — which would be permanent, since 'rejected' is terminal.
     */
    return this.db.transaction(async (dbTx) => {
      const row = await this.records.transition(
        id,
        'pending',
        {
          state: 'rejected',
          rejectionReason: reason,
          rejectionReasonAr: reasonAr === undefined ? systemSentenceArabic(reason) : reasonAr,
          reviewedBy: adminId,
          reviewedAt: new Date(),
        },
        dbTx,
      );
      if (!row) {
        const current = await this.records.getById(id);
        throw new MoneyRuleError(
          `Only a pending withdrawal can be rejected; this one is ${current.state}.`,
        );
      }
      await this.records.refund(row, dbTx);
      await withinTx?.(dbTx, row);
      return row;
    });
  }

  /** Provider confirmed: close the transaction. The debit posted at request. */
  async settle(id: string, adminId: string, providerRef: string, withinTx?: WithinTransaction) {
    /*
     * NO BALANCE CHANGE HERE any more, and that is the whole point of debiting
     * on request: by the time an admin settles, the money left the balance when
     * the client asked for it. Settlement records that the provider paid out.
     *
     * The version this replaces posted the debit and released the hold here, in
     * one transaction with the state change — because three separate commits
     * had left a row marked 'success' with no debit posted, which duplicated
     * money unrecoverably. That failure mode is gone with the step itself.
     */
    return this.db.transaction(async (dbTx) => {
      const row = await this.records.transition(
        id,
        'approved',
        { state: 'success', providerRef, settledAt: new Date(), reviewedBy: adminId },
        dbTx,
      );
      if (!row) {
        const current = await this.records.getById(id);
        throw new MoneyRuleError(
          `Only an approved withdrawal can be settled; this one is ${current.state}.`,
        );
      }

      await withinTx?.(dbTx, row);
      return row;
    });
  }

  /**
   * Provider failed after approval: refund, exactly as a rejection does.
   *
   * Takes an `actor` and an audit hook for the same reason approve/reject/settle
   * do — R-4.3 and R-6.5. This had neither: no actor, no assertion, no audit
   * row, and no callers, which is exactly the shape a provider-callback job will
   * reach for once the Whish and USDT integrations land. A money state change
   * nobody is accountable for is easier to prevent now than to explain later.
   *
   * Background work passes SYSTEM_ACTOR, which is a named principal rather than
   * an implicit bypass — a callback IS the system acting, and the audit row
   * should say so.
   */
  async markFailed(
    id: string,
    reason: string,
    actor: Actor,
    withinTx?: WithinTransaction,
    /** A provider operator's note (0172) — admin-only, never the client's reason. */
    providerNote: string | null = null,
    /** The reason in Arabic (0179); omitted = the catalogue's Arabic of a system sentence. */
    reasonAr?: string | null,
  ) {
    // Failing a withdrawal RETURNS the money to the client, so it belongs with
    // settlement rather than with approval — it is the settle step's error
    // path, and whoever may complete a payout may also unwind one (R-5.4).
    assertActorCan(actor, 'withdrawals.settle', 'mark a withdrawal failed');
    return this.db.transaction(async (dbTx) => {
      const row = await this.records.transition(
        id,
        'approved',
        {
          state: 'failure',
          rejectionReason: reason,
          rejectionReasonAr: reasonAr === undefined ? systemSentenceArabic(reason) : reasonAr,
          providerNote,
          settledAt: new Date(),
        },
        dbTx,
      );
      if (!row) {
        const current = await this.records.getById(id);
        throw new MoneyRuleError(
          `Only an approved withdrawal can be marked failed; this one is ${current.state}.`,
        );
      }
      await this.records.refund(row, dbTx);
      await withinTx?.(dbTx, row);
      return row;
    });
  }
}
