import { Injectable, Logger } from '@nestjs/common';
import { ScheduledJob } from '../../../common/scheduling/scheduled-job.decorator';
import { Mt5AccountDirectoryService, type DirectorySyncRun } from './mt5-account-directory.service';
import { JobLeaseService } from '../../../common/scheduling/job-lease.service';
import { pendingMigrationHint } from '../../../common/logging/pending-migration';
import { ConflictError } from '../../../common/errors/domain-errors';

const LEASE = 'mt5.syncAccounts';
/** Double the scheduled run's four-minute budget — the lease's crash backstop. */
const LEASE_TTL_MS = 8 * 60_000;

/**
 * Brings every MT5 account into the CRM — at the interval set in Settings →
 * Scheduled jobs (`mt5.syncAccounts`, ten minutes by default; 0167), and on an
 * operator's "Sync now" (see `Mt5AccountDirectoryService`).
 *
 * Ten minutes by default because what it watches is accounts being OPENED outside the CRM,
 * which happens at human speed; the balance of an account already recorded is
 * the bridge sweep's job, not this one's. Leased, so one instance runs it: two
 * would read the same new logins from the same single MT5 session.
 */
@Injectable()
export class Mt5AccountDirectoryScheduler {
  private readonly logger = new Logger(Mt5AccountDirectoryScheduler.name);

  constructor(
    private readonly directory: Mt5AccountDirectoryService,
    private readonly leases: JobLeaseService,
  ) {}

  @ScheduledJob('mt5.syncAccounts')
  async sync(): Promise<void> {
    try {
      await this.leases.run(LEASE, LEASE_TTL_MS, async () => {
        await this.directory.sync();
      });
    } catch (error) {
      // The bridge being unreachable is the expected failure; the next run carries on.
      this.logger.warn(
        'Could not sync MT5 accounts into the CRM; the next run carries on. ' +
          (error instanceof Error ? error.message : String(error)) +
          pendingMigrationHint(error),
      );
    }
  }

  /**
   * "Sync now", for an operator waiting on the answer: a smaller batch inside
   * half a minute. The scheduled runs take the rest.
   */
  async syncNow(): Promise<DirectorySyncRun> {
    let run: DirectorySyncRun | null = null;
    const ran = await this.leases.run(LEASE, LEASE_TTL_MS, async () => {
      run = await this.directory.sync({ batch: 50, budgetMs: 25_000 });
    });
    if (!ran) {
      throw new ConflictError(
        'A sync is already running. Its accounts appear on the list as it records them.',
      );
    }
    if (!run) {
      throw new ConflictError(
        'The MT5 bridge is not configured on this deployment, so there is nothing to sync.',
      );
    }
    return run;
  }
}
