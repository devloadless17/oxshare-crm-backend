import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db } from '../../database/db';
import { clientScopePredicate } from '../../common/security/client-scope';
import { TransferExecutor } from '../payments/transfer-executor.service';
import { RejectionReasonsStore } from '../../store/rejection-reasons.store';
import { composeReasonArabic } from '../../common/i18n/reason-arabic';
import {
  NOTIFICATION_DISPATCH,
  type NotificationDispatchPort,
} from '../../common/provisioning/notification-dispatch.port';
import {
  ADMIN_TRANSACTION_SORT_COLUMNS,
  DEFAULT_ADMIN_TRANSACTION_SORT,
  DEFAULT_WITHDRAWAL_SORT,
  MANUAL_ADMIN_PROVIDER,
  TransactionsService,
  WITHDRAWAL_SORT_COLUMNS,
  type AdminMovementsFilter,
} from '../payments/transactions.service';
import { TransfersService } from '../payments/transfers.service';
import { sortKey, sortOrder } from '../../common/sorting';
import { maskedFieldsFor } from '../../common/security/field-mask';
import { WalletService } from '../wallet/wallet.service';
import { AdminsStore } from '../../store/admins.store';
import { UsersStore } from '../../store/users.store';
import { EmailService } from '../email/email.service';
import { MoneyRuleError, NotFoundError, ValidationError } from '../../common/errors/domain-errors';
import { AdminAuditService } from './admin-audit.service';
import { assertActorCan } from '../../common/security/actor';
import { decodeCursor } from '../../common/pagination';
import { enumQuery } from '../../common/query-params';
import { ledgerEntryTypeEnum, tradingAccounts } from '../../database/schema';
import { ClientVisibilityService } from '../../common/security/client-visibility.service';
import { CurrenciesService } from '../currencies/currencies.service';
import { PayoutEngine } from '../payments/core/payout-engine.service';
import { HostedDepositsService } from '../payments/core/hosted-deposits.service';
import { ChannelSwitchesService } from '../payments/core/channel-switches.service';
import { DEPOSIT_PROOF_BUCKET } from '../../common/uploads/stored-files.service';
import { storedPath } from '../../common/uploads/storage/storage-key';
import { DepositDecisionDto } from './dto/responses.dto';
import type { ClientScope } from '../../common/security/client-scope';
import type { AuthenticatedAdmin } from './guards/admin.guard';

/**
 * The money desk: withdrawal review (§8.4) and the append-only ledger view
 * (ADM-13).
 *
 * Every method here either moves money or decides that money may move, which is
 * exactly why it should not have shared a 726-line file with cookie handling
 * and the KYC step configurator.
 *
 * Commission plans used to live here too and went with the engine — see the
 * note at the foot of the class.
 */
/**
 * A withdrawal row as the console reads it, with the deposit-only columns off.
 *
 * ## The leak this closes
 *
 * `TransactionsService.transition` ends in a bare `.returning()` — every column
 * of `transactions` — and each handler below spreads that whole row into its
 * response. So a column added to the table for ONE flow silently joins the
 * OTHER flow's public contract. `proof_filename` went on for offline deposits
 * and immediately started riding out on every withdrawal approval, rejection,
 * settlement, cancellation and Rival resubmission, as a field that is null by
 * construction.
 *
 * `test/response-completeness.spec.ts` is what caught it, on the reasoning that
 * matters most here: the response interceptor CANNOT MASK WHAT THE SHAPE DOES
 * NOT MENTION. An undeclared key is not merely undocumented — it is outside the
 * machinery that decides what a scoped reviewer is allowed to see.
 *
 * ## Why strip rather than declare
 *
 * Declaring `proofFilename` on `WithdrawalRowDto` would also have made the gate
 * pass, and it would have been a lie: a withdrawal has no receipt. It would
 * publish a permanently-null field into both frontends' generated types, where
 * it reads as something a screen could reasonably try to render.
 *
 * Destructured by NAME rather than deleted from a copy, so the next deposit-only
 * column is an edit here rather than a silent leak.
 */
function withdrawalResponse<T extends { proofFilename?: unknown; proofDetails?: unknown }>(
  row: T,
  actor: AuthenticatedAdmin,
) {
  // Both are an offline DEPOSIT's evidence: its receipt, and the details that
  // identify the payment (0163). A withdrawal carries neither.
  const {
    proofFilename: _proofIsDepositOnly,
    proofDetails: _detailsAreDepositOnly,
    /*
     * The payments core's columns a withdrawal response does not carry (0173):
     * a hosted deposit's page, expiry, received and asked amounts, and the
     * core's own bookkeeping (the fingerprint, when it last asked).
     */
    providerPaymentUrl: _pageIsDepositOnly,
    providerPaymentExpiresAt: _expiryIsDepositOnly,
    providerAmountReceived: _receivedIsDepositOnly,
    requestedAmount: _askedIsDepositOnly,
    payoutFingerprint: _fingerprintIsTheCores,
    providerCheckedAt: _checkedAtIsTheCores,
    ...withdrawalFields
  } = row as T & Record<string, unknown>;
  return {
    ...withdrawalFields,
    maskedFields: maskedFieldsFor('withdrawal', actor.fieldMask),
  };
}

@Injectable()
export class AdminMoneyService {
  private readonly logger = new Logger(AdminMoneyService.name);

  constructor(
    private readonly transactions: TransactionsService,
    /*
     * For `abandonTransfer` alone — the one admin action that touches a
     * wallet-to-account movement. Everything else about transfers belongs to
     * the client's own path or to the resume job.
     */
    private readonly transfers: TransfersService,
    private readonly wallets: WalletService,
    private readonly rejectionReasons: RejectionReasonsStore,
    private readonly users: UsersStore,
    private readonly email: EmailService,
    private readonly audit: AdminAuditService,
    private readonly visibility: ClientVisibilityService,
    /*
     * Decides whether a currency code is one this platform actually holds.
     * APPENDED LAST — this class is constructed positionally in the unit suites,
     * so inserting a parameter in the middle silently shifts every one after it.
     */
    private readonly currencies: CurrenciesService,
    /** Bell rows for the client. Same append-last rule as `currencies` above. */
    @Inject(NOTIFICATION_DISPATCH) private readonly notifications: NotificationDispatchPort,
    /**
     * The payments core's payout engine (0173) — every automated payout, every
     * provider. In the slot Rival's own payout service held, so positional
     * construction keeps its shape.
     */
    private readonly payouts: PayoutEngine,
    /** Reviewer names for the desk. Same append-last rule as above. */
    private readonly admins: AdminsStore,
    /*
     * The MT5 leg of `fundTradingAccount`. The SAME executor the client's own
     * transfer endpoint uses, so the ordering (MT5 first, ledger second) and the
     * idempotency key (the transfer id) are shared rather than reimplemented.
     * Appended LAST — the positional-construction rule above.
     */
    private readonly transferExecutor: TransferExecutor,
    /*
     * For `fundTradingAccount` alone, which must read the target account's
     * OWNER and CURRENCY before it can credit the matching wallet. Appended
     * LAST for the same reason as every parameter above it.
     */
    @Inject(DRIZZLE_DB) private readonly db: Db,
    /*
     * The core's hosted-deposit engine (0173): the desk's two ways to finish a
     * deposit only a person can settle. Appended LAST — the positional rule.
     */
    private readonly hostedDeposits: HostedDepositsService,
    /* Which networks are switched off — read once per desk page (0173). LAST. */
    private readonly channelSwitches: ChannelSwitchesService,
  ) {}

