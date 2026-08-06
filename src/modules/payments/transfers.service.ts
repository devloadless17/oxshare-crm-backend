import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
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
import { money, toDecimal } from '../wallet/money';

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
          : await this.wallets.getOrCreateWallet(params.userId, currency, tx);

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
   * The bridge confirms the MT5 side happened. Posts the wallet leg.
   *
   * Idempotent through `WalletService.post`, whose ON CONFLICT on
   * (wallet, referenceType, referenceId) makes a replayed settlement a no-op
   * that returns the original entry (§6.3). The transfer id IS the reference,
   * so settling the same transfer twice cannot double-post — which matters
   * because a bridge that does not hear our response will retry.
   */
  async settle(transferId: string) {
    const transfer = await this.findOne(transferId);
    if (!transfer) throw new NotFoundError('Transfer not found.');
    if (transfer.state !== 'pending') {
      throw new ValidationError(
        `Only a pending transfer can settle; this one is ${transfer.state}.`,
      );
    }

    const amount = toDecimal(transfer.amount);

    await this.db.transaction(async (tx) => {
      if (transfer.direction === 'wallet_to_account') {
        // Release the hold and post the debit in one scope. Releasing without
        // debiting would hand the money back while MT5 also has it.
        await this.wallets.release(transfer.userId, transfer.currency, amount, tx);
        await this.wallets.post(
          {
            userId: transfer.userId,
            currency: transfer.currency,
            amount: amount.negated(),
            entryType: 'transfer',
            referenceType: 'transfer',
            referenceId: transfer.id,
          },
          tx,
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
            referenceType: 'transfer',
            referenceId: transfer.id,
          },
          tx,
        );
      }

      await tx
        .update(transfers)
        .set({ state: 'settled', settledAt: new Date() })
        .where(eq(transfers.id, transfer.id));
    });

    this.logger.log(`Transfer ${transfer.id} settled (${transfer.direction}).`);
    return this.findOne(transfer.id);
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

  private async findOne(id: string) {
    const [row] = await this.db.select().from(transfers).where(eq(transfers.id, id)).limit(1);
    return row ?? null;
  }
}
