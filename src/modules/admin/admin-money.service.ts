import { Inject, Injectable, Logger } from '@nestjs/common';
import { RejectionReasonsStore } from '../../store/rejection-reasons.store';
import {
  NOTIFICATION_DISPATCH,
  type NotificationDispatchPort,
} from '../../common/provisioning/notification-dispatch.port';
import {
  DEFAULT_WITHDRAWAL_SORT,
  MANUAL_ADMIN_PROVIDER,
  TransactionsService,
  WITHDRAWAL_SORT_COLUMNS,
} from '../payments/transactions.service';
import { sortKey, sortOrder } from '../../common/sorting';
import { WalletService } from '../wallet/wallet.service';
import { UsersStore } from '../../store/users.store';
import { EmailService } from '../email/email.service';
import { NotFoundError, ValidationError } from '../../common/errors/domain-errors';
import { AdminAuditService } from './admin-audit.service';
import { assertActorCan } from '../../common/security/actor';
import { decodeCursor } from '../../common/pagination';
import { enumQuery } from '../../common/query-params';
import { ledgerEntryTypeEnum } from '../../database/schema';
import { ClientVisibilityService } from '../../common/security/client-visibility.service';
import { CurrenciesService } from '../currencies/currencies.service';
import { RivalWithdrawalsService } from '../payments/rival/rival-withdrawals.service';
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
@Injectable()
export class AdminMoneyService {
  private readonly logger = new Logger(AdminMoneyService.name);

