import { Inject, Injectable } from '@nestjs/common';
import Decimal from 'decimal.js';
import { aliasedTable, and, desc, eq } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db } from '../../database/db';
import { ibAccounts, ibWalletTransfers, wallets } from '../../database/schema';
import { LEDGER_REFERENCE } from '../../database/ledger-reference';
import {
  AuthorizationError,
  MoneyRuleError,
  ValidationError,
} from '../../common/errors/domain-errors';
import { available, money, toDecimal } from '../wallet/money';
import { WalletService } from '../wallet/wallet.service';
import type { IbWalletTransferDto, IbWalletTransferResultDto } from './dto/ib-wallet.dto';

/**
 * A partner's commission wallets, and the one way money leaves them.
 *
 * ## Why the commission balance is a separate wallet at all
 *
 * `CommissionService.confirmPending` used to credit the partner's ordinary
 * wallet with `entry_type = 'commission'`. The LEDGER therefore knew which
 * movements were earnings, but the BALANCE did not — a partner looking at $700
 * could not tell a deposit from a commission, and reconciling their earnings
 * against their own records meant subtracting their own deposits by hand.
 *
 * `wallets.kind` splits the balance so that question is a read. What it costs
 * is this service: one more step before earnings can be withdrawn.
 *
 * ## The commission wallet has exactly ONE exit, and that is the design
 *
 * Not a withdrawal, not a trading-account transfer, not a payment method — a
 * move into the MAIN wallet of the SAME currency, where all three of those
 * rails already exist and are untouched by any of this. Every alternative meant
 * teaching deposit, withdrawal and transfer to ask which wallet they were
 * acting on, which is three more places for the answer to be wrong on a money
 * path, in exchange for saving a partner one click.
 *
 * ## Same currency, always
 *
 * There is no FX rate source in this system — the same constraint that makes
 * `TransfersService` refuse a cross-currency move and the dashboard refuse to
 * sum two currencies into one figure. A USD commission lands in the USD wallet.
 * A partner holding earnings in a currency they do not otherwise use is a
 * currency question for the operator, not something to solve with an invented
 * rate.
 */