  /**
   * Put money into a client's wallet, by hand.
   *
   * ## ⚠️ THIS IS THE ONLY WAY MONEY CAN ARRIVE WITHOUT A PROVIDER
   *
   * It exists because there was no way at all. A client could file a manual
   * deposit and it sat `pending` for ever: the admin surface had approve, reject
   * and settle for WITHDRAWALS and nothing whatsoever for deposits, and
   * `creditDeposit` had no route in front of it. Money could leave the platform
   * and could not enter it — an end-to-end run left four deposits stranded.
   *
   * ## It writes a DEPOSIT row, not a silent adjustment
   *
   * `direction: 'deposit'`, `state: 'success'`, so it appears in the client's
   * own history beside every other way money has arrived. An operator crediting
   * an account and the client seeing nothing on their statement is the failure
   * this closes, not one to repeat.
   *
   * `provider` is `manual_admin`, which is how both frontends tell it from a
   * deposit that went through a payment method. There is no `methodKey`, because
   * no method was used.
   *
   * ## `reason` is REQUIRED
   *
   * An unexplained credit is an unauditable one. "Why is there an extra $500 on
   * this account" has to be answerable six months later from the row itself
   * rather than from whoever remembers. It goes on the audit entry and into the
   * client's email.
   *
   * ## Idempotency is the caller's key, all the way down
   *
   * `reference` is the request's own `Idempotency-Key` and becomes
   * `provider_ref`, which `UNIQUE(provider, provider_ref)` enforces. A
   * double-submitted form therefore converges on ONE credit in the database
   * rather than relying on the HTTP interceptor alone.
   */
  async creditWallet(
    params: {
      userId: number;
      amount: string;
      currency: string;
      reason: string;
      /** The reason in Arabic, for a client reading in Arabic (0179). Optional. */
      reasonAr?: string | null;
    },
    reference: string,
    actor: AuthenticatedAdmin,
  ) {
    /*
     * Its OWN permission, not `withdrawals.approve` or a general payments key.
     *
     * This mints balance from nothing — the most sensitive money action the
     * console can perform — and this codebase already treats separation of
     * duties as a real control: `withdrawals.settle` was split from
     * `withdrawals.approve` precisely so one person cannot both authorise and
     * release a payout. Reusing an existing key here would silently hand this
     * capability to everyone who already holds that one.
     */
    assertActorCan(actor, 'wallets.credit', 'credit a client wallet');

    const reasonText = params.reason.trim();
    if (!reasonText) {
      throw new ValidationError('A reason is required when crediting a wallet by hand.');
    }
    const reasonAr = composeReasonArabic({ note: reasonText, noteAr: params.reasonAr });

    /*
     * SCOPE FIRST, so an admin restricted to a subset of clients cannot credit
     * somebody outside it. `assertVisible` throws the same not-found a stranger
     * would get, rather than confirming the account exists.
     */
    await this.visibility.assertVisible(params.userId, actor.clientScope);
    const user = await this.users.findById(params.userId);
    if (!user) throw new NotFoundError('Client not found.');

    const result = await this.transactions.creditDeposit({
      userId: params.userId,
      amount: params.amount,
      currency: params.currency,
      provider: MANUAL_ADMIN_PROVIDER,
      providerRef: reference,
    });

    /*
     * A REPLAY writes no audit row and sends no second email. The credit did not
     * happen twice, so logging it twice would put two entries against one
     * movement, and mailing again would tell the client they had been paid
     * twice.
     */
    if (result.replayed) return { transaction: result.transaction, replayed: true as const };

    /*
     * Audited AFTER the credit rather than inside it — a departure from the
     * withdrawal transitions below, stated so it is not read as an oversight.
     *
     * R-6.5 wants the audit row committed with the movement, and `reject()`
     * manages that by taking a `WithinTransaction` callback. `creditDeposit`
     * offers no such seam: it is deliberately two idempotent steps (the
     * transaction row on `UNIQUE(provider, provider_ref)`, the ledger entry on
     * `(wallet, reference)`) so a retry converges instead of rolling back.
     *
     * The trade is that a crash between the credit and this line loses the
     * ATTRIBUTION, not the money — and that is recoverable, because the
     * transaction row still carries the reference, the amount and the timestamp.
     * Wrapping a deliberately-retryable credit in a transaction to satisfy the
     * audit would trade a recoverable gap for an unrecoverable one.
     */
    this.audit.record(actor.id, 'wallet.credit', 'transaction', result.transaction.id, {
      userId: params.userId,
      amount: result.transaction.amount,
      currency: result.transaction.currency,
      reason: reasonText,
      reasonAr,
    });

    /*
     * Fire-and-forget, AFTER the money has landed — the rule every other
     * decision mail here follows. A mail server being briefly down must not roll
     * back a credit that has already posted.
     */
    void this.email.sendWalletCreditEmail(
      user.email,
      user.firstName,
      result.transaction.amount,
      result.transaction.currency,
      reasonText,
      user.locale,
      reasonAr,
    );

    // Post-commit for the same reason as the email, and skipped on replay for
    // the same reason too. The dedupe key makes even a racing double-submit
    // converge on one bell row.
    void this.notifications.notify({
      recipient: { kind: 'client', id: params.userId },
      kind: 'wallet.credited',
      params: {
        transactionId: result.transaction.id,
        amount: result.transaction.amount,
        currency: result.transaction.currency,
        reason: reasonText,
        // The operator's own Arabic for it (0179) — the bell shows it to an Arabic reader.
        ...(reasonAr ? { reasonAr } : {}),
      },
      dedupeKey: `wallet.credited:${result.transaction.id}`,
    });

    return { transaction: result.transaction, replayed: false as const };
  }

