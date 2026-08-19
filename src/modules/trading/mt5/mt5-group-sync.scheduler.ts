import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Mt5GroupSyncService } from './mt5-group-sync.service';
import { pendingMigrationHint } from '../../../common/logging/pending-migration';

/**
 * Re-reads the MT5 group catalogue on a schedule, and once at boot.
 *
 * ## Hourly, because the thing it watches changes at human speed
 *
 * A broker adds or re-permissions a group during a working day, deliberately,
 * as a configuration change. There is no burst to keep up with and no race to
 * lose — the sync is a comparison against what was there last time, so the only
 * cost of being an hour late is finding out an hour late. Against that, `GET
 * /groups` costs ~4.9s on the MT5 side, and this is the one caller that pays it
 * on a timer rather than because somebody is waiting.
 *
 * ## Once at boot, so a fresh deployment is not blind
 *
 * Without it the mirror is empty until the first hour elapses, and the fallback
 * it exists to provide — a group picker that still renders when MT5 is
 * unreachable — would be empty for exactly the window in which a new
 * deployment is most likely to have bridge problems. The run is fire-and-forget
 * and its failure never blocks startup: a CRM that will not boot because a
 * broker's server is down is a worse outcome than a stale catalogue, and every
 * caller of the mirror already handles it being empty.
 */
@Injectable()
export class Mt5GroupSyncScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(Mt5GroupSyncScheduler.name);

  constructor(private readonly groups: Mt5GroupSyncService) {}

  onApplicationBootstrap(): void {
    void this.sync();
  }

  @Cron(process.env.MT5_GROUP_SYNC_CRON ?? CronExpression.EVERY_HOUR, {
    name: 'mt5.syncGroups',
  })
  async sync(): Promise<void> {
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
