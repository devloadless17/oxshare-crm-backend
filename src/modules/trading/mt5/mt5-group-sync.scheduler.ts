import { Injectable, Logger } from '@nestjs/common';
import { ScheduledJob } from '../../../common/scheduling/scheduled-job.decorator';
import { Mt5GroupSyncService } from './mt5-group-sync.service';
import { Mt5SymbolSyncService } from './mt5-symbol-sync.service';
import { pendingMigrationHint } from '../../../common/logging/pending-migration';
import { JobLeaseService } from '../../../common/scheduling/job-lease.service';

/**
 * Re-reads the MT5 group catalogue on a schedule — its interval is set in
 * Settings → Scheduled jobs (`mt5.syncGroups`, hourly by default; 0167), and
 * `ScheduledJobsRunner` starts it.
 *
 * ## Hourly by default, because the thing it watches changes at human speed
 *
 * A broker adds or re-permissions a group during a working day, deliberately,
 * as a configuration change. There is no burst to keep up with and no race to
 * lose — the sync is a comparison against what was there last time, so the only
 * cost of being an hour late is finding out an hour late. Against that, `GET
 * /groups` costs ~4.9s on the MT5 side, and this is the one caller that pays it
 * on a timer rather than because somebody is waiting.
 *
 * ## Soon after boot on a fresh deployment, so it is not blind
 *
 * A database that has never run it has no `last_started_at`, so the runner
 * starts it on its first tick, seconds after boot. Without that the mirror is empty until the first hour elapses, and the fallback
 * it exists to provide — a group picker that still renders when MT5 is
 * unreachable — would be empty for exactly the window in which a new
 * deployment is most likely to have bridge problems. The run is fire-and-forget
 * and its failure never blocks startup: a CRM that will not boot because a
 * broker's server is down is a worse outcome than a stale catalogue, and every
 * caller of the mirror already handles it being empty.
 */
@Injectable()
export class Mt5GroupSyncScheduler {
  private readonly logger = new Logger(Mt5GroupSyncScheduler.name);

  constructor(
    private readonly groups: Mt5GroupSyncService,
    private readonly leases: JobLeaseService,
    /** 0198 — the symbol list rides the same job; see `syncSymbols`. */
    private readonly symbols: Mt5SymbolSyncService,
  ) {}

  /**
   * Sync NOW, because something just showed a group this CRM does not have
   * (7 Oct 2026) — an account the bridge pushed sits in a group added on the
   * broker's server since the last sync. Single-flight and at most once a
   * minute, so a burst of snapshots from one new group is one sync; the hourly
   * run below stays as the hidden safety net for edits no account reveals.
   */
  syncSoon(): void {
    const now = Date.now();
    if (this.soon || now - this.lastSoonAt < 60_000) return;
    this.lastSoonAt = now;
    this.soon = this.sync()
      .catch((error: unknown) => {
        this.logger.warn(
          `Instant MT5 group sync failed; the hourly run retries. ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      })
      .finally(() => {
        this.soon = null;
      });
  }

  private soon: Promise<void> | null = null;
  private lastSoonAt = 0;

  @ScheduledJob('mt5.syncGroups')
  async sync(): Promise<void> {
    /*
     * ONE INSTANCE. Cheap and idempotent, so a duplicate run is harmless — but
     * "harmless" is not free: on four replicas it is four times the queries for
     * one result, and a job nobody leases is a job that quietly stops being
     * counted when the estate grows. Every scheduled job on this platform now
     * runs once per tick; the exceptions were the ones people forget.
     */
    await this.leases.run('mt5.syncGroups', 30 * 60_000, async () => {
      await this.runOnce();
      await this.syncSymbols();
    });
  }

  /**
   * The symbol list (0198), after the groups and independently of them: a
   * failure here leaves the previous list standing, dated, and never stops the
   * group sync. Deals on a symbol the list has not seen yet wait for it only
   * when their commission type excludes folders.
   */
  private async syncSymbols(): Promise<void> {
    try {
      const run = await this.symbols.sync();
      if (run && run.removed > 0) {
        this.logger.log(`MT5 symbols synced: ${run.onServer} on the server, ${run.removed} gone.`);
      }
    } catch (error) {
      this.logger.warn(
        'Could not sync the MT5 symbol list; the last known one still stands. ' +
          `${error instanceof Error ? error.message : String(error)}` +
          pendingMigrationHint(error),
      );
    }
  }

  private async runOnce(): Promise<void> {
    try {
      const run = await this.groups.sync();

      // Not configured on this deployment. Not a failure, and not worth a line
      // every hour on a machine that is never going to have a bridge.
      if (!run) return;

      if (run.added > 0 || run.removed > 0 || run.restored > 0) {
        this.logger.log(
          `MT5 groups synced: ${run.onServer} on the server, ${run.added} new, ` +
            `${run.removed} no longer reported, ${run.restored} back after being gone.`,
        );
      }

      /*
       * These two are already logged per occurrence, with the group name and
       * what to do about it. Repeated here as a COUNT because the per-row lines
       * are errors scattered through a run and this is the one line that says
       * how big the problem is.
       */
      if (run.claimedMissing > 0 || run.currencyDrift > 0) {
        this.logger.error(
          `${run.claimedMissing} product group(s) point at an MT5 group that no longer exists, ` +
            `and ${run.currencyDrift} disagree with the server about their currency. Both break ` +
            'account opening for real clients; see the lines above for which.',
        );
      }
    } catch (error) {
      /*
       * The bridge being unreachable is the expected failure here, and it is
       * precisely the case the mirror exists for: the previous catalogue is
       * still readable and still labelled with when it was last confirmed.
       * Nothing is corrupted by a failed sync, because a sync only ever writes
       * what the server just said.
       */
      this.logger.warn(
        'Could not sync the MT5 group catalogue; the last known one still stands and is dated. ' +
          `${error instanceof Error ? error.message : String(error)}` +
          pendingMigrationHint(error),
      );
    }
  }
}
