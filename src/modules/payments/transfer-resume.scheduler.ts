import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { and, eq, lt } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db } from '../../database/db';
import { transfers } from '../../database/schema';
import { TransferExecutor } from './transfer-executor.service';
import { JobLeaseService } from '../../common/scheduling/job-lease.service';
import { ALERT_KINDS, raiseAlert } from '../../common/logging/alerts';

/**
 * Finishes transfers that were left pending, so a client never has to ask.
 *
 * ## The gap this closes
 *
 * `TransferExecutor` is careful in exactly the right way: when MT5 does not
 * answer, or answers with something indeterminate, it leaves the transfer
 * PENDING rather than failing it — because the deal may have posted and only
 * the response was lost, and failing would release a hold on money that has
 * already moved. Its comments say the row is "safe to finish by hand" and that
 * a later retry is safe.
 *
 * Nothing retried. There was no hand to finish it by and no job to do it, so a
 * transfer that met a restarting bridge sat pending for ever — the client saw
 * "Pending" against money that had left their wallet, with nothing in the
 * system that would ever move it on. That is the state this exists to end.
 *
 * ## Why re-running the executor is safe, and not merely likely to be
 *
 * The idempotency key is the TRANSFER ID, not a fresh UUID per attempt. That is
 * the whole reason a retry is allowed: the bridge claims the key before it calls
 * MT5 and remembers the deal id after, so a second attempt at the same transfer
 * returns the SAME deal rather than moving money twice. `settle` refuses a
 * non-pending transfer, so the CRM leg cannot double-apply either.
 *
 * Retrying without that stable key would be the single worst thing this file
 * could do. It is not a detail of the implementation; it is the precondition.
 *
 * ## What it deliberately does NOT do
 *
 * It never fails a transfer. Age is not evidence that money did not move — a
 * transfer pending for a day may have credited MT5 on its first attempt and lost
 * the response, and auto-failing it would release the hold and hand the client
 * their money twice. Old rows are logged for a human; the only two ways out
 * remain the ones the executor already owns.
 */
