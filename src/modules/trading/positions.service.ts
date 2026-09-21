import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db } from '../../database/db';
import { positions, tradingAccounts, tradingProducts } from '../../database/schema';
import {
  COMMISSION_ACCRUAL,
  type CommissionAccrualPort,
} from '../../common/provisioning/commission-accrual.port';
import { NotFoundError, ValidationError } from '../../common/errors/domain-errors';
import { brokerRevenueFor } from './broker-revenue';
import { basisCountsSpread } from '../../common/revenue-basis';
import { DEFAULT_REVENUE_BASIS } from '../../common/revenue-basis';

/**
 * Open positions, and what happens when one closes.
 *
 * ## Why closing is a SERVICE and not an UPDATE
 *
 * Closing a position is the moment the broker's revenue on that trade becomes
 * final, and therefore the moment a partner earns. Anything that can close a
 * position without paying the partner is a silent underpayment — so the two are
 * one method, and the accrual is not optional.
 *
 * The deal feed is not built yet; when it is, it calls `close` rather than
 * writing the row, for exactly that reason.
 *
 * ## What the broker earns, and what it does not
 *
 * `brokerRevenue` is COMMISSION + SWAP: the two amounts the house actually
 * keeps. It is emphatically not the client's profit — a client winning does not
 * cost the partner their commission, and a client losing does not enrich them.
 * Tying partner pay to client losses is the incentive nobody should build.
 *
 * Both are stored as they arrive from the platform, where a charge to the
 * client is NEGATIVE. `brokerRevenueOf` turns that into what the house kept,
 * flooring each leg at zero separately — a swap credited TO the client is
 * revenue the house did not keep, and must neither count toward the base nor
 * cancel the commission charged alongside it.
 */