@Injectable()
export class IbWalletService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Db,
    private readonly wallets: WalletService,
  ) {}

  /**
   * Refuse anyone who is not an ACTIVE partner.
   *
   * A commission wallet can only have been filled by the confirm loop, so a
   * non-partner's is empty and the transfer would fail on the balance check
   * anyway. This refuses earlier and for the right reason: "you are not a
   * partner" and "you have no commission to move" are different sentences, and
   * a suspended partner reading the second would conclude their earnings had
   * been taken rather than that their account is suspended.
   *
   * Suspension stops a partner EARNING (`resolveChain` skips inactive rungs).
   * Whether it should also freeze money already earned is a commercial
   * decision, and this takes the conservative reading: it does. A partner
   * suspended for a reason that turns out to be wrong gets their money the
   * moment they are reinstated, which is recoverable — money moved out during a
   * suspension being investigated is not.
   */
  private async assertActivePartner(userId: string): Promise<void> {
    const [account] = await this.db
      .select({ active: ibAccounts.active })
      .from(ibAccounts)
      .where(eq(ibAccounts.userId, userId))
      .limit(1);

    if (!account) {
      throw new AuthorizationError('Only a partner can move commission earnings.');
    }
    if (!account.active) {
      throw new AuthorizationError(
        'Your partner account is suspended, so commission cannot be moved. Contact support.',
      );
    }
  }

  /**
   * Every commission wallet this partner holds.
   *
   * A bare array, matching `GET /wallet`, and EMPTY is the normal state for a
   * partner who has never been paid — `post` opens the wallet on the first
   * credit, so there is nothing before that. The portal renders an empty list as
   * "nothing credited yet" rather than as a zero balance, which is the same rule
   * the wallet screen follows for a currency nobody has opened.
   */
  async listCommissionWallets(userId: string) {
    return this.wallets.listWallets(userId, 'commission');
  }

  /**
   * Open a COMMISSION wallet in an offered currency, on the partner's own
   * request — the partner screen's "Open commission wallet" card (owner,
   * 26 Sep 2026).
   *
   * Adding a currency opens no wallets for anybody; a partner opens the ones
   * they want, one row each. Commission is still credited into a wallet opened
   * lazily on the first confirmed accrual, so this is about seeing the balance
   * card before then, never about being able to earn.
   *
   * ACTIVE partners only, for the reason `assertActivePartner` gives. Opened
   * EMPTY and idempotent — see `WalletService.openOwnWallet`.
   */
  async openCommissionWallet(userId: string, currency: string) {
    await this.assertActivePartner(userId);
    return this.wallets.openOwnWallet(userId, currency, 'commission');
  }

  /**
   * Move earnings from the commission wallet into the main one.
   *
   * ## One transaction, two ledger posts, and no pending state
   *
   * Both legs are `WalletService.post` calls against two rows of the same table
   * inside one transaction, so this commits whole or does not exist. That is
   * why `ib_wallet_transfers` carries no `state` column: unlike a wallet ⇄ MT5
   * transfer, nothing here crosses a boundary that can accept the debit and
   * then fail the credit.
   *
   * ## The transfer row is written FIRST
   *
   * Because both ledger entries reference it. The alternative — post, then
   * record — would leave the ledger holding two entries pointing at a row that
   * failed to insert, and the §6.3 idempotency index keyed on a reference id
   * that names nothing. The same ordering `requestWithdrawal` and
   * `TransfersService.request` both settled on, for the same reason.
   *
   * ## `allowOverdraft` is NOT set on the debit
   *
   * So the balance check lives in `post`, under the row lock, which is the only
   * place it is not a race. The read below is advisory — it exists to produce a
   * good error message, not to decide the outcome. Two transfers issued at once
   * both pass it; one of them then fails on the lock, which is correct.
   */
  async transferToMain(
    userId: string,
    input: IbWalletTransferDto,
  ): Promise<IbWalletTransferResultDto> {
    await this.assertActivePartner(userId);

    const amount = toDecimal(input.amount);
    /*
     * `lessThanOrEqualTo(0)`, NOT `!isPositive()`.
     *
     * decimal.js gives zero a sign of 1, so `new Decimal(0).isPositive()` is
     * TRUE and `!isPositive()` never fires for '0'. The guard read correctly and
     * did nothing: a zero-amount request fell through to the INSERT and surfaced
     * as a raw constraint violation naming a table the partner has never heard
     * of, instead of the sentence below.
     *
     * Its sibling `WalletService.post` checks `isZero()` separately for the same
     * reason — the two halves have to be asked as two questions.
     */
    if (!amount.isFinite() || amount.lessThanOrEqualTo(0)) {
      throw new ValidationError('The amount to transfer must be greater than zero.');
    }

    const currency = input.currency.trim().toUpperCase();

    /*
     * The source wallet is READ, never created.
     *
     * `getOrCreateWallet` would open an empty commission wallet for anybody who
     * asked, and the refusal below would then read "insufficient balance" —
     * which tells a partner they are short of money in a wallet that has never
     * existed. "You have no commission wallet in this currency" is the true
     * sentence, and it is a different problem with a different answer.
     */
    const [source] = await this.db
      .select()
      .from(wallets)
      .where(
        and(
          eq(wallets.userId, userId),
          eq(wallets.currency, currency),
          eq(wallets.kind, 'commission'),
        ),
      )
      .limit(1);

    if (!source) {
      throw new ValidationError(
        `You have no ${currency} commission wallet. Earnings open one the first time a commission is credited.`,
      );
    }

    /*
     * Advisory only — see the docblock. `available` rather than `balance`
     * because a hold is money already committed elsewhere; nothing places one on
     * a commission wallet today, and reading the same field every other money
     * path reads is what stops that becoming a bug the day something does.
     */
    const spendable = toDecimal(available(source.balance, source.onHold));
    if (spendable.lessThan(amount)) {
      throw new MoneyRuleError(
        `Insufficient commission balance: ${money(spendable)} ${currency} available, ${money(amount)} requested.`,
      );
    }

    const destination = await this.wallets.getOrCreateWallet(userId, currency, 'main');

    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(ibWalletTransfers)
        .values({
          userId,
          fromWalletId: source.id,
          toWalletId: destination.id,
          amount: money(amount),
          currency,
        })
        .returning();

      /*
       * Both legs carry `entryType: 'transfer'` and NOT 'commission'.
       *
       * That is what keeps lifetime earnings correct across a transfer.
       * `IbOverviewService` sums commission/rebate/payout entries, so a movement
       * typed as a transfer lowers the commission BALANCE and leaves the
       * EARNED total alone — which is the honest reading: moving money you have
       * already earned does not earn or unearn anything.
       *
       * Typing the debit as 'commission' with a negative amount would have made
       * lifetime earnings fall every time a partner moved their own money, and
       * a partner watching their earnings drop after a withdrawal reads that as
       * the platform taking it back.
       */
      await this.wallets.post(
        {
          userId,
          currency,
          kind: 'commission',
          amount: amount.negated(),
          entryType: 'transfer',
          referenceType: LEDGER_REFERENCE.ibTransfer,
          referenceId: row.id,
        },
        tx,
      );

      await this.wallets.post(
        {
          userId,
          currency,
          kind: 'main',
          amount,
          entryType: 'transfer',
          referenceType: LEDGER_REFERENCE.ibTransfer,
          referenceId: row.id,
        },
        tx,
      );

      /*
       * The two balances read back INSIDE the transaction, after both posts.
       *
       * The caller's next action is to render them, and re-reading afterwards
       * would race the confirm loop crediting a commission between the two
       * queries — showing a partner a commission balance that does not match the
       * transfer they just made. Both figures come from the same committed
       * state as the movement that produced them.
       */
      const [commissionAfter] = await tx
        .select()
        .from(wallets)
        .where(eq(wallets.id, source.id))
        .limit(1);
      const [mainAfter] = await tx
        .select()
        .from(wallets)
        .where(eq(wallets.id, destination.id))
        .limit(1);

      return {
        id: row.id,
        amount: money(amount),
        currency,
        commissionBalance: money(commissionAfter?.balance ?? '0'),
        mainBalance: money(mainAfter?.balance ?? '0'),
        createdAt: row.createdAt,
      };
    });
  }

  /**
   * This partner's commission transfers, newest first.
   *
   * A short, unpaged list. It exists so the partner screen can show the last few
   * movements beside the balance they explain — the full history is in
   * `/transactions`, which carries these rows alongside every other movement
   * rather than in a partner-only silo.
   */
  async listTransfers(userId: string, limit = 200): Promise<IbWalletTransferResultDto[]> {
    /*
     * ── WHICH WALLETS the money moved between ────────────────────────────────
     *
     * By NUMBER, not by uuid. `wallets.wallet_number` (0090) is the short
     * identifier a partner sees on their own wallet screen and quotes to
     * support; a uuid is neither readable nor quotable, and putting one in a
     * table column asks the reader to match 36 characters by eye.
     *
     * Both ends are named rather than just the destination, because "moved to
     * your wallet" is only half the sentence — a partner holding commission
     * wallets in two currencies needs to know which one it came OUT of.
     *
     * LEFT joins: a wallet is `ON DELETE RESTRICT` so it cannot vanish under a
     * transfer, but an inner join here would make a future schema change able to
     * drop rows out of a money history, which is the one thing this list must
     * never do quietly.
     */
    const fromWallet = aliasedTable(wallets, 'from_wallet');
    const toWallet = aliasedTable(wallets, 'to_wallet');

    const rows = await this.db
      .select({
        transfer: ibWalletTransfers,
        fromWalletNumber: fromWallet.walletNumber,
        toWalletNumber: toWallet.walletNumber,
      })
      .from(ibWalletTransfers)
      .leftJoin(fromWallet, eq(fromWallet.id, ibWalletTransfers.fromWalletId))
      .leftJoin(toWallet, eq(toWallet.id, ibWalletTransfers.toWalletId))
      .where(eq(ibWalletTransfers.userId, userId))
      .orderBy(desc(ibWalletTransfers.createdAt), desc(ibWalletTransfers.id))
      .limit(limit);

    /*
     * `commissionBalance` and `mainBalance` are the balances AT THE TIME of each
     * transfer, and this list does not have them — `ledger_entries.balance_after`
     * does, but joining twice per row to restate a historical balance beside a
     * historical amount invites a reader to treat the newest one as current.
     *
     * They are omitted rather than filled with today's figures. The DTO marks
     * both optional and says why; a screen showing this list shows the amount and
     * the date, which is what a history is.
     */
    return rows.map((row) => ({
      id: row.transfer.id,
      amount: new Decimal(row.transfer.amount).toFixed(8),
      currency: row.transfer.currency,
      fromWalletNumber: row.fromWalletNumber ?? null,
      toWalletNumber: row.toWalletNumber ?? null,
      createdAt: row.transfer.createdAt,
    }));
  }
}
