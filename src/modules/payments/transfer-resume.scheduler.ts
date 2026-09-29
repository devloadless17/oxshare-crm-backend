import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { and, count, eq, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db } from '../../database/db';
import { notifications, transfers } from '../../database/schema';
import { TransferExecutor } from './transfer-executor.service';
import { JobLeaseService } from '../../common/scheduling/job-lease.service';
import { ALERT_KINDS, raiseAlert } from '../../common/logging/alerts';
import { TRANSFER_STALE_MS } from './transfer-staleness';
import {
  NOTIFICATION_DISPATCH,
  type NotificationDispatchPort,
} from '../../common/provisioning/notification-dispatch.port';

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
    @Inject(NOTIFICATION_DISPATCH) private readonly notifications: NotificationDispatchPort,
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
        .where(
          and(
            eq(transfers.state, 'pending'),
            lt(transfers.createdAt, cutoff),
            /*
             * The backoff gate (0123). A row that has failed recently is held
             * out of the BATCH rather than skipped inside the loop — which is
             * the whole point: skipping it in the loop still lets it occupy one
             * of the ten slots, so the starvation would be unchanged.
             *
             * `IS NULL OR <= now()` and not just `<= now()`: a transfer that has
             * never been attempted has no `resume_after`, and a bare comparison
             * against NULL is NULL, which is not TRUE — so every first attempt
             * would be filtered out and the scheduler would resume nothing at
             * all. That is the trap 0092's own header records hitting.
             */
            or(isNull(transfers.resumeAfter), lte(transfers.resumeAfter, new Date())),
          ),
        )
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
          if (result?.state === 'settled') {
            settled += 1;
          } else if (result?.state === 'pending') {
            /*
             * ⚠️ STILL PENDING, AND IT DID NOT THROW — the branch the backoff
             * used to miss entirely, and the one the most reachable stuck
             * transfer actually takes.
             *
             * `TransferExecutor` treats an INDETERMINATE outcome as a normal
             * return rather than an error, and it is right to: the inline
             * `POST /payments/transfers` caller must answer "submitted, being
             * processed", not fail the client's request over an outcome nobody
             * knows yet. But that means the `catch` below never runs, so
             * `resume_attempts` stayed 0 and `resume_after` stayed NULL for ever
             * — and a row whose `resume_after` is NULL passes the batch filter
             * on every single pass.
             *
             * That is EXACTLY the starvation the column note in `schema.ts`
             * describes: oldest-first plus a LIMIT plus a row that is always
             * eligible means newer transfers are never examined. Ten of them
             * starve the rail. The mechanism existed and the commonest case
             * walked around it.
             *
             * It is not hypothetical. The bridge claims an idempotency key
             * BEFORE calling MT5 and answers 409 for ever once a key is
             * interrupted mid-operation — deliberately, so nobody double-pays.
             * Such a transfer is indeterminate on every future attempt, so
             * without this it is retried every minute until a human intervenes.
             *
             * Backing off changes HOW OFTEN, and nothing else. The transfer
             * stays pending, the hold stays held, and only a person may end it.
             */
            await this.backOff(
              row.id,
              'MT5 did not confirm the movement and the outcome is not yet known.',
            );
          }
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          this.logger.error(
            `Transfer ${row.id} could not be resumed: ${reason}. ` +
              'It stays pending and will be tried again, on a widening backoff.',
          );
          /*
           * `resume_attempts + 1` computed IN SQL rather than from the row we
           * read: two instances may have attempted this transfer between our
           * SELECT and now, and the backoff should reflect what actually
           * happened to it rather than what this process last saw. 0092 makes
           * the same choice for the same reason.
           *
           * STILL PENDING. This records that an attempt failed and when to try
           * again; it does not decide the transfer's fate, because nothing
           * automatic may — see the column note in schema.ts.
           */
          await this.backOff(row.id, reason);
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
      /*
       * ── THE COUNT IS A BACKLOG, NOT A BATCH TALLY ────────────────────────
       *
       * `stale` is filtered out of `stuck`, and `stuck` is capped at BATCH (10)
       * and drained OLDEST FIRST. So the number that used to reach the page was
       * never "how many transfers are stuck" — it was "how many of the ten
       * oldest are stuck", which saturates at ten and stops moving exactly when
       * things are getting worse.
       *
       * That matters because of how this loop behaves under a persistent
       * failure: ten transfers that cannot be resumed keep their place at the
       * front every minute, so newer pending transfers are never even examined
       * — and therefore never counted, however long they wait. An operator
       * reading "10 transfers pending" while fifty are is under-reacting to a
       * number the system gave them.
       *
       * This codebase has met that distinction before and written it down: the
       * commission engine returns `orphaned` and `deferred` as BACKLOGS rather
       * than batch tallies, for the same reason and in nearly the same words.
       * It also solved the starvation half with `commission_retry_after`, a
       * per-row backoff that moves a failing row off the front of the queue.
       * `transfers` has no such column — see the note below.
       */
      const [{ backlog } = { backlog: 0 }] = await this.db
        .select({ backlog: count() })
        .from(transfers)
        .where(
          and(
            eq(transfers.state, 'pending'),
            lt(transfers.createdAt, new Date(Date.now() - STALE_MS)),
          ),
        );
      if (stale.length > 0) {
        raiseAlert(
          this.logger,
          ALERT_KINDS.TRANSFER_STUCK,
          'page',
          `${backlog} transfer(s) have been pending for over ${STALE_MS / 60_000} minutes ` +
            'and are not clearing on their own. No money has moved — the wallet is debited only ' +
            'once MT5 confirms — but a client is watching a spinner. The usual cause is the MT5 ' +
            `bridge having lost its session; check GET /admin/live on it. Transfers: ${stale
              .map((row) => row.id)
              .join(', ')}`,
          // `count` is the whole backlog; `inThisBatch` is what this run could
          // actually look at. When they diverge, the queue is not draining.
          { count: backlog, inThisBatch: stale.length, oldestId: stale[0]?.id },
        );
      }
      await this.announceStuck();
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

  /**
   * Put every stuck transfer in front of the people who can release it — once.
   *
   * The page above reaches whoever reads the alert channel, and on a
   * deployment with no sink registered that is nobody. This is the task on the
   * desk's own bell, scoped to the client's territory, for the admins holding
   * `transfers.abandon` (the catalogue decides). It clears itself for all of
   * them the moment the transfer leaves `pending` — settled, failed, or
   * released from the desk (migration 0140's trigger).
   *
   * Its OWN query rather than `stale`, for the reason the backlog note gives:
   * `stale` is at most the ten oldest, and a transfer that never reaches the
   * front of the batch would never be announced. "Once" is decided by the
   * transfer already having an open task — checked through the open-row index
   * — so a quiet minute costs one indexed probe per stuck transfer, not a
   * fan-out. A transfer nobody may be told about (no admin can act, or none
   * covers the client) is asked again next minute, which is cheap and means a
   * newly granted admin is told.
   */
  private async announceStuck(): Promise<void> {
    const unannounced = await this.db
      .select({
        id: transfers.id,
        userId: transfers.userId,
        direction: transfers.direction,
        amount: transfers.amount,
        currency: transfers.currency,
      })
      .from(transfers)
      .where(
        and(
          eq(transfers.state, 'pending'),
          lt(transfers.createdAt, new Date(Date.now() - STALE_MS)),
          /*
           * `subject_id` is TEXT since 0159 (it names a client by Portal ID or a
           * record by uuid), so the uuid is compared as text. Without the cast
           * Postgres refuses `text = uuid`, the run's catch logs it, and no
           * stuck transfer is ever announced — silently. Text to text also keeps
           * the open-task index usable.
           */
          sql`NOT EXISTS (
            SELECT 1 FROM ${notifications} task
             WHERE task.subject_kind = 'transfer'
               AND task.subject_id = ${transfers.id}::text
               AND task.resolved_at IS NULL
          )`,
        ),
      )
      .orderBy(transfers.createdAt)
      .limit(ANNOUNCE_BATCH);

    for (const row of unannounced) {
      await this.notifications.notifyAdmins({
        kind: 'admin.transfer.stuck',
        params: {
          transferId: row.id,
          direction: row.direction,
          amount: row.amount,
          currency: row.currency,
        },
        dedupeKey: `admin.transfer.stuck:${row.id}`,
        subject: { id: row.id, clientId: row.userId },
      });
    }
  }

  /**
   * Widen the retry interval for one transfer, and record why.
   *
   * Extracted so the two ways an attempt can fail to settle share it. They are
   * genuinely different events — one THREW, one returned still-pending — and
   * they had genuinely different consequences until this was factored out: the
   * throwing path backed off, and the returning path did not back off at all.
   * One mechanism, reached from both, is what stops that drifting apart again.
   *
   * `resume_attempts + 1` is computed IN SQL rather than from the row we read:
   * two instances may have attempted this transfer between our SELECT and now,
   * and the backoff should reflect what actually happened to it rather than
   * what this process last saw. 0092 makes the same choice for the same reason.
   *
   * ⚠️ STILL PENDING. This records that an attempt did not settle and when to
   * try again. It does not decide the transfer's fate, because nothing
   * automatic may — see the column note in `schema.ts`.
   */
  private async backOff(transferId: string, reason: string): Promise<void> {
    await this.db
      .update(transfers)
      .set({
        resumeAttempts: sql`${transfers.resumeAttempts} + 1`,
        resumeAfter: sql`now() + (least(power(2, least(${transfers.resumeAttempts}, ${RETRY_EXPONENT_CEILING}))::int, ${RETRY_CAP_MINUTES}) || ' minutes')::interval`,
        resumeLastError: reason.slice(0, 500),
      })
      .where(eq(transfers.id, transferId));
  }
}

/** Long enough that the creating request has finished its own attempt. */
/*
 * The backoff ceiling, matching 0092 exactly: a minute, two, four … capped at
 * an hour, then hourly for ever. It never gives up — abandoning a stuck
 * transfer would strand a client's money on a decision nobody made — but a
 * permanently-stuck row costs ONE slot an hour instead of one slot for ever.
 */
const RETRY_CAP_MINUTES = 60;
/** Bounds the exponent so `power(2, n)` cannot overflow on an ancient row. */
const RETRY_EXPONENT_CEILING = 20;

const GRACE_MS = 30_000;

/**
 * How many to attempt per run.
 *
 * Small because each one is a round trip to the broker behind a single lock. A
 * backlog drains over several minutes rather than occupying the bridge for one
 * long run and starving the client requests sharing it.
 */
const BATCH = 10;

/** See `transfer-staleness.ts` for the threshold and why it lives there. */
const STALE_MS = TRANSFER_STALE_MS;

/**
 * How many stuck transfers to announce per run. Each is one fan-out; a backlog
 * larger than this is announced over the next minutes, oldest first, while the
 * page above reports the whole backlog at once.
 */
const ANNOUNCE_BATCH = 50;