@Injectable()
export class TransferResumeScheduler {
  private readonly logger = new Logger(TransferResumeScheduler.name);

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Db,
    private readonly executor: TransferExecutor,
    private readonly leases: JobLeaseService,
  ) {}

  /*
   * EVERY MINUTE, and settable.
   *
   * Frequent because the common case is a transfer that met a bridge restart
   * and would have worked seconds later: the client is still on the screen, and
   * a minute is the difference between "it went through" and a support ticket.
   *
   * Read from `process.env` rather than injected — a decorator argument is
   * evaluated when the class is DEFINED, before any container exists, which is
   * the one place in this codebase where reaching for process.env directly is
   * not a shortcut. Same reasoning as `CommissionScheduler`.
   *
   * The frequency is not a correctness control. Running it less often delays a
   * settlement; it cannot settle the wrong amount, because what moves is decided
   * by the executor and the bridge's idempotency store, not by how often this
   * fires.
   */
  @Cron(process.env.TRANSFER_RESUME_CRON ?? CronExpression.EVERY_MINUTE, {
    name: 'payments.resumeTransfers',
  })
  async resume(): Promise<void> {
    /*
     * ONE INSTANCE. Safe either way — the bridge's idempotency key is the
     * transfer id, so a duplicated resume returns the SAME deal rather than
     * moving money twice — but every duplicate is a real MT5 call queued behind
     * the one session lock that client reads and reconnects also need.
     *
     * Five minutes against a one-minute cron, because a resume round waits on
     * the bridge and can outlast its own interval.
     */
    await this.leases.run('payments.resumeTransfers', 5 * 60_000, () => this.runOnce());
  }

  private async runOnce(): Promise<void> {
    try {
      /*
       * A GRACE PERIOD, so this never races the request that created the row.
       *
       * `POST /payments/transfers` executes inline; a transfer created two
       * seconds ago is probably mid-flight in that handler right now. Picking it
       * up here would put two attempts on the same transfer at once — safe,
       * because of the idempotency key, but it would log alarming things and
       * waste a call to a server we do not own.
       */
      const cutoff = new Date(Date.now() - GRACE_MS);

      const stuck = await this.db
        .select({ id: transfers.id, createdAt: transfers.createdAt })
        .from(transfers)
        .where(and(eq(transfers.state, 'pending'), lt(transfers.createdAt, cutoff)))
        /*
         * Oldest first: a client who has been waiting longest is served first,
         * and a permanently stuck row cannot starve the queue because the batch
         * is capped rather than the whole set being taken.
         */
        .orderBy(transfers.createdAt)
        .limit(BATCH);

      if (stuck.length === 0) return;

      this.logger.log(`Resuming ${stuck.length} pending transfer(s)`);

      let settled = 0;
      for (const row of stuck) {
        /*
         * ONE AT A TIME. Every attempt crosses to the MT5 bridge, which
         * serialises all of its work behind a single lock — firing a batch
         * concurrently would queue them there anyway while occupying the very
         * connection a client's own page is waiting on.
         *
         * A failure here is caught PER TRANSFER: one row that cannot be resumed
         * must not stop the rest, which is the same reason the sweep on the
         * bridge tolerates one bad account.
         */
        try {
          const result = await this.executor.execute(row.id);
          if (result?.state === 'settled') settled += 1;
        } catch (error) {
          this.logger.error(
            `Transfer ${row.id} could not be resumed: ` +
              `${error instanceof Error ? error.message : String(error)}. ` +
              'It stays pending and will be tried again.',
          );
        }
      }

      if (settled > 0) this.logger.log(`Settled ${settled} previously pending transfer(s)`);

      /*
       * ── A STUCK TRANSFER RAISES AN ALARM, IT DOES NOT JUST LOG ───────────
       *
       * This wrote a warning after SIX HOURS and that was the entire response.
       * Nothing paged, nothing notified, and the client — who is watching
       * "Processing" on their own money the whole time — was told nothing at
       * all. A log line nobody is tailing is not a response to somebody's
       * $1,000 being in an unknown state.
       *
       * It is still NOT failed, and that part was always right: the executor
       * cannot tell "MT5 refused" from "MT5 never answered", and failing a
       * transfer MT5 actually applied would hand back money that has already
       * moved. The row waits for a person; what changes is that a person is
       * now told to come.
       */
      const stale = stuck.filter((row) => Date.now() - row.createdAt.getTime() > STALE_MS);
      if (stale.length > 0) {
        raiseAlert(
          this.logger,
          ALERT_KINDS.TRANSFER_STUCK,
          'page',
          `${stale.length} transfer(s) have been pending for over ${STALE_MS / 60_000} minutes ` +
            'and are not clearing on their own. No money has moved — the wallet is debited only ' +
            'once MT5 confirms — but a client is watching a spinner. The usual cause is the MT5 ' +
            `bridge having lost its session; check GET /admin/live on it. Transfers: ${stale
              .map((row) => row.id)
              .join(', ')}`,
          { count: stale.length, oldestId: stale[0]?.id },
        );
      }
    } catch (error) {
      /*
       * The scheduler must never die. An unhandled rejection here would take the
       * job out of the container's registry for the lifetime of the process, and
       * every transfer after that would go back to sitting pending for ever —
       * the exact failure this class exists to end, reintroduced silently.
       */
      this.logger.error(
        `Transfer resume run failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/** Long enough that the creating request has finished its own attempt. */
const GRACE_MS = 30_000;

/**
 * How many to attempt per run.
 *
 * Small because each one is a round trip to the broker behind a single lock. A
 * backlog drains over several minutes rather than occupying the bridge for one
 * long run and starving the client requests sharing it.
 */
const BATCH = 10;

/**
 * Past this, a pending transfer is a person's problem rather than a retry's.
 *
 * FIFTEEN MINUTES, down from six hours. Six was chosen against "how long might
 * a normal outage last" and answered the wrong question: the resume job retries
 * every minute, so anything still pending after fifteen is not waiting out a
 * blip — it is hitting something that will not clear by itself, and the next
 * five and three-quarter hours add nothing but a client watching a spinner.
 *
 * Long enough that an ordinary bridge restart passes without paging anybody.
 */
const STALE_MS = 15 * 60 * 1000;
