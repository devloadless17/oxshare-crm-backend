import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DealCommissionService } from './deal-commission.service';
import { pendingMigrationHint } from '../../../common/logging/pending-migration';
import { ALERT_KINDS, raiseAlert } from '../../../common/logging/alerts';

/**
 * Refused deals beyond which this is a SETTINGS problem rather than a blip.
 *
 * A transient failure — a lock timeout, a connection dropped mid-batch — takes
 * a handful of deals with it and clears on the next run. Ten deals failing at
 * once is the shape of a rate nobody can accrue against, and that does not fix
 * itself no matter how long the queue is left alone.
 */
const REFUSED_DEAL_ALERT = 10;

/**
 * Unlinked-login deals beyond which the backlog is worth waking a system
 * rather than a log reader.
 *
 * Deliberately a whole batch. A handful of orphans is ordinary and permanent —
 * a manager's own login, a broker-side test account — and alerting on those
 * teaches everybody to ignore this kind. Two hundred is a real client's trading
 * going unattributed.
 */
const ORPHAN_DEAL_ALERT = 200;

/** How often the stall alert repeats while the condition holds. */
const ALERT_REPEAT_MS = 3_600_000;

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

  /**
   * When the stall alert last fired, so it repeats rather than streams.
   *
   * An alert that says the same thing every minute is one a drain deduplicates
   * badly and a human silences — and this is the alert whose silence means
   * partners are not being paid, so it is the last one that can afford to be
   * filtered out by whoever is tired of it.
   */
  private lastStallAlert = 0;

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
       * ── THE RUN THAT DID NOTHING, ON PURPOSE ──────────────────────────────
       *
       * There is a backlog of historical trades and nobody has said whether
       * they are owed. Paying them is months of real money at once; skipping
       * them silently is money partners earned and never see. Neither is a
       * default, so the engine stopped and this says so.
       *
       * Told at every level that can reach a person: an alert for whatever
       * watches the drain, and a warn line for whoever is reading a log
       * wondering why no commission is being calculated. This is the one
       * message in this file that must not be throttled — it does not resolve
       * itself, and a deployment can sit in it indefinitely without any other
       * symptom, because "no commission yet" looks exactly like "no trades yet".
       */
      if (run.awaitingBacklogDecision) {
        raiseAlert(
          this.logger,
          ALERT_KINDS.COMMISSION_QUEUE_STALLED,
          'notify',
          'The commission engine is HOLDING: ingested trades predate it and IB_ACCRUAL_START is ' +
            'not set, so nobody has said whether that backlog is owed. Nothing has been paid and ' +
            'nothing has been discarded. Set IB_ACCRUAL_START to an ISO instant to pay from that ' +
            'point on, or to "all" to pay the whole backlog deliberately.',
          { awaitingBacklogDecision: 1, unlinked: run.orphaned },
        );
        return;
      }

      /*
       * The quiet path, and the common one once a backlog has drained. Logged at
       * nothing rather than at info: a line every minute saying "no deals" is
       * how a log stops being read.
       *
       * `examined` alone is no longer enough to call a run quiet. Orphaned and
       * refused deals are held OUT of the batch now — that is what stops them
       * jamming the queue — so a platform whose only queued work is stuck reads
       * as zero examined, and returning here on that would make the exact
       * condition this job must report the one condition it never mentions.
       */
      if (run.examined === 0 && run.orphaned === 0 && run.deferred === 0) return;

      if (run.accrued > 0) {
        this.logger.log(
          `Accrued commission on ${run.accrued} deal(s): ${run.accrualRows} accrual row(s) written.`,
        );
      }

      if (run.predating > 0) {
        this.logger.log(
          `${run.predating} deal(s) predate IB_ACCRUAL_START and were marked decided without ` +
            'accruing. They are finished, not queued — nothing will revisit them.',
        );
      }

      if (run.failed > 0) {
        this.logger.warn(
          `${run.failed} deal(s) could not be accrued and remain queued, on a backoff that ` +
            'doubles to an hour so they cannot crowd out payable ones. Nothing is lost — the ' +
            'deals are the record, and the accrual is idempotent.',
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
        /*
         * Already the backlog, not a batch tally — `accruePending` counts it on
         * every run precisely because these deals never appear in a batch any
         * more. The second query this used to make asked the same question
         * twice, and could disagree with itself across the gap between them.
         */
        const waiting = run.orphaned;

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

      this.alertOnStall(run);
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

  /**
   * The §9 failed-job-depth alert, on the job that pays partners.
   *
   * ## Why this exists even though the queue no longer jams
   *
   * Holding stuck deals out of the batch fixes the CATASTROPHE — commission
   * stopping for everybody because a hundred un-accruable rows owned the front
   * of an oldest-first queue. It does nothing about the deals themselves, and
   * making them harmless is exactly what makes them quiet: they no longer show
   * up in `examined`, no longer fill a log with retries, and no longer break
   * anything a person would notice.
   *
   * So the fix removes the symptom that used to be the only evidence. This is
   * what replaces it: money is owed, nothing is going to pay it, and somebody
   * has to be told in a form a machine can route — which is the one thing
   * `logger.warn` throttled to once an hour could never be.
   *
   * ## Two conditions, one kind
   *
   * A refusal and an unlinked login need different people — an operator who can
   * edit a rate, and one who can link an account — but they are the same
   * ALERT: trades are queued for commission and nothing is going to pay them.
   * The context says which, so a drain can route on it without the taxonomy
   * growing a kind per cause.
   */
  private alertOnStall(run: { orphaned: number; deferred: number }): void {
    const refused = run.deferred >= REFUSED_DEAL_ALERT;
    const unlinked = run.orphaned >= ORPHAN_DEAL_ALERT;

    if (!refused && !unlinked) {
      /*
       * Cleared — or never raised. Reset so the NEXT occurrence alerts
       * immediately rather than waiting out a window that started before the
       * problem was fixed, which is how a second incident goes unreported for
       * fifty minutes.
       */
      this.lastStallAlert = 0;
      return;
    }

    if (Date.now() - this.lastStallAlert < ALERT_REPEAT_MS) return;
    this.lastStallAlert = Date.now();

    raiseAlert(
      this.logger,
      ALERT_KINDS.COMMISSION_QUEUE_STALLED,
      'notify',
      refused
        ? `${run.deferred} ingested deal(s) were REFUSED by the commission engine and are ` +
            'retrying on a backoff. Every future run fails the same way until the commission ' +
            'configuration is corrected; the deals stay queued and pay in full once it is.'
        : `${run.orphaned} ingested deal(s) belong to MT5 logins no trading account claims, so ` +
            'the commission on them cannot be attributed to anybody. They accrue automatically ' +
            'once the accounts are linked — no backfill needed.',
      { refused: run.deferred, unlinked: run.orphaned },
    );
  }
}
