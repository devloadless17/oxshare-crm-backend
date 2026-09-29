import { SetMetadata } from '@nestjs/common';
import type { ScheduledJobKey } from './scheduled-jobs.catalog';

export const SCHEDULED_JOB = 'oxshare:scheduled-job';

/**
 * Marks the method `ScheduledJobsRunner` starts for a job in
 * `scheduled-jobs.catalog.ts`, at the interval set in Settings → Scheduled jobs.
 *
 * It REPLACES `@Cron`: a decorator argument is fixed when the class is defined,
 * so a cron expression can never follow a setting an operator changes. The
 * runner reads the interval from the database on every tick instead.
 */
export const ScheduledJob = (key: ScheduledJobKey) => SetMetadata(SCHEDULED_JOB, key);