  constructor(
    private readonly transactions: TransactionsService,
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
    /** The Rival payout leg. Appended LAST — the positional-construction rule. */
    private readonly rivalWithdrawals: RivalWithdrawalsService,
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
    params: { userId: string; amount: string; currency: string; reason: string },
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
      },
      dedupeKey: `wallet.credited:${result.transaction.id}`,
    });

    return { transaction: result.transaction, replayed: false as const };
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
  async openWallet(params: { userId: string; currency: string }, actor: AuthenticatedAdmin) {
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
    if (!wallet) throw new NotFoundError('Wallet not found.');
    await this.visibility.assertVisible(wallet.userId, actor.clientScope);

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
      state?: string;
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

    return this.transactions.listForAdmin({
      scope: actor.clientScope,
      state: query.state,
      page: parseInt(query.page ?? '1', 10) || 1,
      limit: parseInt(query.limit ?? '25', 10) || 25,
      // R-2.4. This is a work queue an admin reads while clients keep
      // submitting — the concurrent-insert case offset paging gets wrong.
      cursor: query.cursor ? decodeCursor(query.cursor, sort) : undefined,
      sort,
      order,
    });
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

    const row = await this.transactions.approve(id, actor.id, async (tx, approved) => {
      await this.audit.recordWithin(tx, actor.id, 'withdrawal.approve', 'transaction', id, {
        amount: approved.amount,
        currency: approved.currency,
      });
      // In the SAME transaction as the state change (the audit stance): the
      // client is told "approved" only if it actually was.
      await this.notifications.notify(
        {
          recipient: { kind: 'client', id: approved.userId },
          /*
           * `withdrawal.paid`, not `withdrawal.approved`.
           *
           * The row is `success` by the time this runs, so telling the client
           * their withdrawal was "approved" would announce an intermediate
           * state that no longer exists and leave them waiting for a second
           * message that is never coming. Both kinds are in the portal's
           * catalogue; historical rows keep the old one.
           */
          kind: 'withdrawal.paid',
          params: {
            transactionId: approved.id,
            amount: approved.amount,
            currency: approved.currency,
          },
        },
        tx,
      );
    });
    // FR-CORE-08 "email on success/failure" begins at approval: this is the
    // first decision the client can be told about.
    void this.emailWithdrawalDecision(row, 'approved');
    /*
     * The Rival submission, POST-COMMIT and detached: the approval is a fact
     * the moment its transaction commits, and a Rival outage must not turn a
     * successful approval into an error on the admin's screen. `submitApproved`
     * never throws, claims before it creates (Rival's withdrawal API has no
     * idempotency key), and no-ops for non-whish rows — a needs-attention flag
     * on the desk is the failure surface.
     */
    void this.rivalWithdrawals.submitApproved(row.id);
    return row;
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
   * Two shapes, decided by `RivalWithdrawalsService.cancelApproved`:
   * never-submitted cancels locally; submitted asks Rival FIRST and refuses
   * cleanly if the payout is already being processed (its 409) — "cancelled
   * here, paid there" is the split-brain this integration exists to prevent.
   */
  async cancelWithdrawal(
    id: string,
    actor: AuthenticatedAdmin,
    reason?: string,
    reasonId?: string,
  ) {
    assertActorCan(actor, 'withdrawals.approve', 'cancel an approved withdrawal');
    await this.assertWithdrawalVisible(id, actor.clientScope);

    let effectiveReason = reason?.trim();
    if (reasonId) {
      const configured = await this.rejectionReasons.findById(reasonId);
      if (!configured) throw new NotFoundError('Rejection reason not found.');
      effectiveReason = effectiveReason
        ? `${configured.label} — ${effectiveReason}`
        : configured.label;
    }
    if (!effectiveReason) {
      throw new ValidationError('A cancellation reason (reasonId or reason text) is required.');
    }

    const current = await this.transactions.getById(id);
    // Rival first: if the payout can no longer be stopped this throws and
    // NOTHING local changes — the desk is told to act on the outcome instead.
    await this.rivalWithdrawals.cancelApproved({
      id: current.id,
      rivalWithdrawalId: current.rivalWithdrawalId,
      rivalSubmittedAt: current.rivalSubmittedAt,
    });

    const row = await this.transactions.markFailed(
      id,
      effectiveReason,
      actor,
      async (tx, failed) => {
        await this.audit.recordWithin(tx, actor.id, 'withdrawal.cancel', 'transaction', id, {
          amount: failed.amount,
          currency: failed.currency,
          reason: effectiveReason,
          rivalWithdrawalId: current.rivalWithdrawalId,
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
            },
          },
          tx,
        );
      },
    );
    void this.emailWithdrawalDecision(row, 'rejected', effectiveReason);
    return row;
  }

  /**
   * Re-run the Rival submission for a row whose first attempt definitively
   * failed. Safe under double-click and races: the claim column admits one
   * in-flight create, and a still-held claim (the indeterminate case) makes
   * this a no-op until the reconciler resolves it.
   */
  async retryRivalSubmission(id: string, actor: AuthenticatedAdmin) {
    assertActorCan(actor, 'withdrawals.approve', 'retry a payout submission');
    await this.assertWithdrawalVisible(id, actor.clientScope);
    this.audit.record(actor.id, 'withdrawal.rival.submit', 'transaction', id, {
      retriedBy: 'admin',
    });
    await this.rivalWithdrawals.submitApproved(id);
    return this.transactions.getById(id);
  }
  async rejectWithdrawal(
    id: string,
    actor: AuthenticatedAdmin,
    reason?: string,
    reasonId?: string,
  ) {
    assertActorCan(actor, 'withdrawals.approve', 'reject a withdrawal');
    await this.assertWithdrawalVisible(id, actor.clientScope);

    // FR-ADM-03: the reason comes from the configurable list; free text is an
    // optional note alongside it.
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

    const row = await this.transactions.reject(
      id,
      actor.id,
      effectiveReason,
      async (tx, rejected) => {
        await this.audit.recordWithin(tx, actor.id, 'withdrawal.reject', 'transaction', id, {
          amount: rejected.amount,
          currency: rejected.currency,
          reason: effectiveReason,
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
            },
          },
          tx,
        );
      },
    );
    void this.emailWithdrawalDecision(row, 'rejected', effectiveReason);
    return row;
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
    return row;
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
    row: { userId: string; amount: string; currency: string },
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
  private async assertWithdrawalVisible(id: string, scope: ClientScope): Promise<void> {
    if (scope.unrestricted) return;

    const owner = await this.transactions.ownerOf(id);
    if (!owner) throw new NotFoundError('Withdrawal not found.');
    await this.visibility.assertVisible(owner, scope);
  }

  async listLedger(
    query: {
      userId?: string;
      walletId?: string;
      entryType?: string;
      page?: string;
      limit?: string;
      cursor?: string;
    },
    actor: AuthenticatedAdmin,
  ) {
    assertActorCan(actor, 'withdrawals.view', 'view the ledger');
    return this.wallets.listEntries({
      // The ADM-13 ledger is the screen used FOR reconciliation, so the
      // predicate goes into the query rather than filtering afterwards.
      scope: actor.clientScope,
      userId: query.userId,
      walletId: query.walletId,
      // Checked, not cast — the same `as` that made `?state=` a 500 on the
      // withdrawals list. Missed on this call site when the rest were fixed.
      entryType: enumQuery(query.entryType, ledgerEntryTypeEnum.enumValues, 'entryType'),
      page: parseInt(query.page ?? '1', 10) || 1,
      limit: parseInt(query.limit ?? '50', 10) || 50,
      cursor: query.cursor ? decodeCursor(query.cursor) : undefined,
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
}