@Injectable()
export class PositionsService {
  private readonly logger = new Logger(PositionsService.name);

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Db,
    @Inject(COMMISSION_ACCRUAL) private readonly commissions: CommissionAccrualPort,
  ) {}

  /** Every open position on one client's accounts, newest first. */
  async openFor(userId: string) {
    return await this.db
      .select()
      .from(positions)
      .where(and(eq(positions.userId, userId), eq(positions.status, 'open')))
      .orderBy(positions.openedAt);
  }

  async open(input: {
    userId: string;
    tradingAccountId: string;
    ticket: string;
    symbol: string;
    side: 'buy' | 'sell';
    volume: string;
    openPrice: string;
    currency: string;
  }) {
    const [account] = await this.db
      .select({ id: tradingAccounts.id, userId: tradingAccounts.userId })
      .from(tradingAccounts)
      .where(eq(tradingAccounts.id, input.tradingAccountId))
      .limit(1);

    if (!account) throw new NotFoundError('Trading account not found.');
    /*
     * The account must belong to the client the position is being opened for.
     * Without this, a caller could hang a position off somebody else's account
     * and the commission would be paid to the wrong partner — the attribution
     * is read from the position's `userId`.
     */
    if (account.userId !== input.userId) {
      throw new ValidationError('That trading account belongs to a different client.');
    }

    const [row] = await this.db
      .insert(positions)
      .values({ ...input, status: 'open', openedAt: new Date() })
      .returning();

    return row;
  }

  /** Move the live numbers on an open position. Pays nobody — nothing is final. */
  async update(
    positionId: string,
    changes: { closePrice?: string; profit?: string; swap?: string; commission?: string },
  ) {
    const [row] = await this.db
      .update(positions)
      .set({ ...changes, updatedAt: new Date() })
      .where(and(eq(positions.id, positionId), eq(positions.status, 'open')))
      .returning();

    if (!row) throw new NotFoundError('No open position with that id.');
    return row;
  }

  /**
   * Close a position and accrue whatever partners are owed on it.
   *
   * The accrual is awaited but its failure does NOT fail the close: by the time
   * it runs the trade is over and the client's balance is already what it is.
   * A commission problem is recoverable — the accrual can be replayed, and the
   * port's own contract is that it never throws — where a close rolled back
   * because a partner could not be paid is a position that reopens itself.
   */
  async close(
    positionId: string,
    final: { closePrice: string; profit: string; swap: string; commission: string },
  ) {
    const [row] = await this.db
      .update(positions)
      .set({ ...final, status: 'closed', closedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(positions.id, positionId), eq(positions.status, 'open')))
      .returning();

    /*
     * CONDITIONAL on it still being open, so the check and the write are one
     * statement. Two closes racing cannot both succeed, and the second is a
     * no-op rather than a second accrual for one trade.
     */
    if (!row) throw new NotFoundError('No open position with that id.');

    /*
     * ── A DEMO POSITION PAYS NOBODY ──────────────────────────────────────
     *
     * The same hole the deal feed carried, closed in the same breath and for
     * the same reason: a demo account trades PRACTICE money, so the house earns
     * nothing on it and there is no revenue to share. Accruing here would mint
     * a partner commission and a client rebate — credited into real wallets as
     * withdrawable balance — out of a trade that moved no money at all.
     *
     * This path is DORMANT today (`LIVE_REVENUE_FEED` is `deal`, so the accrual
     * below refuses), and fixing it anyway is the point. The day somebody flips
     * that constant, a guard missing here is the live bug returning through the
     * other door — and it would arrive with the feed migration, when attention
     * is on the id space rather than on which accounts are allowed to pay.
     * That is precisely the trap the basis note below this one warns about.
     *
     * BEFORE the pricing work rather than after it: a demo trade must not be
     * able to fail a close by being unpriceable. `revenue.ok` throws on an
     * account linked to no product, and refusing to close a practice position
     * over a product link nobody needs would be a worse bug than the one this
     * prevents.
     *
     * `!== 'live'`, matching `TransfersService`, `TransactionsService` and
     * `AdminMoneyService`: the enum may grow, and a value nobody has considered
     * yet must not default to paying out.
     */
    const [account] = await this.db
      .select({ environment: tradingAccounts.environment })
      .from(tradingAccounts)
      .where(eq(tradingAccounts.id, row.tradingAccountId))
      .limit(1);

    if (account && account.environment !== 'live') {
      this.logger.log(
        `Position ${row.ticket} closed on a ${account.environment} account: no commission accrued, ` +
          `because practice money earns the house nothing to share.`,
      );
      return row;
    }

    /*
     * ── The basis applies HERE TOO, and that is not decoration ────────────
     *
     * This path is dormant: `LIVE_REVENUE_FEED` is `deal`, so the accrual below
     * refuses and nothing writes `positions` anyway. It would therefore have
     * been easy to leave this computing `commission + swap` directly.
     *
     * That is exactly the trap the deal feed's own notes warn about. The day
     * somebody flips the feed to `position`, a hardcoded base here would
     * silently ignore a repricing an operator had already made and audited —
     * two paths paying two different amounts for one trade, which is the failure
     * `brokerRevenueOf` was extracted into a function to prevent in the first
     * place. `brokerRevenueFor` takes the basis and the markup as required
     * arguments so that a call site cannot inherit the old pricing by omission.
     */
    const basis = DEFAULT_REVENUE_BASIS;

    /*
     * Looked up ONLY when the basis needs it. A dormant path should not pay for
     * a join on every close to satisfy a setting nobody has switched on — and
     * under the default the markup is not read at all, so a missing product
     * link cannot refuse a close that would otherwise have succeeded.
     */
    const spreadMarkupPerLot = basisCountsSpread(basis)
      ? await this.markupFor(row.tradingAccountId)
      : null;

    const revenue = brokerRevenueFor({
      basis,
      legs: [{ commission: row.commission ?? '0', swap: row.swap ?? '0' }],
      lots: row.volume,
      spreadMarkupPerLot,
    });

    /*
     * A close is a CLIENT-FACING write that has already happened — the row above
     * is updated and committed logic-wise — so an unpriceable trade must not
     * take the close down with it. It throws a ValidationError naming the
     * missing link, which is the same shape every other refusal on this path
     * takes, rather than a 500 that says nothing an operator can act on.
     */
    if (!revenue.ok) throw new ValidationError(revenue.reason);

    const brokerRevenue = revenue.revenue;

    const accrued = await this.commissions.accrueForClosedPosition({
      positionId: row.id,
      clientUserId: row.userId,
      brokerRevenue,
      lots: row.volume,
      currency: row.currency,
    });

    if (accrued > 0) {
      this.logger.log(
        `Position ${row.ticket} closed: broker revenue ${brokerRevenue} ${row.currency}, ` +
          `${accrued} accrual(s) written.`,
      );
    }

    return row;
  }

  /**
   * The spread markup the account's product is sold on, or `null` when the
   * account is linked to no product.
   *
   * `null` is deliberately NOT collapsed to `'0'`. Zero is a real markup — a
   * raw-spread product carries none — and a missing product link is a
   * configuration hole. Returning zero for both would price an unconfigured
   * account at nothing and pay a partner nothing, silently, which is the one
   * answer this whole module is built to avoid.
   */
  private async markupFor(tradingAccountId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ spreadMarkupPerLot: tradingProducts.spreadMarkupPerLot })
      .from(tradingAccounts)
      .innerJoin(tradingProducts, eq(tradingProducts.id, tradingAccounts.productId))
      .where(eq(tradingAccounts.id, tradingAccountId))
      .limit(1);

    return row?.spreadMarkupPerLot ?? null;
  }
}
