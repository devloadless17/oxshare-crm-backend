import { Inject, Injectable, Logger } from '@nestjs/common';
import Decimal from 'decimal.js';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../../database/database.module';
import type { Db } from '../../../database/db';
import { mt5Deals, tradingAccounts } from '../../../database/schema';
import {
  COMMISSION_ACCRUAL,
  CommissionRefusedError,
  type CommissionAccrualPort,
} from '../../../common/provisioning/commission-accrual.port';
import { brokerRevenueOf } from '../broker-revenue';
import { isClosingEntry, isTradeAction } from './deal-codes';

/** What one drain of the queue did. Every deal lands in exactly one bucket. */
export interface DealAccrualRun {
  /** Rows the query returned — the size of the batch, not of the backlog. */
  examined: number;
  /** Deals that produced at least one accrual row. */
  accrued: number;
  /** `ib_accruals` rows created across the batch. */
  accrualRows: number;
  /** Deals correctly worth nothing: not a trade, no revenue, nobody referred. */
  nothingOwed: number;
  /**
   * Opening deals held until their position closes — FR-IB-04.
   *
   * Left UNPROCESSED on purpose: their revenue is paid by the closing deal that
   * consumes them, so marking them here would discard the open leg's
   * commission. A position that never closes keeps its opener in this count,
   * which is the honest reading — nothing is owed on a trade still running.
   */
  awaitingClose: number;
  /** Deals whose login matches no trading account. Left for the next run. */
  orphaned: number;
  /** Deals the engine refused or could not process. Left for the next run. */
  failed: number;
}

/**
 * Turns ingested MT5 deals into commission accruals — the seam ARCHITECTURE
 * §3.1 assumed and nothing implemented.
 *
 * ## What this closes
 *
 * `Mt5DealsService` stored deals and stopped. `CommissionService` accrued on
 * `PositionsService.close`, which no controller and no service ever called. So
 * `mt5_deals` had exactly one writer and no readers, `positions` had no writer
 * at all, and the hourly confirm job ran against a table nothing filled. Every
 * stage reported success — the webhook answered 200, ingestion logged the
 * ticket, the confirm job logged "0 credited" — and no partner could have
 * earned anything, on any trade, by any route. This is the missing link, and it
 * is the only path in the system that currently produces revenue-based pay.
 *
 * ## A drained QUEUE, not a hook on ingestion
 *
 * Accruing inside `Mt5DealsService.ingest` would put ladder resolution and
 * several writes inside the request the bridge is waiting on, and the bridge
 * retries anything that is not a 2xx — so a slow commission path would turn
 * into re-delivered deals, which is load added exactly when the system is
 * already struggling.
 *
 * More decisively, it could not be correct. A deal for a login the CRM has not
 * linked yet accrues NOTHING at ingest time and must be reconsidered later;
 * that ordering is normal during onboarding. A hook would have to drop it. A
 * queue simply leaves `commission_processed_at` NULL and finds it again once
 * the account exists — which is the promise `Mt5DealsService`'s docblock has
 * been making all along.
 *
 * ## Every deal, not just closing ones
 *
 * The broker charges commission when a position OPENS as well as when it
 * closes. Accruing only on closing deals silently pays every partner less than
 * they earned, by the entry half of every round turn — and nothing in the
 * system would report a discrepancy, because both halves look like successful
 * runs. So each deal is assessed on its own revenue and the round turn adds up
 * on its own.
 *
 * Non-trade deals — balance operations, credits, corrections — carry no
 * commission or swap of their own and are marked done without accruing. They
 * are excluded by `isTradeAction` rather than by their zero amounts, because
 * "this is not a trade" and "this trade earned nothing" are different facts and
 * only the first is safe to assume from an action code.
 *
 * ## ⚠️ A dealer-CANCELLED trade is not clawed back, and that is deliberate
 *
 * `isTradeAction` excludes DEAL_BUY_CANCELED and DEAL_SELL_CANCELED, so a
 * cancellation accrues nothing — but it does not reverse an accrual already
 * written against the deal it cancels. If the accrual is still `pending` the
 * money has not moved and a desk can void it; once `confirmPending` has
 * credited it, undoing it needs a compensating entry.
 *
 * Not automated here, on the reasoning `ib_accruals` already records: "a
 * clawback is a REVERSAL of the row, not a negative accrual", and the table's
 * own `amount > 0` check enforces that. A reversal moves money out of a
 * partner's wallet, which is a decision with a person behind it — not something
 * a feed should do because a code arrived. Worth building deliberately if
 * cancellations turn out to be common on this broker's server.
 */
