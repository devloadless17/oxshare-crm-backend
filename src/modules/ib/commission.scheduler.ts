import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CommissionService } from './commission.service';
import { ALERT_KINDS, raiseAlert } from '../../common/logging/alerts';
import { JobLeaseService } from '../../common/scheduling/job-lease.service';

/**
 * One bite of the queue. Small on purpose — see `drain`.
 *
 * Each batch is its own set of per-accrual transactions, so an interrupted run
 * keeps everything it already paid and a restart resumes from the queue.
 */
const CONFIRM_BATCH = 500;

/**
 * How long one run may spend draining, well under the default hourly interval.
 *
 * A budget rather than a batch ceiling: a quiet hour stops after one batch, and
 * a backlog gets the whole budget without anybody choosing a magic number. Under
 * the interval because a run that outlives its own cron stacks up, and stacked
 * runs contend for the same rows — correctly, and slower than running once.
 */
const CONFIRM_TIME_BUDGET_MS = 5 * 60_000;

/**
 * Pays out matured commission accruals, on a schedule.
 *
 * ## Why a job rather than crediting at accrual time
 *
 * `CommissionService` writes `pending` rows when a deposit settles and moves no
 * money. This is what turns them into balance. The separation is deliberate —
 * see the service's own note — because a commission is earned at one moment and
 * payable at another, and crediting both at once makes every commission
 * irreversible before the revenue behind it is final.
 *
 * ## Hourly, and safe to run on every instance
 *
 * The work is idempotent all the way down: each credit is guarded by
 * `ledger_entries_wallet_reference_uq` and each status write is conditional on
 * the row still being `pending`. Two schedulers racing over the same accrual
 * cannot both pay it — the second finds nothing to update and `post` returns the
 * original entry rather than a second credit.
 *
 * That is what makes this safe to keep as a `@Cron` today and safe to move onto
 * BullMQ later without changing the logic: at-least-once delivery is already the
 * assumption.
 *
 * ## A failure here is not urgent, and the log says so
 *
 * An unpaid accrual is money still owed and still recorded — the row survives
 * and the next run retries it. That is a materially smaller problem than the
 * reconciliation job failing, which leaves the ledger UNCHECKED, so this logs
 * rather than raising an alert.
 */
@Injectable()
export class CommissionScheduler {
  private readonly logger = new Logger(CommissionScheduler.name);

  constructor(
    private readonly commissions: CommissionService,
    private readonly leases: JobLeaseService,
  ) {}

  /*
   * HOURLY by default, and settable — a broker running a four-hourly desk sets
   * IB_COMMISSION_CONFIRM_CRON and gets a four-hourly payout run.
   *
   * Read from `process.env` rather than injected, because a decorator argument
   * is evaluated when the class is DEFINED, before any container exists. That
   * is the one place in this codebase where reaching for process.env directly
   * is not a shortcut — ConfigService cannot be asked this early.
   *
   * The frequency is not a correctness control. Running it every four hours
   * rather than every hour delays a payout; it cannot pay the wrong amount,
   * because what is payable is decided by the hold window in the service and
   * by the per-accrual idempotency guard, not by how often this fires.
   */
  @Cron(process.env.IB_COMMISSION_CONFIRM_CRON ?? CronExpression.EVERY_HOUR, {
    name: 'ib.confirmAccruals',
  })
  async confirm(): Promise<void> {
    /*
     * ONE INSTANCE, not all of them. `@Cron` fires everywhere, and this job now
     * drains for up to five minutes — so on four replicas that is four
     * simultaneous drains of the same queue, contending on the same rows to
     * reach the outcome one of them would have reached alone.
     *
     * The TTL is DOUBLE the drain budget. It is only the crash backstop, and if
     * it were shorter than the work a second instance would start while the
     * first was still paying partners — the duplicate run this removes.
     */
    await this.leases.run('ib.confirmAccruals', 2 * CONFIRM_TIME_BUDGET_MS, () => this.runOnce());
  }

