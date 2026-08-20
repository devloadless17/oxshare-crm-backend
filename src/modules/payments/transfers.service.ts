import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { getDb } from '../../database/db';
import { tradingAccounts, transfers, users } from '../../database/schema';
import {
  AuthorizationError,
  NotFoundError,
  ValidationError,
} from '../../common/errors/domain-errors';
import { CurrenciesService } from '../currencies/currencies.service';
import { WalletService } from '../wallet/wallet.service';
import Decimal from 'decimal.js';
import { money, toDecimal } from '../wallet/money';
import { LEDGER_REFERENCE } from '../../database/ledger-reference';
import {
  NOTIFICATION_DISPATCH,
  type NotificationDispatchPort,
} from '../../common/provisioning/notification-dispatch.port';

type Db = ReturnType<typeof getDb>;

/**
 * Moving money between a client's wallet and one of their MT5 accounts.
 *
 * ## The CRM owns one side of this and not the other
 *
 * Wallet balances are ours. Trading-account balances are MT5's, and there is no
 * bridge yet. Everything below is shaped by refusing to pretend otherwise —
 * `trading_accounts` has no balance column, so there is no CRM number that can
 * disagree with what the client sees in their terminal.
 *
 * ## The two directions are deliberately asymmetric
 *
 *   WALLET → ACCOUNT   the amount is HELD immediately, exactly as a withdrawal
 *                      holds. From the wallet's point of view that is what this
 *                      is: money committed and on its way out. Settlement turns
 *                      the hold into a debit; failure releases it.
 *
 *   ACCOUNT → WALLET   nothing happens to the wallet on request. Money the CRM
 *                      has not received is money the CRM must not show, so the
 *                      credit is posted only when the bridge confirms MT5 was
 *                      actually debited.
 *
 * Read together: the CRM changes a balance only when it knows the money is on
 * its side of the boundary. That is the whole design, and it is why a transfer
 * has a `pending` state at all rather than being instantaneous.
 *
 * ## Why the ledger entry type is `transfer`
 *
 * Not `deposit` or `withdrawal`. Those mean money crossing the platform
 * BOUNDARY through a provider; an internal move counted as either would
 * overstate both totals in every report that sums the ledger by type.
 */
@Injectable()
export class TransfersService {
  private readonly logger = new Logger(TransfersService.name);

  constructor(
    private readonly wallets: WalletService,
    private readonly currencies: CurrenciesService,
    @Inject(DRIZZLE_DB) private readonly db: Db,
    @Inject(NOTIFICATION_DISPATCH)
    private readonly notifications: NotificationDispatchPort,
  ) {}