@Injectable()
export class DealCommissionService {
  private readonly logger = new Logger(DealCommissionService.name);

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Db,
    /*
     * The port, not `CommissionService` — `IbModule` is @Global and binds it.
     * Importing IbModule here would create trading → ib while ib already needs
     * the wallet side to pay commissions out; see the port's own note.
     */
    @Inject(COMMISSION_ACCRUAL) private readonly commissions: CommissionAccrualPort,
  ) {}

  /**
   * Accrue for one batch of unprocessed deals, oldest first.
   *
   * ## Bounded, and oldest-first, for the same reason
   *
   * A backlog is drained a batch at a time so one run cannot hold a connection
   * for minutes after an outage, and in deal order so the oldest money is
   * always the next money paid. Whatever this run does not reach stays NULL and
   * is the head of the next run's batch — there is no cursor to lose.
   *
   * ## Safe to run concurrently with itself
   *
   * Two instances racing over the same deal both call an accrual guarded by
   * `ib_accruals_source_earner_uq`, so the second creates no rows and reports
   * zero. Marking a deal processed twice writes the same value twice. Neither
   * needs a lock, which is what keeps this deployable on more than one node
   * without a leader election.
   */
  async accruePending(limit = 200): Promise<DealAccrualRun> {
    const batch = await this.db
      .select({
        id: mt5Deals.id,
        ticket: mt5Deals.mt5DealId,
        login: mt5Deals.login,
        action: mt5Deals.action,
        /* Which end of the position this deal is — see `isClosingEntry`. */
        entry: mt5Deals.entry,
        /* Nullable: not every deal MT5 reports carries one. */
        positionId: mt5Deals.mt5PositionId,
        volume: mt5Deals.volume,
        commission: mt5Deals.commission,
        swap: mt5Deals.swap,
        userId: tradingAccounts.userId,
        /*
         * The ACCOUNT's currency, because that is what MT5 denominates a deal
         * in. The deal itself carries none — the server does not repeat it on
         * every row — and defaulting to the platform currency would silently
         * accrue a EUR account's commission as USD, at par.
         */
        currency: tradingAccounts.currency,
      })
      .from(mt5Deals)
      /*
       * LEFT, so an orphan is RETURNED rather than filtered away. An inner join
       * would make a deal for an unlinked login invisible to this query and to
       * every count it produces — the backlog would be silently uncounted
       * rather than reported, which is how an unpaid partner goes unnoticed.
       */
      .leftJoin(tradingAccounts, eq(tradingAccounts.login, mt5Deals.login))
      .where(isNull(mt5Deals.commissionProcessedAt))
      .orderBy(asc(mt5Deals.dealtAt), asc(mt5Deals.id))
      .limit(limit);

    const run: DealAccrualRun = {
      examined: batch.length,
      accrued: 0,
      accrualRows: 0,
      nothingOwed: 0,
      awaitingClose: 0,
      orphaned: 0,
      failed: 0,
    };

    for (const deal of batch) {
      /*
       * Not a trade — a deposit, a credit, a correction. Nothing was earned and
       * nothing ever will be, so this is DONE rather than skipped.
       */
      if (!isTradeAction(deal.action)) {
        await this.markProcessed([deal.id]);
        run.nothingOwed += 1;
        continue;
      }

      /*
       * Left unmarked ON PURPOSE. The account may be linked minutes from now,
       * and this deal must accrue when it is — see the column's own note.
       */
      if (!deal.userId || !deal.currency) {
        run.orphaned += 1;
        continue;
      }

      /*
       * ── COMMISSION IS EARNED ON A CLOSED POSITION, NEVER ON AN OPEN ONE ──
       *
       * FR-IB-04: "compute commission on the closing of a deal — never on its
       * opening. Commission accrues only once the deal is closed."
       *
       * This used to accrue on ANY trade deal that carried revenue, which pays
       * the moment a position opens — MT5 charges its commission on the opening
       * deal as often as not. A partner was therefore paid on a position the
       * client might still be holding, and a dealer-cancelled open had already
       * produced money.
       *
       * The opener is left UNPROCESSED rather than marked done, because its
       * revenue is real and is paid by the close that consumes it below.
       */
      if (!isClosingEntry(deal.entry)) {
        run.awaitingClose += 1;
        continue;
      }

      /*
       * The revenue of the WHOLE position, not of this row.
       *
       * MT5 splits a round turn's charges across its legs however the broker
       * configured it — all on the open, all on the close, or half each — so
       * paying only the closing row's own commission would silently pay nothing
       * on the most common configuration there is.
       *
       * Summed over the position's deals that no other accrual has consumed,
       * which is what makes a PARTIAL close correct: the first close takes the
       * opener plus itself, the second takes only itself, and no leg is counted
       * twice or lost. Every row summed here is marked processed together with
       * this one.
       */
      const legs = await this.unconsumedLegs(deal);
      const brokerRevenue = legs
        .reduce((sum, leg) => sum.plus(brokerRevenueOf(leg)), new Decimal(0))
        .toFixed(8);

      /*
       * The broker kept nothing on this deal, so there is no share to take.
       * Marked done rather than retried: the amounts are final the moment MT5
       * reports them, so re-reading this row can only ever reach the same
       * answer.
       */
      if (new Decimal(brokerRevenue).isZero()) {
        await this.markProcessed(legs.map((leg) => leg.id));
        run.nothingOwed += 1;
        continue;
      }

      try {
        const rows = await this.commissions.accrueForDeal({
          dealRowId: deal.id,
          ticket: deal.ticket,
          clientUserId: deal.userId,
          brokerRevenue,
          lots: deal.volume,
          currency: deal.currency,
        });

        /*
         * Marked only AFTER the accrual returns. The reverse order loses the
         * commission on any failure between the two — and a crash between them
         * costs nothing, because the accrual is idempotent and the deal is
         * simply reconsidered.
         */
        await this.markProcessed(legs.map((leg) => leg.id));

        if (rows > 0) {
          run.accrued += 1;
          run.accrualRows += rows;
        } else {
          run.nothingOwed += 1;
        }
      } catch (error) {
        /*
         * Deliberately NOT marked, so the next run retries it.
         *
         * `accrueForDeal` throws only on a refused accrual or a database
         * failure, and neither is a reason to consider this deal finished. A
         * refusal is a settings mistake a human fixes — the ceiling alert names
         * it — and until then the deals accumulate un-accrued, which is exactly
         * what should happen: the money is still owed and still recorded.
         */
        run.failed += 1;

        /*
         * The two failures need different people. A refusal is a SETTINGS
         * problem that will fail identically on every future run until somebody
         * changes a rate; anything else is transient and the next run probably
         * fixes it by itself. Logging them the same way sends an engineer to
         * read the database while the actual fix is one field on a screen — and
         * the ceiling alert has already fired for the first case.
         */
        if (error instanceof CommissionRefusedError) {
          this.logger.error(
            `Deal ${deal.ticket} was REFUSED and stays queued; retrying will keep failing until ` +
              `the commission configuration is corrected. ${error.message}`,
          );
        } else {
          this.logger.error(
            `Deal ${deal.ticket} could not be accrued and stays queued; the next run retries it: ` +
              `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }

    return run;
  }

  /** How many deals are waiting, for the log line that makes a backlog visible. */
  async backlog(): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(mt5Deals)
      .where(isNull(mt5Deals.commissionProcessedAt));

    return row?.count ?? 0;
  }

  /**
   * How many of those are waiting on an account link rather than on this job.
   *
   * Separated because the two backlogs mean opposite things. A processing
   * backlog is this service falling behind and drains itself; an orphan backlog
   * is deals for logins nobody has linked, which will sit there forever until a
   * human connects the account — and it is the number that has to reach an
   * operator rather than a queue.
   */
  async orphanBacklog(): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(mt5Deals)
      .leftJoin(tradingAccounts, eq(tradingAccounts.login, mt5Deals.login))
      .where(and(isNull(mt5Deals.commissionProcessedAt), isNull(tradingAccounts.id)));

    return row?.count ?? 0;
  }

  /**
   * Every deal whose revenue this accrual has taken — the closing row and the
   * legs it consumed.
   *
   * A SET rather than one id, because a closing deal pays for its opener too.
   * Marking only the closing row would leave the opener unprocessed forever,
   * re-examined on every run and re-consumed by the next close on the same
   * position — which is a double payment, not a wasted read.
   */
  private async markProcessed(dealRowIds: string[]): Promise<void> {
    if (dealRowIds.length === 0) return;

    await this.db
      .update(mt5Deals)
      .set({ commissionProcessedAt: new Date() })
      .where(inArray(mt5Deals.id, dealRowIds));
  }

  /**
   * The closing deal, plus every leg of its position no accrual has taken yet.
   *
   * `commission_processed_at IS NULL` is the "not yet consumed" marker, and it
   * is the same column the batch query reads — so a leg cannot be counted by
   * two closes, and a leg that arrives late (the sweep runs 24 hours behind the
   * push feed) is still picked up by whichever close comes after it.
   *
   * A deal with NO position id falls back to itself. That is not a guess: MT5
   * does not always populate it, and the alternative — refusing to pay — would
   * lose real commission over a field the broker's server chose not to send.
   */
  private async unconsumedLegs(deal: {
    id: string;
    login: string;
    positionId: string | null;
    commission: string;
    swap: string;
  }): Promise<{ id: string; commission: string; swap: string }[]> {
    if (!deal.positionId) {
      return [{ id: deal.id, commission: deal.commission, swap: deal.swap }];
    }

    return this.db
      .select({ id: mt5Deals.id, commission: mt5Deals.commission, swap: mt5Deals.swap })
      .from(mt5Deals)
      .where(
        and(
          eq(mt5Deals.mt5PositionId, deal.positionId),
          eq(mt5Deals.login, deal.login),
          isNull(mt5Deals.commissionProcessedAt),
        ),
      );
  }
}