  private async runOnce(): Promise<void> {
    try {
      const { confirmed, failed, held } = await this.drain();
      if (failed > 0) {
        this.logger.warn(
          `${failed} commission accrual(s) could not be credited and remain pending; they will be ` +
            'retried on the next run. Nothing is lost — the accrual rows are the record.',
        );
      }
      if (confirmed > 0) {
        this.logger.log(`Credited ${confirmed} commission accrual(s).`);
      }
      /*
       * Reported even when nothing was paid, because "0 credited" has two very
       * different causes — nobody earned anything, or everything earned is
       * still inside its maturation window — and an operator watching this log
       * would otherwise read the second as the engine having stopped.
       */
      if (confirmed === 0 && held > 0) {
        this.logger.log(`Nothing due yet: ${held} accrual(s) still maturing.`);
      }
    } catch (error) {
      /*
       * The batch method already isolates per-accrual failures, so reaching here
       * means the RUN itself could not start — a database outage rather than a
       * bad row. Every accrual stays pending, which is the correct state.
       */
      this.logger.error(
        'The commission confirm job could not RUN. Every accrual remains pending and payable on ' +
          `the next run: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Drain the payable queue, instead of taking one bite out of it.
   *
   * ## The ceiling this removes
   *
   * `confirmPending` takes a batch — 500 by default — and the job called it
   * ONCE per run. Hourly, that is a hard ceiling of 500 credited accruals per
   * hour, roughly 12,000 a day, no matter how much was earned.
   *
   * That is fine for a broker with a handful of partners and catastrophic at
   * the size this platform is planned for. 100k clients holding two MT5
   * accounts each, trading once a day, produce hundreds of thousands of
   * accruals a day — a commission leg, a second for an L2 partner, a rebate for
   * the client. Against 12,000 drained, the queue grows by an order of
   * magnitude more than it sheds, every day, permanently. Partners stop being
   * paid and nothing in the system says so: the run reports "500 credited" and
   * looks like it is working.
   *
   * ## Bounded by TIME, not by a batch count
   *
   * A bigger number would move the ceiling rather than remove it, and would
   * still be wrong on a day nobody predicted. A wall-clock budget adapts: a
   * quiet hour drains in one batch and stops, and a backlog gets the whole
   * budget without a person choosing a magic number.
   *
   * The budget is well under the interval on purpose. `confirmPending` is
   * idempotent per accrual and safe to overlap, but a run that outlives its own
   * cron stacks up, and stacked runs contend for the same rows — correctly, and
   * slower than running once.
   *
   * Batches stay SMALL rather than one enormous query: each is its own set of
   * per-accrual transactions, so an interrupted run has still paid everything
   * it got through, and a restart resumes from the queue rather than from the
   * start.
   */
  private async drain(): Promise<{ confirmed: number; failed: number; held: number }> {
    const startedAt = Date.now();
    let confirmed = 0;
    let failed = 0;
    let held = 0;
    let batches = 0;

    for (;;) {
      const run = await this.commissions.confirmPending(CONFIRM_BATCH);
      confirmed += run.confirmed;
      failed += run.failed;
      /* The LAST reading wins: "still maturing" is a live count, not a total to
         add up across batches. */
      held = run.held;
      batches += 1;

      /*
       * A short batch means the queue is empty of DUE rows. Anything left is
       * either still maturing or was counted in `failed`, and neither is fixed
       * by asking again in the same run.
       */
      if (run.confirmed + run.failed < CONFIRM_BATCH) break;

      if (Date.now() - startedAt >= CONFIRM_TIME_BUDGET_MS) {
        /*
         * ── THE QUEUE IS WINNING, AND THIS IS THE ONLY PLACE THAT KNOWS ─────
         *
         * Reaching the budget with a full batch every time means the platform
         * is earning commission faster than this job credits it. Left alone
         * that is invisible — every run reports a healthy number of payments
         * while the unpaid pile grows behind it, and the first symptom is a
         * partner asking where their money is.
         *
         * Not a `page`: nothing is lost, the accruals are the record, and the
         * fix is a capacity decision made in working hours — a shorter cron, a
         * bigger budget, or the queue this job is designed to become.
         */
        raiseAlert(
          this.logger,
          ALERT_KINDS.COMMISSION_QUEUE_STALLED,
          'notify',
          `The commission confirm run hit its ${CONFIRM_TIME_BUDGET_MS / 1000}s budget with the ` +
            `queue still full: ${confirmed} credited across ${batches} batches and more were due. ` +
            'Accruals are being earned faster than they are being credited, so the unpaid backlog ' +
            'is growing. Shorten IB_COMMISSION_CONFIRM_CRON or raise the budget.',
          { confirmed, failed, batches },
        );
        break;
      }
    }

    return { confirmed, failed, held };
  }
}