  /**
   * Request a transfer. Returns the pending row.
   *
   * Every precondition is checked here rather than at the controller, per
   * R-4.3: a future job or admin tool that moves money must satisfy the same
   * rules, and a check that lives in a controller does not run for either.
   */
  async request(params: {
    userId: string;
    tradingAccountId: string;
    direction: 'wallet_to_account' | 'account_to_wallet';
    amount: string;
    currency: string;
  }) {
    const amount = toDecimal(params.amount);
    if (!amount.isPositive()) throw new ValidationError('Transfer amount must be positive.');

    // Refuses an unknown or DISABLED currency. This is the runtime half of what
    // the old `'USD' | 'USDT'` union checked at compile time — see
    // `wallet.service.ts` on why that moved.
    const currency = await this.currencies.assertUsable(params.currency);

    const [user] = await this.db.select().from(users).where(eq(users.id, params.userId)).limit(1);
    if (!user) throw new NotFoundError('User not found.');

    /*
     * §8.4 — funded features are gated on KYC level 1, the same gate the
     * withdrawal path applies. A transfer moves real money out of a wallet and
     * into a live trading account, so it is a funded feature by any reading.
     */
    if (user.verificationLevel < 1) {
      throw new AuthorizationError('Transfers require a verified account (KYC level 1).');
    }

    /*
     * The account must belong to the CALLER.
     *
     * `userId` is in the WHERE clause rather than compared after the fetch: an
     * equality check on a row already loaded is one `if` away from being
     * removed by someone tidying up, and the consequence here is funding a
     * stranger's trading account from your own wallet. Not-found and
     * not-yours answer identically, which also stops this enumerating account
     * ids belonging to other clients.
     */
    const [account] = await this.db
      .select()
      .from(tradingAccounts)
      .where(
        and(eq(tradingAccounts.id, params.tradingAccountId), eq(tradingAccounts.userId, user.id)),
      )
      .limit(1);
    if (!account) throw new NotFoundError('Trading account not found.');

    /*
     * Demo accounts are refused outright.
     *
     * A demo account trades practice money. Funding one from a real wallet
     * would destroy actual client funds in exchange for nothing, and it is an
     * easy mis-click on a screen that lists live and demo accounts together.
     * Refusing is the only safe answer; there is no meaningful "are you sure".
     */
    if (account.environment !== 'live') {
      throw new ValidationError(
        'Only live trading accounts can be funded. Demo accounts trade practice money and are not linked to your wallet.',
      );
    }

    /*
     * Suspended accounts take no money.
     *
     * `status` is new with the CRM-side trading accounts — an operator can
     * suspend one, and a transfer into it would be funds the client cannot
     * reach and cannot trade with.
     */
    if (account.status !== 'active') {
      throw new ValidationError(
        `That trading account is ${account.status} and cannot be used for transfers.`,
      );
    }

    /*
     * Same currency both sides, or refuse.
     *
     * A transfer between a USD wallet and a USD account is a MOVE. Between
     * different currencies it is a CONVERSION, and there is no FX rate source
     * anywhere in this system — so the alternatives are inventing a rate or
     * moving the number across unchanged and calling 100 USD "100 USDT". Both
     * are wrong in a way that only shows up on a statement.
     *
     * Refusing here rather than in the DTO because the account's currency is
     * only knowable after the lookup.
     */
    if (account.currency !== currency) {
      throw new ValidationError(
        `That trading account is denominated in ${account.currency}, and this transfer is in ` +
          `${currency}. Transfers do not convert between currencies.`,
      );
    }

    return this.db.transaction(async (tx) => {
      /*
       * The hold and the transfer row commit together.
       *
       * Same reasoning `requestWithdrawal` records: holding first and inserting
       * second leaves funds reserved against a transfer that does not exist if
       * the insert fails — invisible to the client and unreleasable without a
       * manual fix.
       */
      const wallet =
        params.direction === 'wallet_to_account'
          ? await this.wallets.hold(params.userId, currency, amount, tx)
          : await this.wallets.getOrCreateWallet(params.userId, currency, 'main', tx);

      const [row] = await tx
        .insert(transfers)
        .values({
          userId: params.userId,
          walletId: wallet.id,
          tradingAccountId: account.id,
          direction: params.direction,
          amount: money(amount),
          currency,
          state: 'pending',
        })
        .returning();
      return row;
    });
  }

