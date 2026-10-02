import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { getDb } from '../../database/db';
import { tradingAccounts, transfers, users } from '../../database/schema';
import {
  UNRESTRICTED,
  clientScopePredicate,
  type ClientScope,
} from '../../common/security/client-scope';
import { TRANSFER_STALE_MS } from './transfer-staleness';
import {
  AuthorizationError,
  ConflictError,
  NotFoundError,
  ValidationError,
} from '../../common/errors/domain-errors';
import { violatesConstraint } from '../../common/errors/pg-violation';
import { CurrenciesService } from '../currencies/currencies.service';
import { WalletService } from '../wallet/wallet.service';
import { money, toDecimal } from '../wallet/money';
import { LEDGER_REFERENCE } from '../../database/ledger-reference';
import {
  NOTIFICATION_DISPATCH,
  type NotificationDispatchPort,
} from '../../common/provisioning/notification-dispatch.port';

type Db = ReturnType<typeof getDb>;

/**
 * A transfer settled within this long of its request finished in front of the
 * client — its completion is not news, so it rings no bell. See `settle`.
 */
const TRANSFER_ECHO_WINDOW_MS = 60_000;

/**
 * Moving money between a client's wallet and one of their MT5 accounts.
 *
 * ## The CRM owns one side of this and not the other
 *
 * Wallet balances are ours. Trading-account balances are MT5's: since 0081
 * `trading_accounts.balance` is a MIRROR, and its schema comment is categorical
 * — "nothing here computes it", "anything that adds to this column reintroduces
 * the bug". Everything below is shaped by that split. The CRM DECIDES the wallet
 * leg and merely REPORTS the account leg.
 *
 * This paragraph used to say the column did not exist, which stopped being true
 * when the bridge landed. The stale half was not harmless: it is what let a
 * computed account balance go on living in `settle`, and a computed balance is
 * what could refuse a settlement after MT5 had already moved the money.
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
    userId: number;
    tradingAccountId: string;
    direction: 'wallet_to_account' | 'account_to_wallet';
    amount: string;
    currency: string;
    /**
     * The caller's idempotency reference, for a transfer that is one leg of a
     * keyed operation. A replay returns the transfer already made for it
     * (UNIQUE `transfers_request_ref_uq`) instead of moving the money again.
     */
    requestRef?: string;
  }) {
    if (params.requestRef) {
      const existing = await this.findByRequestRef(params.requestRef);
      if (existing) return this.assertSameRequest(existing, params);
    }
    const amount = toDecimal(params.amount);
    /*
     * `lessThanOrEqualTo(0)`, NOT `!isPositive()`.
     *
     * decimal.js reads the SIGN and gives ZERO a sign of 1, so
     * `new Decimal(0).isPositive()` is TRUE and this guard never fired for '0'.
     * It read perfectly and was a no-op for the one input it most obviously
     * exists to reject. Measured: isPositive() is true for `0` and `0.00000000`
     * and false for `-0`.
     *
     * The end state was never wrong — `WalletService.post` refuses a zero
     * movement outright — so this is a wrong-error-LATE defect, not a
     * wrong-money one. What it cost is WHERE the refusal comes from. Before the
     * Domain 5 sweep a zero transfer fell all the way to the ledger; after it,
     * it surfaced as `'Hold amount must be positive.'` — a message naming a
     * HOLD, which is a concept the client never typed and cannot act on. The
     * amount they entered is the thing to name.
     *
     * `ib-wallet.service.ts` and `commission.ts` documented this trap three
     * times between them while it stayed live in six other guards, because a
     * comment beside one fix does not travel — the next reader copies the code.
     * The lint rule on `modules/wallet/**` is the part that does travel, and it
     * should be WIDENED to cover this directory once its last violation
     * (`transactions.service.ts`) is fixed.
     */
    if (amount.lessThanOrEqualTo(0)) throw new ValidationError('Transfer amount must be positive.');

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

    /*
     * ── A PRE-FLIGHT CHECK, and deliberately NOT the authority ─────────────
     *
     * Refusing an overdraw belongs here, because here it is free: no money has
     * moved, there is no wallet leg to roll back, and the client gets a sentence
     * naming their own balance instead of a transfer left `pending` or a raw MT5
     * rejection quoted back at them.
     *
     * It used to live at the far end, in `settle`, guarding a computed mirror.
     * That guard could only fire AFTER MT5 had moved the money — `settle` is
     * reachable only through a bridge call that already succeeded — so what it
     * caught was never an overdraw, only a mirror gone stale, and the price of
     * catching it was the client's credit rolled back into limbo.
     *
     * The mirror is not authoritative (0081) and can be stale in either
     * direction, so this cannot be the gate and does not pretend to be: MT5
     * checks the real balance and can still refuse, and that is the answer that
     * counts. Erring against a stale-LOW mirror costs a client one retry after
     * the next snapshot; erring the other way costs a support ticket about money
     * that is visibly in neither place.
     *
     * No `FOR UPDATE`. `settle` locks the transfer row, then the wallet, then
     * writes `trading_accounts`; taking an account lock here would take those in
     * the opposite order and deadlock the two paths against each other — a real
     * cost, to serialise a check that is advisory by construction anyway.
     *
     * In-flight transfers count against it, because two `pending` withdrawals of
     * 50 against an account holding 60 both pass a check that reads only the
     * column — and a check defeated by clicking twice is not worth its query.
     */
    if (params.direction === 'account_to_wallet') {
      const [inFlight] = await this.db
        .select({ total: sql<string>`coalesce(sum(${transfers.amount}), 0)` })
        .from(transfers)
        .where(
          and(
            eq(transfers.tradingAccountId, account.id),
            eq(transfers.direction, 'account_to_wallet'),
            eq(transfers.state, 'pending'),
          ),
        );

      const mirrored = toDecimal(account.balance);
      const committed = toDecimal(inFlight?.total ?? '0');
      const spendable = mirrored.minus(committed);

      if (spendable.lessThan(amount)) {
        throw new ValidationError(
          `That trading account holds ${money(mirrored)} ${account.currency}` +
            (committed.isZero()
              ? ''
              : `, of which ${money(committed)} is already committed to a transfer in progress`) +
            `, so ${money(amount)} cannot be moved out of it.`,
        );
      }
    }

    return this.db
      .transaction(async (tx) => {
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
            requestRef: params.requestRef ?? null,
          })
          .returning();
        return row;
      })
      .catch(async (error: unknown) => {
        /*
         * Two replays of one key raced past the lookup above: the loser's insert
         * hits the UNIQUE index, its transaction (hold included) rolls back, and
         * it answers with the winner's transfer.
         */
        if (params.requestRef && violatesConstraint(error, 'transfers_request_ref_uq')) {
          const existing = await this.findByRequestRef(params.requestRef);
          if (existing) return this.assertSameRequest(existing, params);
        }
        throw error;
      });
  }

  private async findByRequestRef(requestRef: string) {
    const [row] = await this.db
      .select()
      .from(transfers)
      .where(eq(transfers.requestRef, requestRef))
      .limit(1);
    return row;
  }

  /** A key reused for a DIFFERENT movement is refused, never silently matched. */
  private assertSameRequest(
    existing: typeof transfers.$inferSelect,
    params: { tradingAccountId: string; direction: string; amount: string; userId: number },
  ) {
    if (
      existing.userId !== params.userId ||
      existing.tradingAccountId !== params.tradingAccountId ||
      existing.direction !== params.direction ||
      !toDecimal(existing.amount).equals(toDecimal(params.amount))
    ) {
      throw new ConflictError(
        'That idempotency key was already used for a different transfer. Use a new key.',
      );
    }
    return existing;
  }

  /**
   * Settle both legs: the wallet's, and the trading account's.
   *
   * ## The account leg REPORTS, it does not decide
   *
   * By the time this runs, MT5 has already moved the money: the only path to
   * `settle` is a bridge call that returned a deal id. So the account leg is not
   * a decision this method gets to make — it is a note of what the authority
   * did, and the wallet leg is the half the CRM actually owns.
   *
   * That ordering is what makes the rule below absolute: NOTHING here may refuse
   * on the strength of `trading_accounts.balance`. A mirror the schema calls
   * non-authoritative cannot be allowed to veto a fact the authority has already
   * established — and when it did, the veto rolled back the client's wallet
   * credit and left their money in neither place. Overdraw protection lives in
   * `request`, before anything moves. See `writeAccountBalance`.
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
   * called out here rather than assumed. The MT5 leg carries its own
   * idempotency key (the transfer id, sent by `TransferExecutor` to the bridge).
   */
  /**
   * @param mt5Balance What MT5 holds after the movement, from the executor's own
   * read. Null when it could not be read — the column is then left alone rather
   * than computed, because a known-stale figure beats a confident wrong one.
   * @param balanceReadAt WHEN that figure was read from MT5 — not when this
   * settled. The mirror's staleness guard compares MT5 READ TIMES, so a figure
   * stamped with the settlement time claims to be fresher than it is and can
   * overwrite a newer snapshot. Null falls back to the settlement time, which
   * is the old behaviour and is only safe when there is no figure to write.
   */
  async settle(
    transferId: string,
    mt5Balance: string | null = null,
    balanceReadAt: Date | null = null,
  ) {
    const transfer = await this.findOne(transferId);
    if (!transfer) throw new NotFoundError('Transfer not found.');
    if (transfer.state !== 'pending') {
      throw new ValidationError(
        `Only a pending transfer can settle; this one is ${transfer.state}.`,
      );
    }

    const amount = toDecimal(transfer.amount);

    // One timestamp for the whole settlement, so both legs agree about when
    // this happened. NOT used for `balanceSyncedAt` — see `writeAccountBalance`.
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
          transfer.id,
          mt5Balance,
          balanceReadAt,
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
         * The same writer as the other direction, and it takes no amount.
         *
         * A withdrawal is the only direction that could ever drive this column
         * down, and the CRM no longer computes the figure at all — it writes
         * MT5's or nothing. So there is nothing here to subtract and nothing to
         * clamp: what the account HOLDS afterwards is MT5's answer.
         */
        await this.writeAccountBalance(
          tx,
          transfer.tradingAccountId,
          transfer.id,
          mt5Balance,
          balanceReadAt,
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
     *
     * ONLY WHEN IT WAITED. A transfer that settles within a minute of the
     * request completed while the client watched the screen confirm it; a bell
     * row saying so again is an echo of their own click — the noise the owner
     * asked the portal's bell to stop carrying (migration 0140). The message
     * earns its place exactly when the money sat in neither place for a while:
     * a queued transfer, one the resume job finished later.
     */
    if (Date.now() - new Date(transfer.createdAt).getTime() <= TRANSFER_ECHO_WINDOW_MS) {
      return this.findOne(transfer.id);
    }
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
   * Write the trading account's balance: MT5's figure, or nothing at all.
   *
   * ## One path, because only one was ever allowed
   *
   * `trading_accounts.balance` mirrors MT5 (0081) and MT5 is the authority. When
   * the executor managed to read the account back after moving the money, that
   * number is the truth and it is written verbatim — stamped with
   * `balanceSyncedAt` so the sweep's staleness guard cannot later overwrite it
   * with a snapshot read BEFORE this transfer.
   *
   * When the read failed there is no figure, and this writes NOTHING. Not a
   * computed one. The column's schema comment is categorical — "nothing here
   * computes it", "anything that adds to this column reintroduces the bug" — and
   * it names the three legitimate writers, every one of which stamps the moment
   * MT5 was ASKED. Arithmetic cannot stamp that, and that is the tell that it
   * does not belong: swap, commission and P/L move this balance without passing
   * through the CRM, so `balance ± amount` is exact only for an account that
   * does nothing else, and every real account does something else.
   *
   * `settle`'s own `@param` has said this all along — "the column is then left
   * alone rather than computed, because a known-stale figure beats a confident
   * wrong one" — while the code below computed anyway. The doc was right.
   *
   * ## What deleting the arithmetic also deleted
   *
   * The computed path carried a `>= 0` guard whose failure THREW, rolling back
   * the wallet leg posted beside it. It read as overdraw protection and could
   * not have been: `settle` is reachable only through a bridge call that already
   * succeeded, and MT5 checks the real balance before it moves anything. So the
   * account was never short — the MIRROR was, which is a thing a mirror is
   * allowed to be. A non-authoritative copy vetoing a fact the authority had
   * already established, at the cost of stranding a client's money in neither
   * place, is the inversion this removes. The real check now runs in `request`,
   * where a refusal costs a sentence instead of a stranded transfer.
   */
  private async writeAccountBalance(
    tx: Parameters<Parameters<Db['transaction']>[0]>[0],
    tradingAccountId: string,
    transferId: string,
    mt5Balance: string | null,
    balanceReadAt: Date | null,
    settledAt: Date,
  ): Promise<void> {
    if (mt5Balance !== null) {
      /*
       * ── STAMPED WITH THE MT5 READ TIME, AND GUARDED LIKE EVERY OTHER WRITE ─
       *
       * This used to stamp `settledAt` — "now" — and carry no guard at all,
       * while the two other writers of this column (`ingestSnapshot` and
       * `recordFromOperation`) both stamp the moment MT5 was ASKED and refuse
       * to move a figure read more recently than their own.
       *
       * That combination loses data. The executor reads the balance at T1; the
       * sweep reads a fresher one at T2 and writes it; this then writes the T1
       * figure stamped T3 and wins, because it compared nothing. The mirror
       * goes backwards while its `balanceSyncedAt` says it went forwards, which
       * is worse than being stale — every other writer then trusts a timestamp
       * that is not a read time.
       *
       * The window is narrow and the sweep repairs it within the hour, which is
       * exactly why it would never be noticed from a balance alone.
       */
      const syncedAt = balanceReadAt ?? settledAt;

      /*
       * Nothing updated means a FRESHER figure already exists, which is success
       * — that read already reflects this movement or supersedes it. It must
       * not throw: the money has moved and the wallet leg is posted in this
       * same transaction.
       */
      await tx
        .update(tradingAccounts)
        .set({ balance: mt5Balance, balanceSyncedAt: syncedAt, updatedAt: settledAt })
        .where(
          and(
            eq(tradingAccounts.id, tradingAccountId),
            or(
              isNull(tradingAccounts.balanceSyncedAt),
              lt(tradingAccounts.balanceSyncedAt, syncedAt),
            ),
          ),
        );
      return;
    }

    /*
     * ── NO FIGURE, SO NO WRITE ──────────────────────────────────────────────
     *
     * MT5 moved the money and then could not be read back. There is no honest
     * number for this column, and the arithmetic that used to stand here is the
     * one thing 0081 forbids outright.
     *
     * A warn, not an alert, and emphatically not a throw. Both sides that
     * actually HOLD money are correct — MT5 moved it, and the wallet leg is
     * posted in this same transaction — so nothing is stuck and no one needs
     * waking. What is stale is a mirror, which is a state a mirror is allowed to
     * be in and which the next snapshot repairs on its own.
     *
     * `balanceSyncedAt` is deliberately left untouched, so the figure keeps its
     * real age instead of claiming this settlement's: the console renders it as
     * last confirmed whenever it truly was, and the next snapshot — however old
     * — still wins over it.
     */
    this.logger.warn(
      `Transfer ${transferId} settled, but MT5 could not be read back afterwards. Trading ` +
        `account ${tradingAccountId} keeps its previous mirrored balance and its true sync ` +
        'age until the next snapshot; the transfer itself is complete.',
    );
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
    const found = await this.findOne(transferId);
    if (!found) throw new NotFoundError('Transfer not found.');

    /*
     * LOCKED AND RE-READ, exactly as `settle` does. The pre-check above used to
     * be the only one, outside any transaction, and the UPDATE carried no state
     * predicate — so an abandon racing a resume-scheduler retry that SETTLED
     * would wait on settle's row lock, then overwrite 'settled' with 'failed'
     * and release the hold a second time (release clamps rather than refuses),
     * freeing some OTHER hold the client had. Under the lock, the state we act
     * on is the state that commits.
     */
    const transfer = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(transfers)
        .where(eq(transfers.id, transferId))
        .for('update');
      if (!row) throw new NotFoundError('Transfer not found.');
      if (row.state !== 'pending') {
        throw new ValidationError(`Only a pending transfer can fail; this one is ${row.state}.`);
      }
      if (row.direction === 'wallet_to_account') {
        await this.wallets.release(row.userId, row.currency, toDecimal(row.amount), tx);
      }
      await tx
        .update(transfers)
        .set({ state: 'failed', failureReason: reason, settledAt: new Date() })
        .where(and(eq(transfers.id, row.id), eq(transfers.state, 'pending')));
      return row;
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
  listForUser(userId: number) {
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
  /**
   * How many transfers have been PENDING long enough to need a person.
   *
   * ## The gap this fills
   *
   * `TransferResumeScheduler` detects exactly this condition and raises
   * `money.transfer_stuck` at `page` severity — into a LOG LINE and nowhere
   * else, because §12.3 deliberately stops short of choosing a paging provider.
   * On a deployment with no log drain that is a terminal nobody is watching, so
   * the one person who could act on it never finds out.
   *
   * The Financial table has listed these rows all along and now carries the
   * release action. What was missing is a REASON to go and look: a stuck
   * transfer renders as one more pending row among settled history.
   *
   * ## The threshold is the SCHEDULER's, imported rather than restated
   *
   * `TRANSFER_STALE_MS`. Two copies that drift would either show a banner for
   * transfers nothing is alerting on, or — the failure that matters — stay
   * silent through a page.
   *
   * ## Scoped
   *
   * A desk sees only their own clients' stuck transfers, so the banner cannot
   * report a number they have no way to act on.
   */
  async countStuck(scope?: ClientScope) {
    const cutoff = new Date(Date.now() - TRANSFER_STALE_MS);

    const [row] = await this.db
      .select({
        count: sql<number>`count(*)::int`,
        oldestAt: sql<Date | null>`min(${transfers.createdAt})`,
      })
      .from(transfers)
      .where(
        and(
          eq(transfers.state, 'pending'),
          lt(transfers.createdAt, cutoff),
          clientScopePredicate(scope ?? UNRESTRICTED, transfers.userId),
        ),
      );

    return {
      count: row?.count ?? 0,
      oldestAt: row?.oldestAt ?? null,
      /*
       * Sent so the copy can say "over 15 minutes" without the frontend keeping
       * its own copy of a number this side owns.
       */
      thresholdMinutes: TRANSFER_STALE_MS / 60_000,
    };
  }

  async findById(id: string) {
    return await this.findOne(id);
  }

  private async findOne(id: string) {
    const [row] = await this.db.select().from(transfers).where(eq(transfers.id, id)).limit(1);
    return row ?? null;
  }
}
