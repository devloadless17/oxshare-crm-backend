import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { CommissionService } from './commission.service';
import { ALERT_KINDS, raiseAlert } from '../../common/logging/alerts';
import { JobLeaseService } from '../../common/scheduling/job-lease.service';
import { AppSettingsStore } from '../../store/app-settings.store';
import { tradingTermsFrom } from '../../common/trading-terms';

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
/**
 * How long one run may spend draining — a FRACTION of the interval, not a fixed
 * five minutes (0113).
 *
 * It was five minutes, chosen to sit well under the hourly default. That number
 * cannot survive a configurable period: at a 60-second interval a five-minute
 * budget guarantees every run outlives its own tick, and stacked runs contend
 * for the same rows to reach the outcome one of them would have reached alone.
 *
 * Half, so a run has finished and released its lease before the next is due.
 */
const BUDGET_FRACTION = 0.5;

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
export class CommissionScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(CommissionScheduler.name);

  /** The pending tick, so shutdown can cancel it rather than leaking a timer. */
  private timer: NodeJS.Timeout | null = null;
  /** Set on destroy, so a run finishing after shutdown does not reschedule. */
  private stopped = false;

  constructor(
    private readonly commissions: CommissionService,
    private readonly leases: JobLeaseService,
    private readonly settings: AppSettingsStore,
  ) {}

  onApplicationBootstrap(): void {
    this.scheduleNext();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /**
   * The configured period, re-read on EVERY tick.
   *
   * A bad row falls back to the default rather than the minimum — see
   * `normaliseIbCommissionInterval`. The failure mode of a corrupt settings row
   * must not be "run every minute forever".
   */
  private async intervalMs(): Promise<number> {
    try {
      return tradingTermsFrom(await this.settings.getTrading()).ibCommissionIntervalSeconds * 1_000;
    } catch (error) {
      /*
       * The database being unreachable must not stop the loop permanently. Fall
       * back to an hour and try again on the next tick — a scheduler that
       * unschedules itself on one failed read is a job that silently never runs
       * again, which is the failure this whole file is shaped to avoid.
       */
      this.logger.warn(
        `Could not read the commission interval; using 1h for this tick: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return 3_600_000;
    }
  }

  /**
   * A self-rescheduling timer, NOT `@Cron`.
   *
   * ⚠️ THIS IS DELIBERATE AND `app.module.ts` EXPLAINS WHY IN DETAIL. A
   * decorator argument is evaluated when the class is DEFINED — before any
   * container exists, before `ConfigModule` has read anything, and long before
   * a settings row can be queried. `@Cron(someSetting)` cannot work: it would
   * silently register the hardcoded default while the screen showed something
   * else, which is exactly the bug that file records as having shipped twice.
   *
   * `setTimeout` rather than `setInterval` for the other half: the next tick is
   * scheduled only once the previous run has FINISHED, so a slow drain delays
   * the next run instead of stacking on top of it.
   *
   * The interval is re-read each tick, so a change on the settings form takes
   * effect on the next run rather than at the next deploy.
   */
  private scheduleNext(): void {
    if (this.stopped) return;

    void this.intervalMs().then((ms) => {
      if (this.stopped) return;
      this.timer = setTimeout(() => {
        void this.tick();
      }, ms);
      /* Do not hold the process open for a payout that can wait. */
      this.timer.unref?.();
    });
  }

  private async tick(): Promise<void> {
    try {
      await this.confirm();
    } finally {
      /* ALWAYS reschedule, even after a throw. A loop that stops on error is a
         platform that quietly stops paying partners. */
      this.scheduleNext();
    }
  }

  /**
   * One payout run.
   *
   * The frequency is not a correctness control. Running every four hours rather
   * than every minute delays a payout; it cannot pay the wrong amount, because
   * what is payable is decided by the maturation window in the service and by
   * the per-accrual idempotency guard, not by how often this fires.
   *
   * Public because it is the whole job, and calling it directly is how a test
   * exercises one run without waiting on a timer.
   */
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
    const budgetMs = (await this.intervalMs()) * BUDGET_FRACTION;
    await this.leases.run('ib.confirmAccruals', 2 * budgetMs, async () => {
      // Recorded for Settings → Scheduled jobs (0167); never breaks the run.
      const startedAt = new Date();
      try {
        await this.runOnce(budgetMs);
        await this.recordRun(startedAt);
      } catch (error) {
        await this.recordRun(startedAt, error);
        throw error;
      }
    });
  }

  /** The run's status line — a stub store in a spec has no such method, hence the guard. */
  private async recordRun(startedAt: Date, error?: unknown): Promise<void> {
    try {
      await this.settings.recordJobRun(
        'ib.confirmAccruals',
        startedAt,
        error === undefined
          ? undefined
          : error instanceof Error
            ? error.message
            : JSON.stringify(error),
      );
    } catch {
      /* a status line must not break the payout it describes */
    }
  }

  private async runOnce(budgetMs: number): Promise<void> {
    try {
      const { confirmed, failed, held } = await this.drain(budgetMs);
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
  private async drain(
    budgetMs: number,
  ): Promise<{ confirmed: number; failed: number; held: number }> {
    const startedAt = Date.now();
    let confirmed = 0;
    let failed = 0;
    let held = 0;
    let batches = 0;

    for (;;) {
      /*
       * Rows that already failed in THIS run are skipped, so a queue of
       * nothing but failures empties into a short batch and stops, rather than
       * re-trying the same rows until the budget runs out (0180).
       */
      const run = await this.commissions.confirmPending(CONFIRM_BATCH, new Date(startedAt));
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

      if (Date.now() - startedAt >= budgetMs) {
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
          `The commission confirm run hit its ${Math.round(budgetMs / 1000)}s budget with the ` +
            `queue still full: ${confirmed} credited across ${batches} batches and more were due. ` +
            'Accruals are being earned faster than they are being credited, so the unpaid backlog ' +
            'is growing. Shorten the commission interval on the Trading settings tab, or give ' +
            'the platform more capacity.',
          { confirmed, failed, batches },
        );
        break;
      }
    }

    return { confirmed, failed, held };
  }
}