  /**
   * Settle both legs: the wallet's, and the trading account's.
   *
   * ## The account leg is new, and it is temporary
   *
   * The version this restores posted only the WALLET leg, because MT5 owned the
   * account balance and the bridge moved it. There is no bridge
   * (ARCHITECTURE open decision #1), so `trading_accounts.balance` is a CRM
   * column — see its schema comment, which records that this reverses a
   * deliberate decision and must be reversed back.
   *
   * While that holds, a transfer that moved only the wallet would take money
   * out of a client's balance and put it nowhere.
   *
   * ## Idempotency, and where it does NOT reach
   *
   * The wallet leg is idempotent through `WalletService.post` — ON CONFLICT on
   * (wallet, referenceType, referenceId), with the transfer id as the
   * reference, so a bridge that retries cannot double-post (§6.3).
   *
   * The account leg is a bare `UPDATE … SET balance = balance ± amount` and has
   * no such guard. What protects it is the state check plus the transaction:
   * `settle` refuses a transfer that is not `pending`, and the state change
   * commits with both legs. A concurrent second call reads `pending` too, but
   * one of the two transactions loses the row lock on `transfers` and finds the
   * state already moved. THAT IS WEAKER than the ledger's guarantee and is
   * called out here rather than assumed: when the bridge lands and this leg
   * becomes a sync rather than a write, it needs its own idempotency key.
   */
  /**
   * @param mt5Balance What MT5 holds after the movement, from the executor's own
   * read. Null when it could not be read — the column is then left alone rather
   * than computed, because a known-stale figure beats a confident wrong one.
   */
  async settle(transferId: string, mt5Balance: string | null = null) {
    const transfer = await this.findOne(transferId);
    if (!transfer) throw new NotFoundError('Transfer not found.');
    if (transfer.state !== 'pending') {
      throw new ValidationError(
        `Only a pending transfer can settle; this one is ${transfer.state}.`,
      );
    }

    const amount = toDecimal(transfer.amount);

    // One timestamp for the whole settlement, so both legs and the mirror's
    // `balanceSyncedAt` agree about when this happened.
    const settledAt = new Date();

    await this.db.transaction(async (tx) => {
      /*
       * The transfer row is locked FIRST, and the state re-checked against it.
       *
       * The read above this transaction is advisory — two concurrent settles
       * both pass it. This lock is what serialises them, and the state check
       * below is what makes the second one a no-op rather than a second
       * balance move on an account leg that has no ON CONFLICT to save it.
       */
      const [locked] = await tx
        .select()
        .from(transfers)
        .where(eq(transfers.id, transfer.id))
        .for('update')
        .limit(1);
      if (!locked || locked.state !== 'pending') return;

      if (transfer.direction === 'wallet_to_account') {
        // Release the hold and post the debit in one scope. Releasing without
        // debiting would hand the money back while the account also has it.
        await this.wallets.release(transfer.userId, transfer.currency, amount, tx);
        await this.wallets.post(
          {
            userId: transfer.userId,
            currency: transfer.currency,
            amount: amount.negated(),
            entryType: 'transfer',
            referenceType: LEDGER_REFERENCE.transfer,
            referenceId: transfer.id,
          },
          tx,
        );
        await this.writeAccountBalance(
          tx,
          transfer.tradingAccountId,
          mt5Balance,
          amount,
          settledAt,
        );
      } else {
        // The credit the client has been waiting for: MT5 has confirmed its own
        // debit, so the money is now on our side of the boundary.
        await this.wallets.post(
          {
            userId: transfer.userId,
            currency: transfer.currency,
            amount,
            entryType: 'transfer',
            referenceType: LEDGER_REFERENCE.transfer,
            referenceId: transfer.id,
          },
          tx,
        );
        /*
         * The same writer as the deposit leg, and the guard is inside it.
         *
         * `writeAccountBalance` refuses to drive the column negative when it has
         * to compute — the rule 0082 removed from the schema and this restored:
         * MT5 may REPORT a negative balance, but the CRM must never CREATE one by
         * paying out money the account does not hold.
         */
        await this.writeAccountBalance(
          tx,
          transfer.tradingAccountId,
          mt5Balance,
          amount.negated(),
          settledAt,
        );
      }

      await tx
        .update(transfers)
        .set({ state: 'settled', settledAt: new Date() })
        .where(eq(transfers.id, transfer.id));
    });

    this.logger.log(`Transfer ${transfer.id} settled (${transfer.direction}).`);

    /*
     * Tell the client their money arrived.
     *
     * A transfer is the one money movement here that is genuinely ASYNCHRONOUS
     * from the client's point of view: they submit it, the wallet leg moves
     * immediately, and the account leg lands only when the bridge confirms.
     * Between those two moments their money is visibly in neither place, which
     * is the state that generates support tickets. This is the message that
     * closes it.
     *
     * `direction` travels so the copy can say which way it went — "funded" and
     * "returned to your wallet" are different sentences, and one catalogue entry
     * that said "transfer completed" for both would be the vaguest possible
     * answer to "where is my money".
     *
     * OUTSIDE the transaction, deliberately, and this one is worth being exact
     * about: passing `tx` would join the notification to the money movement, and
     * `notify` in that mode is documented to FAIL THE CALLER on error. A
     * settlement that has already moved a wallet balance and an MT5 balance must
     * not roll back because a bell row was too long — the two legs are not
     * symmetric and the account leg is not ours to undo. Post-commit, the port
     * never throws.
     *
     * Keyed on the transfer id, so the at-least-once callers that reach `settle`
     * — the bridge webhook, a retried job — ring once. The state guard inside
     * the transaction already makes a second settle a no-op, but that guard
     * returns quietly and execution still arrives here.
     */
    void this.notifications.notify({
      recipient: { kind: 'client', id: transfer.userId },
      kind: 'transfer.completed',
      params: {
        transferId: transfer.id,
        direction: transfer.direction,
        amount: transfer.amount,
        currency: transfer.currency,
      },
      dedupeKey: `transfer.completed:${transfer.id}`,
    });

    return this.findOne(transfer.id);
  }