  /**
   * Put money onto a client's TRADING ACCOUNT by hand.
   *
   * ## Two movements, because two movements is what happens
   *
   * Money cannot appear on a trading account from nowhere: this platform's
   * ledger is the wallet, and MT5 is funded FROM it. So this is a wallet credit
   * followed by a real transfer, and the client's history shows both rows — a
   * DEPOSIT into the wallet and a TRANSFER out of it.
   *
   * This is the same composition `TransactionsService.chainTransferToAccount`
   * already performs for a client deposit routed at an account, and it is
   * deliberately reused rather than re-derived. The alternative that was
   * rejected: one row implying money went somewhere it never was, against a
   * wallet the ledger says was never involved.
   *
   * ## ⚠️ THIS REPLACED the MT5 dealer adjustment, which is gone
   *
   * `Mt5AccountsService.adjustBalance` moved the MT5 balance with no wallet leg
   * and no ledger entry, and for a while the console offered both. That was the
   * wrong shape for an operator: two menu items that both move money on the
   * same account, differing only in whether anything is written down. The
   * unrecorded one was picked by mistake, and the money it moved could not be
   * explained afterwards by anybody reading the ledger.
   *
   * So there is now ONE control and it always records. A bonus or a goodwill
   * credit arrives as a real deposit on the client's statement, which is the
   * more honest answer anyway: the client can see money they were given.
   *
   * ## BOTH DIRECTIONS, and they are NOT mirror images
   *
   * `deposit` credits the wallet and transfers to the account. `withdraw`
   * transfers off the account and the wallet keeps the money. The ORDER differs
   * because the risk differs — see the two legs below. Sharing one method is
   * deliberate: the direction is one field, and two near-identical methods is
   * how the sign ends up wrong in one of them.
   *
   * ## BOTH permissions, not either
   *
   * `wallets.credit` because step one mints balance from nothing — the most
   * sensitive money action here, split out so it cannot be reached through any
   * other key. `trading.deposit` because step two puts it on a live trading
   * account. An operator holding one but not the other can do neither half of
   * this, which is the point: the capability is the composition, and it is
   * strictly more than either key grants alone.
   *
   * ## The client's own transfer preconditions are ENFORCED, not bypassed
   *
   * `TransfersService.request` refuses an unverified client, a demo account, a
   * suspended account and a currency mismatch. None of those are relaxed for an
   * operator, and the KYC gate is the one worth being explicit about: a client
   * who is not verified to level 1 should not have a funded live account at all,
   * so an admin route around that check would manufacture exactly the account
   * state the gate exists to prevent.
   *
   * The refusals therefore arrive BEFORE any money moves — see the ordering note
   * on the pre-flight below, which is what makes that true.
   */
  async fundTradingAccount(
    params: {
      tradingAccountId: string;
      amount: string;
      reason: string;
      /** The reason in Arabic (0179) — it reaches the client's credit mail and bell. */
      reasonAr?: string | null;
      direction: 'deposit' | 'withdraw';
    },
    reference: string,
    actor: AuthenticatedAdmin,
  ) {
    const isDeposit = params.direction === 'deposit';

    /*
     * The permission follows the DIRECTION, and only a deposit needs
     * `wallets.credit`.
     *
     * A deposit mints balance into a wallet before moving it, so it needs the
     * key that governs minting AND the one that governs putting money on an
     * account. A withdrawal mints nothing — it moves money the client already
     * has off their account — so requiring `wallets.credit` for it would mean
     * granting the power to create money in order to take some away.
     */
    if (isDeposit) {
      assertActorCan(actor, 'wallets.credit', 'credit a client wallet');
      assertActorCan(actor, 'trading.deposit', 'fund a client trading account');
    } else {
      assertActorCan(actor, 'trading.withdraw', 'debit a client trading account');
    }

    const reasonText = params.reason.trim();
    if (!reasonText) {
      throw new ValidationError(
        `A reason is required when ${isDeposit ? 'funding' : 'debiting'} a trading account by hand.`,
      );
    }

    /*
     * SCOPE JOINS THE WHERE, so a scoped admin cannot fund an account whose
     * client is outside their territory — and an out-of-scope account answers
     * not-found rather than forbidden (D-45), so this cannot enumerate accounts
     * belonging to clients the actor cannot see.
     *
     * The OWNER and CURRENCY come from this row and are not accepted from the
     * caller. See `FundTradingAccountDto` on why taking either would let them
     * disagree with the account.
     */
    const [found] = await this.db
      .select({
        id: tradingAccounts.id,
        userId: tradingAccounts.userId,
        currency: tradingAccounts.currency,
        login: tradingAccounts.login,
        environment: tradingAccounts.environment,
        status: tradingAccounts.status,
      })
      .from(tradingAccounts)
      .where(
        and(
          eq(tradingAccounts.id, params.tradingAccountId),
          clientScopePredicate(actor.clientScope, tradingAccounts.userId),
        ),
      )
      .limit(1);

    if (!found) throw new NotFoundError('Trading account not found.');
    /*
     * An account the MT5 sync found with no client (0166) has no wallet for
     * money to come from or go to. Refused before anything moves; the desk
     * assigns it to a client first.
     */
    if (found.userId === null) {
      throw new ValidationError(
        `MT5 account ${found.login ?? ''} is not assigned to a client yet. Assign it first, then fund it.`,
      );
    }
    const account = { ...found, userId: found.userId };

    const user = await this.users.findById(account.userId);
    if (!user) throw new NotFoundError('Client not found.');

    /*
     * ── PRE-FLIGHT, and the ordering here is the whole point ────────────────
     *
     * `transfers.request` is the authority on every one of these rules and runs
     * them again below. They are checked HERE FIRST because the credit commits
     * before the transfer is requested, and it must: the transfer debits the
     * wallet, so the balance has to be durable before anything can take money
     * out of it (the same rule `chainTransferToAccount` records).
     *
     * That ordering means a transfer refused on a precondition would leave the
     * credit standing — money minted into a wallet the operator never intended
     * to fund, needing a compensating entry to undo. For a CLIENT deposit that
     * outcome is acceptable and documented: their money legitimately arrived and
     * sitting in the wallet is safe. Here nothing arrived, so refusing before
     * the credit is strictly better, and these checks are what make the common
     * refusals happen while nothing has moved.
     *
     * They are a pre-flight and NOT the authority — duplicated deliberately, the
     * same shape as the overdraw check in `request`. If the two ever disagree,
     * `request` wins, because it is the one both paths share.
     */
    /*
     * DEMO ACCOUNTS ARE REFUSED IN BOTH DIRECTIONS, and there is no longer any
     * console path that moves their balance.
     *
     * A demo account trades practice money against no wallet and no ledger, so
     * there is nothing to record a movement against — depositing would mean
     * inventing a practice-money wallet that mixes with real balances, and
     * withdrawing would mean taking real money out of a fiction. A client tops
     * up their OWN demo account through `fundOwnDemoAccount`, which is where
     * that behaviour belongs.
     */
    if (account.environment !== 'live') {
      throw new ValidationError(
        'Only live trading accounts hold real money. A demo account trades practice funds ' +
          'against no wallet, so there is nothing to move or record.',
      );
    }
    if (account.status !== 'active') {
      throw new ValidationError(
        `That trading account is ${account.status} and cannot be used to move money.`,
      );
    }
    if (user.verificationLevel < 1) {
      throw new ValidationError(
        'That client is not verified to KYC level 1, so money cannot be moved on their ' +
          'trading account. Verify them first.',
      );
    }

    /*
     * ── WITHDRAW TAKES THE OTHER ORDER, and the asymmetry is the safe one ───
     *
     * A deposit mints into the wallet and then moves it out, so the wallet leg
     * comes first (below). A withdrawal moves money OFF the account and the
     * wallet is where it lands — `transfers.request` places no hold on the
     * account side and `settle` credits the wallet only after MT5 has confirmed
     * its own debit, so there is exactly one leg here and nothing to unwind.
     *
     * That also means the overdraw check is `transfers.request`'s to make: it
     * refuses an amount larger than the account's mirrored balance less
     * anything already in flight, with a sentence naming the real figure. This
     * method must not second-guess it against the same mirror.
     *
     * Returning early keeps the deposit path below unchanged rather than
     * threading a direction through every leg of it.
     */
    if (!isDeposit) {
      return await this.debitTradingAccount(
        { account, amount: params.amount, reason: reasonText },
        actor,
      );
    }

    /*
     * ── LEG ONE: the deposit ────────────────────────────────────────────────
     *
     * `creditWallet` is called rather than `creditDeposit` directly, so this
     * inherits the whole audited credit path: the reason check, the audit row,
     * the client's email and the bell notification. Re-implementing it to skip
     * the email would mean money arriving in a client's wallet silently, which
     * is the failure `creditWallet` exists to close.
     *
     * The currency is the ACCOUNT's. A wallet in any other currency could not
     * fund it — transfers do not convert.
     *
     * Idempotent on the caller's key all the way to
     * `UNIQUE(provider, provider_ref)`, so a double-submitted form converges on
     * one credit. A REPLAY returns `replayed: true` and sends no second email.
     */
    const credit = await this.creditWallet(
      {
        userId: account.userId,
        amount: params.amount,
        currency: account.currency,
        reason: reasonText,
        reasonAr: params.reasonAr,
      },
      reference,
      actor,
    );

    /*
     * ── LEG TWO: the transfer ───────────────────────────────────────────────
     *
     * AFTER the credit has committed, never inside it — the transfer debits the
     * wallet, and chaining it into the credit's own transaction would take money
     * out of a balance that does not exist yet if the outer commit then failed.
     *
     * A FAILED TRANSFER DOES NOT UNWIND THE CREDIT, and that is deliberate. By
     * this point the money is legitimately in the client's wallet: leaving it
     * there is visible, reconcilable and safe — the operator or the client can
     * transfer it from there. Unwinding a settled deposit to punish a failed
     * onward leg would turn a recoverable state into a lost one, and it is the
     * same call `chainTransferToAccount` makes for the same reason.
     *
     * So the error is reported to the CALLER rather than swallowed: unlike the
     * client-deposit path, an operator is standing in front of this and needs to
     * know the money stopped at the wallet. `transfer` comes back null with
     * `transferError` saying why.
     */
    let transfer: Awaited<ReturnType<TransferExecutor['execute']>> | null = null;
    let transferError: string | null = null;

    try {
      const pending = await this.transfers.request({
        userId: account.userId,
        tradingAccountId: account.id,
        direction: 'wallet_to_account',
        amount: params.amount,
        currency: account.currency,
      });

      /*
       * Executed inline rather than left pending, so the common case finishes
       * while the operator is still looking at the screen. `execute` is
       * idempotent on the transfer id, so a retry cannot move the money twice —
       * and when MT5 is unreachable it leaves the transfer PENDING for the
       * resume scheduler rather than failing it.
       */
      transfer = (await this.transferExecutor.execute(pending.id)) ?? null;

      this.logger.log(
        `Admin ${actor.email} funded trading account ${account.login ?? account.id} with ` +
          `${params.amount} ${account.currency}: credit ${credit.transaction.id}, ` +
          `transfer ${pending.id} (${transfer?.state ?? 'unknown'})`,
      );
    } catch (error) {
      transferError = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Admin ${actor.email} credited ${params.amount} ${account.currency} to client ` +
          `${account.userId} but the onward transfer to trading account ${account.id} could ` +
          `not be made: ${transferError}. The money is in the wallet and can be transferred ` +
          'from there.',
      );
    }

    /*
     * Audited as its own act, on top of the `wallet.credit` entry `creditWallet`
     * already wrote.
     *
     * Two entries for two movements is the correct record here rather than
     * noise: the credit entry explains money appearing in a wallet, and this one
     * explains why it did — an operator funding a specific trading account. A
     * reviewer reading the credit alone would see a bare goodwill payment.
     *
     * Skipped on a REPLAY, the same rule `creditWallet` follows: the funding did
     * not happen twice, so it must not be logged twice.
     */
    if (!credit.replayed) {
      this.audit.record(actor.id, 'trading.deposit', 'trading_account', account.id, {
        userId: account.userId,
        login: account.login,
        amount: credit.transaction.amount,
        currency: account.currency,
        transactionId: credit.transaction.id,
        transferId: transfer?.id ?? null,
        transferState: transfer?.state ?? null,
        transferError,
        reason: reasonText,
        reasonAr: composeReasonArabic({ note: reasonText, noteAr: params.reasonAr }),
      });
    }

    return {
      transaction: credit.transaction,
      replayed: credit.replayed,
      transfer,
      transferError,
    };
  }

  /**
   * Take money OFF a client's trading account, by hand — the withdraw half of
   * `fundTradingAccount`.
   *
   * ## ONE leg, not two, and that is why it is separate
   *
   * A deposit needs a wallet credit before it has anything to transfer. A
   * withdrawal does not: `account_to_wallet` moves the money off MT5 and
   * `TransfersService.settle` credits the wallet as its own second half, inside
   * the same database transaction. So there is one call here and no ordering
   * hazard — nothing is minted, nothing is held, and there is no half-done
   * state where money sits somewhere the operator did not intend.
   *
   * That is the whole reason the two directions do not share a body. Forcing
   * them together would mean a deposit-shaped "credit then transfer" pipeline
   * with the credit skipped by an `if`, which reads as an omission rather than
   * as the correct shape for this direction.
   *
   * ## The money lands in the WALLET, and the copy must say so
   *
   * This is not a payout: no money leaves the platform, and nothing is sent to
   * a bank. It moves from the trading account to the client's wallet, where the
   * client can withdraw it through the normal reviewed path or transfer it
   * back. An operator who reads "withdraw" as "paid out" has told a client the
   * wrong thing, so the caller receives the transfer and names the destination.
   *
   * ## The transfer IS the record
   *
   * It appears in the client's own movement list as a deposit against their
   * wallet — the unified query in `TransactionsService` renders an
   * `account_to_wallet` transfer that way, because that is what it does to the
   * wallet the list is about — and both legs are in the ledger under
   * `entryType: 'transfer'`. No transaction row is written on top of it: a
   * `withdrawal` row would claim money left the platform, which would overstate
   * the withdrawal totals in every report that sums by direction.
   *
   * ## NOT idempotent on the caller's key, and this is stated rather than fixed
   *
   * The deposit direction converges on `UNIQUE(provider, provider_ref)` through
   * the transaction row it writes. There is no such row here, so the protection
   * against a double-click is the executor's idempotency on the transfer id
   * plus the console disabling its button in flight — the same protection the
   * client's own transfer endpoint relies on. Two deliberate debits of the same
   * size are two legitimate operations and must not be collapsed.
   */
  private async debitTradingAccount(
    params: {
      account: { id: string; userId: number; currency: string; login: string | null };
      amount: string;
      reason: string;
    },
    actor: AuthenticatedAdmin,
  ) {
    const { account } = params;

    /*
     * `request` is the authority here and does the work this method must not
     * duplicate: it refuses an overdraw against the account's mirrored balance
     * less anything already in flight, and names the real figure when it does.
     *
     * NOT wrapped in a try/catch that swallows. Unlike the deposit direction —
     * where a refusal after the credit has committed leaves money in a wallet
     * and the operator has to be told rather than shown an error — nothing has
     * moved at this point, so a refusal is simply a refusal and the operator
     * should see it as one.
     */
    const pending = await this.transfers.request({
      userId: account.userId,
      tradingAccountId: account.id,
      direction: 'account_to_wallet',
      amount: params.amount,
      currency: account.currency,
    });

    /*
     * Executed inline so the common case finishes while the operator is still
     * looking at the screen. Idempotent on the transfer id, so a retry cannot
     * move the money twice — and when MT5 is unreachable the transfer is left
     * PENDING for the resume scheduler rather than failed, because the debit may
     * well have landed with only the response lost.
     */
    const transfer = (await this.transferExecutor.execute(pending.id)) ?? null;

    this.audit.record(actor.id, 'trading.withdraw', 'trading_account', account.id, {
      userId: account.userId,
      login: account.login,
      amount: params.amount,
      currency: account.currency,
      transferId: pending.id,
      transferState: transfer?.state ?? null,
      reason: params.reason,
    });

    this.logger.log(
      `Admin ${actor.email} debited ${params.amount} ${account.currency} from trading account ` +
        `${account.login ?? account.id} to the client wallet: transfer ${pending.id} ` +
        `(${transfer?.state ?? 'unknown'})`,
    );

    /*
     * SHAPED LIKE THE DEPOSIT'S RETURN so one caller can render both.
     *
     * `transaction` is null because no transaction row is written — see the note
     * above on why a `withdrawal` row would be a lie. `transferError` is null
     * because a failure in this direction throws rather than returning: there is
     * no half-done state to report.
     */
    return {
      transaction: null,
      replayed: false as const,
      transfer,
      transferError: null,
      /** Where the money went. The console says "wallet", not "paid out". */
      destination: 'wallet' as const,
    };
  }

  /**
   * Open a wallet for a client in a currency they do not hold one in.
   *
   * Registration opens a wallet for every ENABLED currency, so this is for the
   * two cases that leaves behind: a currency the operator added after the client
   * signed up, and one that was disabled when they did.
   *
   * `wallets.create`, NOT `wallets.credit` — this creates an empty container and
   * moves no money, so it does not belong behind the key that mints balance.
   *
   * `getOrCreateWallet` makes it idempotent: opening a wallet that already
   * exists returns the existing one rather than failing, which is the right
   * answer for a button somebody pressed twice.
   */
  async openWallet(params: { userId: number; currency: string }, actor: AuthenticatedAdmin) {
    assertActorCan(actor, 'wallets.create', 'open a client wallet');
    await this.visibility.assertVisible(params.userId, actor.clientScope);

    /*
     * Refuses an unknown or DISABLED currency. Without it an operator could open
     * a wallet the platform does not hold, which nothing downstream can credit —
     * and the foreign key would refuse it anyway, as an opaque driver error.
     */
    const currency = await this.currencies.assertUsable(params.currency);
    const wallet = await this.wallets.getOrCreateWallet(params.userId, currency);

    this.audit.record(actor.id, 'wallet.create', 'wallet', wallet.id, {
      userId: params.userId,
      currency,
    });
    return wallet;
  }

  /**
   * Close an empty, unused wallet.
   *
   * The guards live in `WalletService.deleteEmptyWallet` — a balance, funds on
   * hold, or any ledger/transaction/transfer history each refuse with their own
   * message. What is enforced HERE is who may ask and whether they can see the
   * client, because those are questions about the actor rather than the wallet.
   *
   * Audited BEFORE the delete, deliberately: afterwards the row is gone, and the
   * currency and owner that make the entry meaningful would have to be
   * remembered rather than read. A failed delete leaves an audit row for an
   * attempt, which is the safer of the two errors on a destructive action.
   */
  async closeWallet(id: string, actor: AuthenticatedAdmin) {
    assertActorCan(actor, 'wallets.delete', 'close a client wallet');

    const wallet = await this.wallets.findById(id);
    const walletNotFound = () => new NotFoundError('Wallet not found.');
    if (!wallet) throw walletNotFound();
    await this.visibility.assertVisible(wallet.userId, actor.clientScope, walletNotFound);

    this.audit.record(actor.id, 'wallet.delete', 'wallet', id, {
      userId: wallet.userId,
      currency: wallet.currency,
      balance: wallet.balance,
    });

    await this.wallets.deleteEmptyWallet(id);
  }

  // ─── Withdrawals (ADM-03 · §8.4) ──────────────────────────────────────────
  // Every transition here moves client money, so every one is audited.
  async listWithdrawals(
    query: {
      /** One withdrawal by its uuid (a notification's link) — see `listForAdmin`. */
      id?: string;
      state?: string;
      /** Free text over the client's email and name — see `listForAdmin`. */
      q?: string;
      page?: string;
      limit?: string;
      cursor?: string;
      sort?: string;
      order?: string;
    },
    actor: AuthenticatedAdmin,
  ) {
    assertActorCan(actor, 'withdrawals.view', 'list withdrawal requests');

    /*
     * The sort is validated BEFORE the cursor is decoded, and the order matters.
     *
     * `decodeCursor` refuses a cursor minted under a different ordering and needs
     * the current sort key to say which. Decoding first would produce "this
     * cursor is for createdAt but you asked for undefined" — true and useless.
     */
    const sort = sortKey(
      query.sort,
      WITHDRAWAL_SORT_COLUMNS,
      DEFAULT_WITHDRAWAL_SORT,
      'withdrawals',
    );
    const order = sortOrder(query.order);

    const page = await this.transactions.listForAdmin({
      scope: actor.clientScope,
      id: query.id,
      state: query.state,
      q: query.q,
      page: parseInt(query.page ?? '1', 10) || 1,
      limit: parseInt(query.limit ?? '25', 10) || 25,
      // R-2.4. This is a work queue an admin reads while clients keep
      // submitting — the concurrent-insert case offset paging gets wrong.
      cursor: query.cursor ? decodeCursor(query.cursor, sort) : undefined,
      sort,
      order,
    });

    /*
     * RBAC-03, and the fifth surface to need this line.
     *
     * The desk joins `users.email/firstName/lastName` into a nested `user` so an
     * operator can see whose payout they are approving — which makes it a screen
     * that shows a client without going through the client service, the exact
     * shape of every masking bypass this feature has had. `applyMask` is opt-in
     * per response, so the DEFAULT for a new surface is unmasked and the failure
     * is invisible: the page works perfectly, and only an admin who is supposed
     * to be restricted can tell.
     *
     * `user.id` survives — the row is addressed by it, which is why the catalog
     * marks `client.id` unmaskable. `maskedFields` is not decoration: without it
     * the screen renders an em dash, and "hidden from you" becomes
     * indistinguishable from "this client has no email on file".
     *
     * The `q` filter still searches the masked columns, deliberately. Search is
     * a lookup the operator already has to know the value to perform, and the
     * scope predicate is what decides which rows they may reach; narrowing the
     * search instead would let them binary-search a hidden value out of the
     * result COUNT, which is a worse leak than the one it would close.
     */
    /*
     * WHO decided, as a name rather than a uuid.
     *
     * `reviewedBy` has been recorded on every approval, rejection and
     * settlement since the lifecycle existed, and no screen rendered it — the
     * column holds an id, and an id is not an answer to "who approved this".
     * On a console where `withdrawals.approve` and `withdrawals.settle` were
     * deliberately split so two people can be required, the one screen showing
     * the decision could not name either of them.
     *
     * Resolved here in ONE query over the page's distinct ids rather than in
     * the movements CTE: that query is shared with the client's own
     * transaction list, where the reviewing admin is nobody's business, and it
     * carries two NULL-padded branches a join would have to be threaded
     * through.
     */
    const reviewerNames = await this.admins.namesByIds(
      page.items.map((item) => item.reviewedBy).filter((id): id is string => Boolean(id)),
    );

    /*
     * WHO WILL PAY each open row, and what it costs (0173) — the approval
     * dialog's line ("3pay sends 102.00 USDT: 100.00 to the client, 2.00
     * fee") and the "paused" badge (a network switched off, a provider that
     * waits). The channel switches are read once for the page.
     */
    const offSwitches = await this.channelSwitches.offSwitches();
    const items = await Promise.all(
      page.items.map(async (item) => ({
        ...item,
        reviewedByName: item.reviewedBy ? (reviewerNames.get(item.reviewedBy) ?? null) : null,
        payoutPlan:
          item.state === 'pending' || (item.state === 'approved' && !item.providerSubmittedAt)
            ? await this.payouts.plan({ ...item, direction: 'withdrawal' as const }, offSwitches)
            : null,
      })),
    );

    return {
      ...page,
      items,
      maskedFields: maskedFieldsFor('withdrawal', actor.fieldMask),
    };
  }
  /*
   * Every withdrawal transition below records its audit row INSIDE the
   * transaction that moves the money — R-6.5.
   *
   * `audit.record()` is fire-and-forget, which is right for a role rename and
   * wrong here: the money moves, the row is lost, and "who approved this payout"
   * has only a log line that may have rotated. Now the two commit together, so a
   * failure to record is a failure to act. A withdrawal that fails loudly can be
   * retried; an unrecorded payout cannot be un-made.
   */
  async approveWithdrawal(id: string, actor: AuthenticatedAdmin) {
    /*
     * R-4.3: asserted HERE, not only in the guard. A guard runs on an HTTP
     * request; this method is what a queued job would call.
     *
     * `withdrawals.settle`, matching the controller. Approval now PAYS — it
     * takes the row straight to `success` — so the permission that gates it is
     * the one that has always meant "may complete a payout". Leaving this on
     * `withdrawals.approve` while the route required `settle` would be worse
     * than either choice alone: the guard and the service would disagree, and
     * the service is the half a job runs against.
     */
    assertActorCan(actor, 'withdrawals.settle', 'approve and pay a withdrawal');
    await this.assertWithdrawalVisible(id, actor.clientScope);

    /*
     * WHICH LIFECYCLE this approval follows, decided once, here.
     *
     * A withdrawal the automated rail will pay is approved into `approved` and
     * settled later by Rival's own event. Anything else — a desk payout, or any
     * rail while Rival is switched off — goes straight to `success`, because the
     * operator approving it is the one sending the money.
     *
     * The decision lives beside the claim that does the submitting
     * (`PayoutEngine.decide`) precisely so the two cannot drift: if this said
     * yes and the claim found nothing, the row would sit in `approved` with the
     * client already debited and nobody paying it. A payout NOBODY can pay right
     * now — its channel switched off, or a provider that waits rather than
     * letting the desk pay by hand — is refused here with the reason, never
     * approved into a state that goes nowhere.
     *
     * This replaces a hard refusal that stood here while the two flows were
     * irreconcilable — approving with the rail enabled used to throw, because a
     * one-step approval would have marked the withdrawal PAID without ever sending
     * it for payout.
     */
    const withdrawal = await this.transactions.getById(id);
    const decision = await this.payouts.decide(withdrawal);
    if (decision.kind === 'paused') throw new ValidationError(decision.reason);
    const awaitsProviderPayout = decision.kind === 'provider';

    const row = await this.transactions.approve(
      id,
      actor.id,
      { awaitsProviderPayout },
      async (tx, approved) => {
        await this.audit.recordWithin(tx, actor.id, 'withdrawal.approve', 'transaction', id, {
          amount: approved.amount,
          currency: approved.currency,
          awaitsProviderPayout,
        });
        // In the SAME transaction as the state change (the audit stance): the
        // client is told "approved" only if it actually was.
        await this.notifications.notify(
          {
            recipient: { kind: 'client', id: approved.userId },
            /*
             * The message has to match the state the row is actually in.
             *
             * On the desk path the row is `success`, so "approved" would announce
             * an intermediate state that does not exist and leave the client
             * waiting for a second message that never comes. On the rail path the
             * row really is only authorised, and telling them it was PAID before
             * Rival has sent it is the more expensive of the two mistakes — the
             * `withdrawal.paid` message follows from `settleBySystem` when the
             * money genuinely leaves.
             */
            kind: awaitsProviderPayout ? 'withdrawal.approved' : 'withdrawal.paid',
            params: {
              transactionId: approved.id,
              amount: approved.amount,
              currency: approved.currency,
            },
          },
          tx,
        );
      },
    );
    /*
     * ── ONE EMAIL PER WITHDRAWAL, NAMING THE STATE THE ROW IS ACTUALLY IN ────
     *
     * FR-CORE-08 asks for an email "on success/failure". This sent 'approved'
     * unconditionally, which missed on BOTH paths:
     *
     *  - RAIL path: the client got "your withdrawal is approved" and then "your
     *    withdrawal is paid" about FOUR SECONDS later, because Rival settles
     *    almost immediately. An "it is happening, please wait" message is
     *    worthless when the outcome lands before it has been read, and two mails
     *    that close together read as a duplicate send rather than as two states.
     *
     *  - DESK path: it was simply untrue. `approve` writes `success` and
     *    `settledAt` there — the operator approving IS the one sending the money
     *    — so the row was PAID and the client was told "approved" about funds
     *    that had already left.
     *
     * The bell has always branched correctly (see `notify` above); the mail just
     * never learned the same rule. It does now, and deliberately reads off the
     * SAME `awaitsProviderPayout` value rather than re-deriving one, so the two
     * channels cannot drift into telling a client different things:
     *
     *  - rail → say nothing here. `PayoutEngine` emails 'paid' or
     *    'rejected' when the provider actually answers, and that outcome is the
     *    only one worth a client's attention.
     *  - desk → 'paid', matching both the row's state and the bell.
     *
     * A withdrawal that stalls on the rail is therefore silent until it settles.
     * That is the intended trade: the desk sees it in the queue, and a client
     * who has not been told anything is in a better position than one told
     * "approved" and left to guess whether a second mail is still coming.
     */
    if (!awaitsProviderPayout) void this.emailWithdrawalDecision(row, 'paid');
    /*
     * The provider submission, POST-COMMIT and detached: the approval is a fact
     * the moment its transaction commits, and a provider outage must not turn a
     * successful approval into an error on the admin's screen. `submitApproved`
     * never throws, claims before it creates (no provider's payout API takes an
     * idempotency key), and no-ops for rows the desk pays — a needs-attention
     * flag on the desk is the failure surface.
     */
    if (awaitsProviderPayout) void this.payouts.submitApproved(row.id);
    /*
     * RBAC-03 on the DECISION's own response.
     *
     * The desk list masks; these did not, so a reviewer who cannot see the
     * client's address on the screen got it back in the body of the button they
     * pressed on that same screen. The read was protected and the write handed
     * the value over.
     *
     * Found by cross-checking the route census against the services that
     * actually mask — `WithdrawalRowDto` nests `WithdrawalUserDto`, which
     * carries the email.
     */
    return withdrawalResponse(row, actor);
  }

  /**
   * Cancel an APPROVED withdrawal — "approved, then thought better of it".
   *
   * FR-ADM-03's shape holds even though this is not a rejection: the reason
   * comes from the configurable list (or free text), is recorded, and is
   * emailed — a client whose payout was pulled back after "approved" is owed
   * a sentence more than a status flip.
   *
   * `withdrawals.approve`, not `.settle`: cancelling un-does an approval, so
   * it belongs to the power that made it. The refund path (`markFailed`) is
   * settle-gated internally and SYSTEM-actored there for webhooks — here the
   * ACTING ADMIN is the actor, so their audit row carries their name.
   * `assertActorCan` inside `markFailed` still runs against this actor, which
   * makes the effective requirement approve+settle — acceptable strictness on
   * an action that reverses money already promised.
   *
   * The provider's half is `PayoutEngine.cancelApproved`: never-sent cancels
   * locally; in flight with an unknown outcome is refused; held by a provider
   * that can recall it is recalled FIRST (and refused cleanly when it is
   * already being paid); held by one that cannot (3pay pays at once) is
   * refused — "cancelled here, paid there" is the split-brain this prevents.
   */
  async cancelWithdrawal(
    id: string,
    actor: AuthenticatedAdmin,
    reason?: string,
    reasonId?: string,
    /** The free-text reason in Arabic (0179). */
    reasonAr?: string | null,
  ) {
    assertActorCan(actor, 'withdrawals.approve', 'cancel an approved withdrawal');
    await this.assertWithdrawalVisible(id, actor.clientScope);

    let effectiveReason = reason?.trim();
    let chosen: { label: string; labelAr: string | null } | undefined;
    if (reasonId) {
      const configured = await this.rejectionReasons.findById(reasonId);
      if (!configured) throw new NotFoundError('Rejection reason not found.');
      chosen = configured;
      effectiveReason = effectiveReason
        ? `${configured.label} — ${effectiveReason}`
        : configured.label;
    }
    if (!effectiveReason) {
      throw new ValidationError('A cancellation reason (reasonId or reason text) is required.');
    }
    // Its Arabic, decided now and stored with it (0179).
    const effectiveReasonAr = composeReasonArabic({
      label: chosen?.label,
      labelAr: chosen?.labelAr,
      note: reason,
      noteAr: reasonAr,
    });

    const current = await this.transactions.getById(id);

    /*
     * LOCAL STATE FIRST — and the order here is the whole correctness argument.
     *
     * `markFailed` below is what enforces "only an approved withdrawal can be
     * cancelled", and it used to be the ONLY enforcement. But it runs AFTER the
     * call to Rival, so cancelling a row that is already `success` cancelled the
     * PAYOUT AT RIVAL and only then refused locally: the desk saw a 422 and
     * assumed nothing had happened, the CRM row stayed `success`, the client had
     * already been emailed "paid" — and the money never left Rival.
     *
     * That is precisely the "cancelled there, paid here" split-brain this
     * integration exists to prevent, reached from the opposite direction, and
     * the 422 made it invisible: the failure looks like a refusal.
     *
     * So the cheap local check happens BEFORE the irreversible remote one.
     * `markFailed`'s conditional transition remains the real guard — it is
     * atomic and this is not — but a fail-fast in front of a side effect that
     * cannot be undone is worth having even when a race can still slip past it.
     * The residual window (a webhook settling the row between this read and
     * `markFailed`) leaves Rival cancelled and the CRM `success`, which is the
     * same bad state — but it now needs a collision measured in milliseconds
     * rather than being the guaranteed outcome of an ordinary mis-click.
     */
    if (current.state !== 'approved') {
      throw new MoneyRuleError(
        `Only an approved withdrawal can be cancelled; this one is ${current.state}.`,
      );
    }

    // The provider next: if the payout can no longer be stopped this throws
    // and NOTHING local changes — the desk is told to act on the outcome.
    await this.payouts.cancelApproved(current);

    const row = await this.transactions.markFailed(
      id,
      effectiveReason,
      actor,
      async (tx, failed) => {
        await this.audit.recordWithin(tx, actor.id, 'withdrawal.cancel', 'transaction', id, {
          amount: failed.amount,
          currency: failed.currency,
          reason: effectiveReason,
          reasonAr: effectiveReasonAr,
          provider: current.providerCode,
          providerPayoutId: current.providerPayoutId,
        });
        await this.notifications.notify(
          {
            recipient: { kind: 'client', id: failed.userId },
            kind: 'withdrawal.rejected',
            params: {
              transactionId: failed.id,
              amount: failed.amount,
              currency: failed.currency,
              reason: effectiveReason ?? '',
              ...(effectiveReasonAr ? { reasonAr: effectiveReasonAr } : {}),
            },
          },
          tx,
        );
      },
      null,
      effectiveReasonAr,
    );
    void this.emailWithdrawalDecision(row, 'rejected', effectiveReason);
    /*
     * RBAC-03 on the DECISION's own response.
     *
     * The desk list masks; these did not, so a reviewer who cannot see the
     * client's address on the screen got it back in the body of the button they
     * pressed on that same screen. The read was protected and the write handed
     * the value over.
     *
     * Found by cross-checking the route census against the services that
     * actually mask — `WithdrawalRowDto` nests `WithdrawalUserDto`, which
     * carries the email.
     */
    return withdrawalResponse(row, actor);
  }

  /**
   * RESEND a payout a person must decide — the provider refused it outright,
   * or was proven to hold nothing for it after the adoption window. Safe under
   * double-click and races: the claim admits one in-flight create, and a
   * still-held claim (an outcome not known yet) makes this a no-op until the
   * reconciler resolves it. The flag clears only when the provider accepts it.
   */
  async resendPayout(id: string, actor: AuthenticatedAdmin) {
    assertActorCan(actor, 'withdrawals.approve', 'resend a payout');
    await this.assertWithdrawalVisible(id, actor.clientScope);
    this.audit.record(actor.id, 'withdrawal.provider.submit', 'transaction', id, {
      retriedBy: 'admin',
    });
    await this.payouts.resubmit(id);
    /*
     * Through the same seam as its four siblings, which it was not: this one
     * returned the raw `transactions` row, so it shipped `proofFilename` and
     * omitted `maskedFields` while the other four transitions did the opposite.
     * Five routes sharing one `WithdrawalRowDto` were returning two shapes.
     *
     * No masking gap hid behind it — `getById` selects from `transactions`
     * alone and joins no user — but a DTO that describes only four of its five
     * routes is one somebody will trust about the fifth.
     */
    return withdrawalResponse(await this.transactions.getById(id), actor);
  }
  async rejectWithdrawal(
    id: string,
    actor: AuthenticatedAdmin,
    reason?: string,
    reasonId?: string,
    /** The free-text reason in Arabic (0179). */
    reasonAr?: string | null,
  ) {
    assertActorCan(actor, 'withdrawals.approve', 'reject a withdrawal');
    await this.assertWithdrawalVisible(id, actor.clientScope);

    // FR-ADM-03: the reason comes from the configurable list; free text is an
    // optional note alongside it.
    let effectiveReason = reason?.trim();
    let chosen: { label: string; labelAr: string | null } | undefined;
    if (reasonId) {
      const configured = await this.rejectionReasons.findById(reasonId);
      if (!configured) throw new NotFoundError('Rejection reason not found.');
      chosen = configured;
      effectiveReason = effectiveReason
        ? `${configured.label} — ${effectiveReason}`
        : configured.label;
    }
    if (!effectiveReason) {
      throw new ValidationError('A rejection reason (reasonId or reason text) is required.');
    }
    // Its Arabic, decided now and stored with it (0179).
    const effectiveReasonAr = composeReasonArabic({
      label: chosen?.label,
      labelAr: chosen?.labelAr,
      note: reason,
      noteAr: reasonAr,
    });

    const row = await this.transactions.reject(
      id,
      actor.id,
      effectiveReason,
      async (tx, rejected) => {
        await this.audit.recordWithin(tx, actor.id, 'withdrawal.reject', 'transaction', id, {
          amount: rejected.amount,
          currency: rejected.currency,
          reason: effectiveReason,
          reasonAr: effectiveReasonAr,
        });
        await this.notifications.notify(
          {
            recipient: { kind: 'client', id: rejected.userId },
            kind: 'withdrawal.rejected',
            params: {
              transactionId: rejected.id,
              amount: rejected.amount,
              currency: rejected.currency,
              reason: effectiveReason ?? null,
              ...(effectiveReasonAr ? { reasonAr: effectiveReasonAr } : {}),
            },
          },
          tx,
        );
      },
      effectiveReasonAr,
    );
    void this.emailWithdrawalDecision(row, 'rejected', effectiveReason);
    /*
     * RBAC-03 on the DECISION's own response.
     *
     * The desk list masks; these did not, so a reviewer who cannot see the
     * client's address on the screen got it back in the body of the button they
     * pressed on that same screen. The read was protected and the write handed
     * the value over.
     *
     * Found by cross-checking the route census against the services that
     * actually mask — `WithdrawalRowDto` nests `WithdrawalUserDto`, which
     * carries the email.
     */
    return withdrawalResponse(row, actor);
  }
  async settleWithdrawal(id: string, actor: AuthenticatedAdmin, providerRef: string) {
    /*
     * SEPARATION OF DUTIES — R-5.4.
     *
     * `withdrawals.settle`, NOT `withdrawals.approve`. Settlement is the step
     * that actually releases the money; approval only says it may be released.
     * While both required the same permission, "two people must be involved in
     * a payout" was unexpressible — one compromised or dishonest admin could
     * approve their own instruction and pay it out in the same minute, and the
     * audit log would show one name on both rows.
     *
     * Splitting the KEY is what makes the control possible; whether the two are
     * actually granted to different people is a decision for whoever builds the
     * roles, and that is the right place for it. A master admin holds `*` and so
     * can still do both — deliberately, because somebody has to be able to
     * unblock a stuck payout at 2am, and that person is already the one the
     * audit log is watching most closely.
     */
    assertActorCan(actor, 'withdrawals.settle', 'settle a withdrawal');
    await this.assertWithdrawalVisible(id, actor.clientScope);

    const row = await this.transactions.settle(id, actor.id, providerRef, async (tx, settled) => {
      await this.audit.recordWithin(tx, actor.id, 'withdrawal.settle', 'transaction', id, {
        amount: settled.amount,
        currency: settled.currency,
        providerRef,
      });
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
    });
    void this.emailWithdrawalDecision(row, 'paid');
    /*
     * RBAC-03 on the DECISION's own response.
     *
     * The desk list masks; these did not, so a reviewer who cannot see the
     * client's address on the screen got it back in the body of the button they
     * pressed on that same screen. The read was protected and the write handed
     * the value over.
     *
     * Found by cross-checking the route census against the services that
     * actually mask — `WithdrawalRowDto` nests `WithdrawalUserDto`, which
     * carries the email.
     */
    return withdrawalResponse(row, actor);
  }

  /**
   * The decision mail, looked up and sent WITHOUT ever failing the decision.
   *
   * The user lookup is post-commit courtesy work: a transient failure on it
   * used to reject the handler AFTER the state change had committed, so the
   * admin saw an error, retried, and was told "only a pending withdrawal can
   * be approved" about their own success — and the email was never sent.
   * `void`-dispatched by all three callers, so it must also never reject.
   */
  private async emailWithdrawalDecision(
    row: { userId: number; amount: string; currency: string; rejectionReasonAr?: string | null },
    decision: 'approved' | 'paid' | 'rejected',
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
      this.logger.warn(
        `Could not send the withdrawal ${decision} email to the owner of a transaction: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  // ─── Ledger view (ADM-13) ─────────────────────────────────────────────────
  /**
   * The OWNING CLIENT of a withdrawal must be visible to this actor.
   *
   * Keyed off the transaction's `user_id` rather than the transaction id,
   * because the scope is a statement about CLIENTS. An out-of-scope withdrawal
   * answers 404 — identically to one that does not exist — so a scoped admin
   * cannot use these routes to learn that a withdrawal id is real.
   *
   * Takes the SCOPE rather than the actor, and that is not cosmetic: R-4.3's
   * source-scan requires every method receiving an actor to assert on it, and
   * it is right to. This one makes a visibility decision, not a permission one,
   * and its three callers have already asserted their permission by the time
   * they reach it. Narrowing the parameter to what it actually uses states that
   * honestly, instead of adding a redundant assertion to satisfy a scan.
   *
   * The lookup is skipped entirely for an unrestricted actor. Not only for the
   * query it saves on the money path: doing it unconditionally would ALSO make
   * an unknown id 404 here rather than in the state machine below, quietly
   * changing the error every existing caller sees for a reason that has nothing
   * to do with them.
   */
  /**
   * APPROVE an offline deposit — the receipt checks out, credit the wallet.
   *
   * The service-side `assertActorCan` is not belt-and-braces over the guard
   * (R-4.3): the guard runs on HTTP only, and this method is the seam a job or a
   * script would call.
   *
   * `deposits.approve`, never `wallets.credit`. The two powers differ in blast
   * radius — this one credits an amount the CLIENT declared against a reference
   * that reconciles to a bank line; `wallets.credit` types any figure into any
   * wallet. A deposit clerk needs the first and must not be handed the second.
   */
  async approveDeposit(id: string, actor: AuthenticatedAdmin) {
    assertActorCan(actor, 'deposits.approve', 'approve a deposit and credit the client');
    await this.assertDepositVisible(id, actor.clientScope);

    const row = await this.transactions.approveDeposit(id, actor.id, async (tx, approved) => {
      /*
       * Inside the transaction (R-6.5): if the audit row cannot be written, the
       * money does not move. "Who credited this client, and on what evidence" is
       * the question this row exists to answer, so a credit without it is worse
       * than a failed approval an operator can retry.
       */
      await this.audit.recordWithin(tx, actor.id, 'deposit.approve', 'transaction', id, {
        amount: approved.amount,
        currency: approved.currency,
        method: approved.methodKey,
        reference: approved.providerRef,
        // Whether anybody actually had evidence in front of them. A proofless
        // approval is legitimate — an operator can see the bank statement — but
        // it is the thing a reviewer will want to find later.
        hadReceipt: approved.proofFilename !== null,
      });
    });
    return this.toDepositDecision(row);
  }

  /**
   * REJECT an offline deposit.
   *
   * `deposits.reject` is a SEPARATE key from `deposits.approve`, on R-5.4's
   * reasoning: refusing a declaration moves no money, crediting one does, so an
   * operator can be trusted with the first and not the second.
   *
   * ⚠️ Nothing is refunded and nothing is released — see
   * `TransactionsService.rejectDeposit`. A deposit debits nothing when it is
   * filed, so there is no money here to give back.
   */
  async rejectDeposit(
    id: string,
    actor: AuthenticatedAdmin,
    reason?: string,
    reasonId?: string,
    /** The free-text reason in Arabic (0179). */
    reasonAr?: string | null,
  ) {
    assertActorCan(actor, 'deposits.reject', 'reject a deposit');
    await this.assertDepositVisible(id, actor.clientScope);

    // FR-ADM-03, identical to the withdrawal desk: the reason comes from the
    // configurable list, and free text is an optional note beside it.
    let effectiveReason = reason?.trim();
    let chosen: { label: string; labelAr: string | null } | undefined;
    if (reasonId) {
      const configured = await this.rejectionReasons.findById(reasonId);
      if (!configured) throw new NotFoundError('Rejection reason not found.');
      chosen = configured;
      effectiveReason = effectiveReason
        ? `${configured.label} — ${effectiveReason}`
        : configured.label;
    }
    if (!effectiveReason) {
      throw new ValidationError('A rejection reason (reasonId or reason text) is required.');
    }
    // Its Arabic, decided now and stored with it (0179).
    const effectiveReasonAr = composeReasonArabic({
      label: chosen?.label,
      labelAr: chosen?.labelAr,
      note: reason,
      noteAr: reasonAr,
    });

    const row = await this.transactions.rejectDeposit(
      id,
      actor.id,
      effectiveReason,
      async (tx, rejected) => {
        await this.audit.recordWithin(tx, actor.id, 'deposit.reject', 'transaction', id, {
          amount: rejected.amount,
          currency: rejected.currency,
          reason: effectiveReason,
          reasonAr: effectiveReasonAr,
        });
      },
      effectiveReasonAr,
    );
    return this.toDepositDecision(row);
  }

  /**
   * The decided row, as the console reads it.
   *
   * `proofPath` is built here rather than stored: the column holds the bare
   * filename and `storedPath` is the one place that knows the `uploads/<dir>/`
   * shape both frontends' URL builders consume. Storing the path as well would
   * be a second spelling of one fact, free to drift from the bucket.
   */
  private toDepositDecision(row: {
    id: string;
    userId: number;
    amount: string;
    currency: string;
    state: string;
    methodKey: string | null;
    providerRef: string | null;
    proofFilename: string | null;
    rejectionReason: string | null;
    rejectionReasonAr?: string | null;
    reviewedAt: Date | null;
    settledAt: Date | null;
  }): DepositDecisionDto {
    return {
      id: row.id,
      userId: row.userId,
      amount: row.amount,
      currency: row.currency,
      state: row.state,
      methodKey: row.methodKey,
      providerRef: row.providerRef,
      proofPath: row.proofFilename ? storedPath(DEPOSIT_PROOF_BUCKET.dir, row.proofFilename) : null,
      rejectionReason: row.rejectionReason,
      rejectionReasonAr: row.rejectionReasonAr ?? null,
      reviewedAt: row.reviewedAt,
      settledAt: row.settledAt,
    };
  }

  /**
   * The deposit equivalent of `assertWithdrawalVisible`, and 404 rather than 403
   * for the same reason: telling a scoped admin that a row exists but is not
   * theirs is itself a disclosure.
   */
  private async assertDepositVisible(id: string, scope: ClientScope): Promise<void> {
    if (scope.unrestricted) return;

    const owner = await this.transactions.ownerOf(id);
    const notFound = () => new NotFoundError('Deposit not found.');
    if (!owner) throw notFound();
    await this.visibility.assertVisible(owner, scope, notFound);
  }

  private async assertWithdrawalVisible(id: string, scope: ClientScope): Promise<void> {
    if (scope.unrestricted) return;

    const owner = await this.transactions.ownerOf(id);
    const notFound = () => new NotFoundError('Withdrawal not found.');
    if (!owner) throw notFound();
    await this.visibility.assertVisible(owner, scope, notFound);
  }

  async listLedger(
    query: {
      userId?: number;
      walletId?: string;
      q?: string;
      entryType?: string;
      page?: string;
      limit?: string;
      cursor?: string;
    },
    actor: AuthenticatedAdmin,
  ) {
    /*
     * R-4.3: asserted HERE as well as in the guard, because a guard only runs
     * on an HTTP request and this method is what a queued job would call.
     *
     * `ledger.view`, not `withdrawals.view` — see the note on the route. Both
     * halves had to move together: the decorator alone would have left the
     * service refusing the very admins the route now admits, and this pairing
     * is exactly what the HTTP test caught.
     */
    assertActorCan(actor, 'ledger.view', 'view the ledger');
    /*
     * `maskedFields` rides along so the screen can say ONCE, above the table,
     * which columns this reader's role hides — the convention `/clients`
     * settled on, and for its stated reason: a redaction chip in every row of a
     * fifty-row page spends horizontal space communicating one fact.
     *
     * It is a statement ABOUT the mask rather than masked data, which is why it
     * survives `FieldMaskInterceptor` untouched. Without it a masked operator
     * sees a uuid where a name should be and cannot tell "your role hides this"
     * from "this client has no name" — the exact confusion the KYC review
     * screen shipped until Sep 2026.
     */
    const page = await this.wallets.listEntries({
      // The ADM-13 ledger is the screen used FOR reconciliation, so the
      // predicate goes into the query rather than filtering afterwards.
      scope: actor.clientScope,
      userId: query.userId,
      walletId: query.walletId,
      q: query.q,
      // Checked, not cast — the same `as` that made `?state=` a 500 on the
      // withdrawals list. Missed on this call site when the rest were fixed.
      entryType: enumQuery(query.entryType, ledgerEntryTypeEnum.enumValues, 'entryType'),
      page: parseInt(query.page ?? '1', 10) || 1,
      limit: parseInt(query.limit ?? '50', 10) || 50,
      cursor: query.cursor ? decodeCursor(query.cursor) : undefined,
    });
    return { ...page, maskedFields: maskedFieldsFor('client', actor.fieldMask) };
  }
  /*
   * ─── The Financial page: every money movement THE CRM RECORDS ─────────────
   *
   * ⚠️ This said "every money movement, platform-wide" and that was FALSE, in a
   * way that matters on the one screen an operator reconciles from.
   *
   * It reads `transactions`, which is the CRM's own record. The DEALER
   * ADJUSTMENT used to be the hole in that: the "Adjust balance" dialog moved
   * money on MT5 with no wallet leg and no ledger entry, so it wrote no row
   * here and this page could not see it.
   *
   * ⚠️ THAT DIALOG AND ITS ROUTE ARE GONE, and the hole is closed for anything
   * the console does. `fundTradingAccount` above posts a wallet leg and a
   * ledger entry in both directions, so an operator moving money on a trading
   * account now appears on this page like every other movement.
   *
   * The heading is still not "platform-wide", and the remaining gap is worth
   * naming precisely: MT5 can book a balance operation the CRM never
   * originated — a swap correction, or a movement made directly in the broker
   * terminal. Those have no `transactions` row, and forcing one would not break
   * the `sum(ledger) == balance` invariant so much as make it MEANINGLESS,
   * which is worse. `GET /trading/balance-movements` reads `mt5_deals` and is
   * where they can be seen.
   *
   * Where those movements ARE visible: `/audit-log` for the operator act, and
   * `GET /trading/balance-movements` for the client's own view of the same
   * thing, which exists because the money moved on their account and the CRM
   * had no client-facing record of it at all.
   *
   * Found by the owner, by hand, on the client's transactions page.
   */

  async listTransactions(
    /*
     * The FILTER half is `AdminMovementsFilter` itself (minus the scope this
     * method supplies from the actor), spread through UNTOUCHED — the same
     * rule the summary and the export follow. Re-declaring the fields here
     * and copying them one by one is how a filter added to the shared shape
     * flows into the file and the tiles but silently vanishes from the list.
     */
    query: Omit<AdminMovementsFilter, 'scope'> & {
      page?: string;
      limit?: string;
      cursor?: string;
      sort?: string;
      order?: string;
    },
    actor: AuthenticatedAdmin,
  ) {
    /*
     * R-4.3: asserted HERE as well as in the guard — a guard runs on an HTTP
     * request; this method is what a queued job would call.
     *
     * `transactions.view`, its own key: not `withdrawals.view` (the leak the
     * ledger already fixed — payout review must not hand over every deposit)
     * and not `ledger.view` (the accounting record is a different screen
     * answering a different question). See config/permissions.json.
     */
    assertActorCan(actor, 'transactions.view', 'list money movements');

    // Sort validated BEFORE the cursor is decoded — `listWithdrawals` records
    // why the order matters.
    const sort = sortKey(
      query.sort,
      ADMIN_TRANSACTION_SORT_COLUMNS,
      DEFAULT_ADMIN_TRANSACTION_SORT,
      'transactions',
    );
    const order = sortOrder(query.order);
    const {
      page: rawPage,
      limit: rawLimit,
      cursor: rawCursor,
      sort: _s,
      order: _o,
      ...filters
    } = query;
    void _s;
    void _o;

    const page = await this.transactions.listAllForAdmin({
      ...filters,
      scope: actor.clientScope,
      page: parseInt(rawPage ?? '1', 10) || 1,
      limit: parseInt(rawLimit ?? '25', 10) || 25,
      // R-2.4 — an archive the whole platform keeps writing to while it is
      // being read, which is the concurrent-insert case offset paging gets
      // wrong.
      cursor: rawCursor ? decodeCursor(rawCursor, sort) : undefined,
      sort,
      order,
    });

    /*
     * RBAC-03, the `listWithdrawals` shape: the joined client is the same
     * person the client list masks, reached without going through the client
     * service — which is every bypass this feature has ever had. `applyMask`
     * is opt-in per response, so a new surface that forgets this line leaks
     * silently and only a restricted operator can tell; the HTTP spec's
     * masking cases are the other half of the fix.
     */
    return {
      ...page,
      items: page.items,
      maskedFields: maskedFieldsFor('financial', actor.fieldMask),
    };
  }

  async transactionsSummary(query: Omit<AdminMovementsFilter, 'scope'>, actor: AuthenticatedAdmin) {
    // R-4.3, and the SAME key as the list: the tiles are the list aggregated,
    // so a different key would let one screen leak what the other refuses.
    assertActorCan(actor, 'transactions.view', 'summarise money movements');

    return this.transactions.summarizeForAdmin({
      ...query,
      scope: actor.clientScope,
    });
  }

  /*
   * The commission-plan methods were HERE and went with the engine.
   *
   * `listPrograms`, `createProgram`, `updateProgram` and `setProgramActive`,
   * all gated on `commissions.manage`, all auditing before/after because "who
   * changed the L1 share" must be answerable. They return with the MT5 bridge;
   * `ib_levels` is the configuration that replaced them for the placement half.
   */

  /**
   * How many transfers are stuck, and the oldest one's id.
   *
   * ## Why a count at all
   *
   * `TransferResumeScheduler` already detects this and raises
   * `money.transfer_stuck` at `page` severity. That alert goes to a LOG LINE and
   * nowhere else — §12.3 deliberately stops short of choosing a paging provider —
   * so on this deployment it reaches a terminal nobody is watching, and the
   * operator who could act on it has no way to know.
   *
   * The Financial table has listed these transfers all along and now carries the
   * release action, but nothing gives an operator a REASON to go and look: a
   * stuck transfer renders as one more pending row among settled history. This
   * is what makes the banner above that table possible.
   *
   * Delegated to `TransfersService`, which owns the table and the staleness
   * threshold. This class holds no `db` of its own by design.
   */
  async stuckTransfers(actor: AuthenticatedAdmin) {
    assertActorCan(actor, 'transactions.view', 'see stuck transfers');
    return await this.transfers.countStuck(actor.clientScope);
  }

  /**
   * ABANDON a transfer the bridge left in flight, releasing its hold.
   *
   * ## Why this needs a person, and cannot be a retry
   *
   * `TransferExecutor` fails a transfer when MT5 REFUSES it, and leaves it
   * pending when MT5 never answered — an unreachable bridge, a session dropped
   * mid-call. That distinction is the whole reason the resume job only ever
   * retries: it cannot tell "the movement did not happen" from "the movement
   * happened and the acknowledgement was lost", and failing the second would
   * release money that has already moved and let the client spend it twice.
   *
   * Only a human reading MT5's own record can answer that. This is the button
   * they press once they have.
   *
   * ## Until somebody presses it, the money is held INDEFINITELY
   *
   * A `wallet_to_account` transfer places a hold at request time and debits on
   * settle, so a stuck one leaves the balance intact and the spendable amount
   * at zero. Nothing expires it — the client sees "Processing" and cannot use
   * their own money, for as long as nobody looks. That was the state this
   * repairs, and the only previous route to it was hand-written SQL against a
   * money table.
   *
   * ## The reason is REQUIRED and reaches the client
   *
   * It lands in `failure_reason`, which the portal renders beside the failed
   * row. A client whose transfer is reversed hours later is owed the sentence
   * explaining why, and an operator who had to check with the broker is the
   * only one who can write it.
   *
   * `TransfersService.fail` does the work — the same path the executor takes on
   * a refusal — so the hold release and the state change stay in one
   * transaction and cannot disagree.
   */
  async abandonTransfer(
    id: string,
    actor: AuthenticatedAdmin,
    reason: string,
    /** The reason in Arabic (0179) — the client reads it on the failed transfer. */
    reasonAr?: string | null,
  ) {
    assertActorCan(actor, 'transfers.abandon', 'abandon a stuck transfer');

    const transfer = await this.transfers.findById(id);
    const transferNotFound = () => new NotFoundError('That transfer does not exist.');
    if (!transfer) throw transferNotFound();

    /*
     * SCOPE, checked against the transfer's owner. A scoped desk may only act
     * on their own clients, and an out-of-scope transfer must 404 exactly like
     * a missing one rather than confirming it exists.
     */
    await this.visibility.assertVisible(transfer.userId, actor.clientScope, transferNotFound);

    /*
     * Refused unless it is genuinely stuck. `fail` already refuses a
     * non-pending transfer, but the message it gives is about state machines;
     * this one is about the decision, and it is the message an operator sees
     * when they try to abandon something that settled while they were checking.
     */
    if (transfer.state !== 'pending') {
      throw new ValidationError(
        `That transfer is already ${transfer.state}, so there is nothing to release. ` +
          'It resolved while you were looking at it.',
      );
    }

    const arabic = composeReasonArabic({ note: reason, noteAr: reasonAr });
    const failed = await this.transfers.fail(id, reason.trim(), arabic);

    /*
     * Audited with BOTH sides and the reason, because this is the one operation
     * on the platform that decides a movement did not happen on evidence the
     * system cannot see. "Who released this, when, and what did the broker
     * say" is the entire record of that decision.
     */
    this.audit.record(actor.id, 'transfer.abandon', 'transfer', id, {
      userId: transfer.userId,
      amount: transfer.amount,
      currency: transfer.currency,
      direction: transfer.direction,
      pendingSince: transfer.createdAt,
      reason: reason.trim(),
      reasonAr: arabic,
    });

    return failed;
  }

  /**
   * "Mark resolved" — a person reconciled a deposit or payout that only a
   * person could: an amount the platform reported differently, a reversal,
   * money paid against a failed row, the platform and this side disagreeing.
   *
   * Before this there was no way to say it was done. The flag had no clearing
   * path for deposits, so the row carried "needs attention" for ever and the
   * admin task about it could never finish. Clearing it here ends those tasks
   * for every admin at once — the `transactions` trigger, not this code.
   *
   * Order of checks: FOUND, then SCOPE (an out-of-territory payment 404s like a
   * missing one, never confirming it exists), then PERMISSION by direction —
   * `deposits.approve` for a deposit; `withdrawals.settle` for a payout,
   * because "did this money move" is that permission's judgement, the same
   * reasoning `abandonTransfer` records.
   */
  async resolveAttention(id: string, actor: AuthenticatedAdmin, note: string) {
    const payment = await this.transactions.getById(id);
    // `getById`'s own answer for a missing transaction, so the two cannot differ.
    await this.visibility.assertVisible(
      payment.userId,
      actor.clientScope,
      () => new NotFoundError('Transaction not found.'),
    );
    assertActorCan(
      actor,
      payment.direction === 'deposit' ? 'deposits.approve' : 'withdrawals.settle',
      'resolve a payment that needs attention',
    );

    const stale = () =>
      new ValidationError(
        'This payment no longer needs attention — somebody resolved it while you were looking.',
      );
    if (!payment.needsAttention) throw stale();

    const resolved = await this.transactions.resolveAttention(id, (tx) =>
      this.audit.recordWithin(tx, actor.id, 'transaction.attention_resolve', 'transaction', id, {
        userId: payment.userId,
        direction: payment.direction,
        amount: payment.amount,
        currency: payment.currency,
        reason: payment.attentionReason,
        note: note.trim(),
      }),
    );
    if (!resolved) throw stale();
    return { id, needsAttention: false };
  }

  /**
   * FINISH A FLAGGED HOSTED DEPOSIT (0173) — a deposit paid on a provider's
   * page that only a person can settle: an amount a fixed link did not
   * expect, funds the provider did not confirm, a payment reported after the
   * row had failed. Until 0173 these could never be finished: the desk
   * refused hosted deposits and "Mark resolved" only cleared the flag.
   *
   *   credit — credits the figure the PROVIDER REPORTED, rounded down to the
   *            wallet's places, with the person's reason (deposits.approve);
   *   close  — no credit, the reason kept on the row (deposits.reject).
   *
   * Scope first (an out-of-territory deposit 404s like a missing one), the
   * engine checks the rest and audits in the same transaction as the money.
   */
  async finishFlaggedDeposit(
    id: string,
    actor: AuthenticatedAdmin,
    decision: 'credit' | 'close',
    reason: string,
  ) {
    const payment = await this.transactions.getById(id);
    await this.visibility.assertVisible(
      payment.userId,
      actor.clientScope,
      () => new NotFoundError('Transaction not found.'),
    );
    const why = reason.trim();
    if (why.length === 0) throw new ValidationError('Say why, for the record.');
    const row =
      decision === 'credit'
        ? await this.hostedDeposits.creditReceived(id, actor, why)
        : await this.hostedDeposits.closeWithoutCredit(id, actor, why);
    return { id: row.id, state: row.state, amount: row.amount, currency: row.currency };
  }

  /**
   * FINISH A FLAGGED PAYOUT (0174): one the provider holds that the engine will
   * not finish itself — reported paid to another destination, or several
   * provider records could be it. `paid` settles it with the reference of what
   * reached the client; `refund` fails it and refunds their wallet.
   */
  async finishFlaggedPayout(
    id: string,
    actor: AuthenticatedAdmin,
    decision: 'paid' | 'refund',
    reason: string,
    reference?: string,
  ) {
    await this.assertWithdrawalVisible(id, actor.clientScope);
    const row = await this.payouts.finishFlagged(id, actor, decision, reason, reference);
    return { id: row.id, state: row.state, amount: row.amount, currency: row.currency };
  }
}
