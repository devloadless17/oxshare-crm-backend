import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DealCommissionService } from './deal-commission.service';
import { pendingMigrationHint } from '../../../common/logging/pending-migration';

/**
 * Drains the deal → commission queue, on a schedule.
 *
 * ## Why a minute
 *
 * Not for latency. `confirmPending` holds every accrual for its maturation
 * window — a day by default — so a deal accrued sixty seconds later is paid at
 * exactly the same moment as one accrued instantly. What the frequency buys is
 * a SHORT retry loop: a deal that fails on a database blip, or one waiting on
 * an account link, is reconsidered a minute later instead of an hour later, and
 * the backlog number an operator is looking at is never badly out of date.
 *
 * The query behind it is an indexed read of a partial index over the
 * unprocessed set, which is empty most minutes. Settable via
 * `IB_DEAL_ACCRUAL_CRON` for a deployment that wants it quieter.
 *
 * ## The frequency is not a correctness control
 *
 * Running this hourly instead would delay accruals and change no amount. What
 * is owed is decided by the ladder and the per-deal idempotency guard, and a
 * deal that is not reached stays queued rather than being skipped. That is what
 * makes it safe to slow down, safe to run on every instance, and safe to move
 * onto BullMQ later without touching the logic.
 */
@Injectable()
export class DealCommissionScheduler {
  private readonly logger = new Logger(DealCommissionScheduler.name);

  /**
   * What the orphan warning last said, and when.
   *
   * An orphan backlog is not self-clearing: it waits on a human linking an
   * account, and some logins — a manager's own, a broker-side test account —
   * are never going to be linked at all. Warning on every run turns that into a
   * line a minute forever, which is precisely how the one message in this file
   * that NEEDS reading becomes the one nobody reads. The quiet path a few lines
   * up already refuses to log for exactly this reason; this is the same rule
   * applied to a condition that persists instead of repeating.
   */
  private lastOrphanWarn: { count: number; at: number } | null = null;

  constructor(private readonly deals: DealCommissionService) {}

  /*
   * `process.env` rather than ConfigService, for the reason `CommissionScheduler`
   * records: a decorator argument is evaluated when the class is DEFINED, before
   * any container exists to ask.
   */
  @Cron(process.env.IB_DEAL_ACCRUAL_CRON ?? CronExpression.EVERY_MINUTE, {
    name: 'ib.accrueDeals',
  })
  async accrue(): Promise<void> {
    try {
      const run = await this.deals.accruePending();

      /*
       * The quiet path, and the common one once a backlog has drained. Logged at
       * nothing rather than at info: a line every minute saying "no deals" is
       * how a log stops being read.
       */
      if (run.examined === 0) return;

      if (run.accrued > 0) {
        this.logger.log(
          `Accrued commission on ${run.accrued} deal(s): ${run.accrualRows} accrual row(s) written.`,
        );
      }

      if (run.failed > 0) {
        this.logger.warn(
          `${run.failed} deal(s) could not be accrued and remain queued; the next run retries ` +
            'them. Nothing is lost — the deals are the record, and the accrual is idempotent.',
        );
      }

      /*
       * ── The number that actually needs a human ───────────────────────────
       *
       * A processing backlog drains itself. An ORPHAN backlog does not: those
       * are deals against MT5 logins no `trading_accounts` row claims, and they
       * sit unpaid until somebody links the account. Nothing else in the system
       * would ever say so — ingestion warns once, when the deal arrives, and
       * that line is long gone by the time it matters.
       *
       * Reported only when the batch actually contained one, so a healthy
       * system stays silent.
       */
      if (run.orphaned > 0) {
        const waiting = await this.deals.orphanBacklog();

        /*
         * Said when the NUMBER changes, and otherwise at most hourly.
         *
         * A change is news — a new orphan arrived, or somebody linked an account
         * and cleared some. An unchanged count is the same fact as a minute ago,
         * and repeating it buries the run that actually differs.
         */
        const changed = this.lastOrphanWarn?.count !== waiting;
        const stale = Date.now() - (this.lastOrphanWarn?.at ?? 0) >= 3_600_000;

        if (changed || stale) {
          this.lastOrphanWarn = { count: waiting, at: Date.now() };
          this.logger.warn(
            `${waiting} ingested deal(s) belong to MT5 logins no trading account claims, so ` +
              'nobody can be paid for them yet. They accrue automatically once the account is ' +
              'linked — no backfill needed. Repeated hourly while the number holds steady.',
          );
        }
      } else if (this.lastOrphanWarn) {
        // Cleared. Worth one line, because it closes the warning above rather
        // than leaving the reader to notice an absence.
        this.logger.log(
          'The orphaned-deal backlog is clear; every ingested deal has been assessed.',
        );
        this.lastOrphanWarn = null;
      }

      /*
       * A full batch means there is more behind it. Said out loud because the
       * alternative is an operator reading "accrued 200 deals" every minute for
       * an hour with no way to tell whether it is catching up or falling behind.
       */
      if (run.examined >= 200) {
        this.logger.log(`Batch was full; ${await this.deals.backlog()} deal(s) still queued.`);
      }
    } catch (error) {
      /*
       * Per-deal failures are already isolated inside the service, so reaching
       * here means the RUN could not start — a database outage rather than a bad
       * deal. Every deal stays unmarked, which is the correct state: the next
       * run picks up exactly where this one did not begin.
       */
      this.logger.error(
        'The deal accrual job could not RUN. Every ingested deal remains queued and accruable ' +
          `on the next run: ${error instanceof Error ? error.message : String(error)}` +
          pendingMigrationHint(error),
      );
    }
  }
}