  /**
   * Write the trading account's balance: MT5's figure when we have it.
   *
   * ## Why there are two paths and only one of them is arithmetic
   *
   * `trading_accounts.balance` mirrors MT5 (0081), and MT5 is the authority. When
   * the executor managed to read the account back after moving the money, that
   * number is the truth and it is written verbatim — stamped with
   * `balanceSyncedAt` so the sweep's staleness guard cannot later overwrite it
   * with a snapshot read BEFORE this transfer.
   *
   * The fallback exists because the read can fail while the movement succeeded.
   * Then we compute, and deliberately do NOT stamp a sync time: the figure is our
   * best guess rather than MT5's word, so the next snapshot — however old —
   * should win. That is the one case where a stale mirror is preferable to a
   * confident one.
   *
   * ## The refusal
   *
   * Only the computed path can drive the column negative, and only a withdrawal
   * can compute downward. The guard lives in the WHERE clause rather than a
   * read-then-check because a check-then-update races itself and a stale read
   * pays out twice; `returning()` makes the refusal visible so the throw rolls
   * back the wallet leg posted alongside it.
   */
  private async writeAccountBalance(
    tx: Parameters<Parameters<Db['transaction']>[0]>[0],
    tradingAccountId: string,
    mt5Balance: string | null,
    delta: Decimal,
    settledAt: Date,
  ): Promise<void> {
    if (mt5Balance !== null) {
      await tx
        .update(tradingAccounts)
        .set({ balance: mt5Balance, balanceSyncedAt: settledAt, updatedAt: settledAt })
        .where(eq(tradingAccounts.id, tradingAccountId));
      return;
    }

    const moved = await tx
      .update(tradingAccounts)
      .set({
        balance: sql`${tradingAccounts.balance} + ${money(delta)}::numeric`,
        updatedAt: settledAt,
      })
      .where(
        and(
          eq(tradingAccounts.id, tradingAccountId),
          // Only a withdrawal can go negative; a deposit satisfies this trivially.
          sql`${tradingAccounts.balance} + ${money(delta)}::numeric >= 0`,
        ),
      )
      .returning({ id: tradingAccounts.id });

    if (moved.length === 0) {
      throw new ValidationError(
        'The trading account does not hold enough to cover this transfer. Its balance may have ' +
          'moved since the transfer was requested.',
      );
    }
  }

  /**
   * The bridge refused. Return the client to exactly where they started.
   *
   * `wallet_to_account` releases the hold — the money was never debited, only
   * reserved, so there is nothing to compensate and no ledger entry to write.
   * `account_to_wallet` credited nothing on request, so it has nothing to undo.
   * Both leave the position identical to before the request, which is what
   * makes a failed transfer safe for the client to simply retry.
   */
  async fail(transferId: string, reason: string) {
    const transfer = await this.findOne(transferId);
    if (!transfer) throw new NotFoundError('Transfer not found.');
    if (transfer.state !== 'pending') {
      throw new ValidationError(`Only a pending transfer can fail; this one is ${transfer.state}.`);
    }

    await this.db.transaction(async (tx) => {
      if (transfer.direction === 'wallet_to_account') {
        await this.wallets.release(
          transfer.userId,
          transfer.currency,
          toDecimal(transfer.amount),
          tx,
        );
      }
      await tx
        .update(transfers)
        .set({ state: 'failed', failureReason: reason, settledAt: new Date() })
        .where(eq(transfers.id, transfer.id));
    });

    this.logger.warn(`Transfer ${transfer.id} failed: ${reason}`);
    return this.findOne(transfer.id);
  }

  /**
   * A client's own transfers, newest first.
   *
   * `userId` is a WHERE clause and never a caller-supplied filter — it is the
   * only thing between this and one client reading another's movements.
   */
  listForUser(userId: string) {
    return this.db
      .select()
      .from(transfers)
      .where(eq(transfers.userId, userId))
      .orderBy(desc(transfers.createdAt));
  }

  /**
   * One transfer by id, for a caller that already knows which one it wants.
   *
   * Public because `TransferExecutor` reads a transfer's state before and after
   * it moves money on MT5, and reading it through `listForUser` would mean
   * knowing the owner to look up a row it already holds the id of. No ownership
   * check here on purpose: the only caller is server-side and acts on a row it
   * was handed, and adding one would imply this is reachable from a request.
   */
  async findById(id: string) {
    return await this.findOne(id);
  }

  private async findOne(id: string) {
    const [row] = await this.db.select().from(transfers).where(eq(transfers.id, id)).limit(1);
    return row ?? null;
  }
}
