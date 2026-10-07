import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { AppSettingsStore } from '../../store/app-settings.store';
import { SCHEDULED_JOB } from './scheduled-job.decorator';
import { SCHEDULED_JOBS, scheduledJob } from './scheduled-jobs.catalog';

/** How often the runner looks for due jobs — the latency of a changed interval. */
const TICK_MS = 15_000;
/** The first look, a little after boot, so start-up is not a burst of jobs. */
const FIRST_TICK_MS = 10_000;

/**
 * Starts every `@ScheduledJob` method at the interval set in Settings →
 * Scheduled jobs (owner, 29 Sep 2026), in place of `@Cron` and the `.env`
 * variables that used to set them.
 *
 * ## How
 *
 * Every 15 seconds it reads the `scheduled_jobs` rows and, for each job whose
 * `last_started_at + interval` has passed, CLAIMS the run (`claimJob`, one
 * conditional UPDATE) and starts it. So:
 *
 *  - a changed interval applies within 15 seconds, on every instance, with no
 *    restart;
 *  - on several instances exactly one starts each run — the database decides;
 *  - a run that is still going on this instance is never started again here,
 *    and the job's own lease (`JobLeaseService`) still stops overlap across
 *    instances for a slow run;
 *  - "Run now" clears `last_started_at`, and the next tick starts it.
 *
 * What each run did — when, how long, the error if it threw — is written back
 * to the row for the settings screen.
 *
 * `SCHEDULED_JOBS=off` stops it (the test suites set it: a suite's own jobs are
 * called directly, never on a clock).
 */
@Injectable()
export class ScheduledJobsRunner implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(ScheduledJobsRunner.name);
  private readonly jobs = new Map<string, () => Promise<unknown>>();
  private readonly running = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
    private readonly settings: AppSettingsStore,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    this.discover();
    if (process.env.SCHEDULED_JOBS === 'off') return;
    try {
      // A job added after 0167 gets its row, with its default, on first boot.
      for (const key of this.jobs.keys()) {
        const job = scheduledJob(key);
        await this.settings.ensureJob(key, job?.defaultSeconds ?? 3600);
        // A hidden safety net runs at its default, whatever an older screen saved.
        if (job?.hidden) await this.settings.pinJobInterval(key, job.defaultSeconds);
      }
    } catch (error) {
      this.logger.warn(
        `Could not prepare the scheduled jobs; retrying on the first tick. ${String(error)}`,
      );
    }
    this.schedule(FIRST_TICK_MS);
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** The keys with a method to start — for the settings screen and tests. */
  registeredKeys(): string[] {
    return [...this.jobs.keys()];
  }

  private discover(): void {
    for (const wrapper of this.discovery.getProviders()) {
      const instance = wrapper.instance as Record<string, unknown> | undefined;
      if (!instance || typeof instance !== 'object') continue;
      const prototype = Object.getPrototypeOf(instance) as object | null;
      if (!prototype) continue;
      for (const name of this.scanner.getAllMethodNames(prototype)) {
        const method = instance[name];
        if (typeof method !== 'function') continue;
        const key = this.reflector.get<string | undefined>(SCHEDULED_JOB, method);
        if (!key) continue;
        if (!scheduledJob(key)) {
          this.logger.error(`@ScheduledJob('${key}') names no job in scheduled-jobs.catalog.ts`);
          continue;
        }
        this.jobs.set(key, () => (method as () => Promise<unknown>).call(instance));
      }
    }
    const missing = SCHEDULED_JOBS.filter(
      (job) => job.runsOn === 'crm' && !('sharedInterval' in job) && !this.jobs.has(job.key),
    );
    for (const job of missing) {
      this.logger.warn(`Scheduled job ${job.key} has no @ScheduledJob method; it will not run.`);
    }
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), ms);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    try {
      for (const [key, run] of this.jobs) {
        if (this.running.has(key)) continue;
        const startedAt = await this.settings.claimJob(key);
        if (!startedAt) continue;
        this.running.add(key);
        void this.execute(key, run, startedAt);
      }
    } catch (error) {
      this.logger.warn(`Scheduled jobs tick failed; next tick retries. ${String(error)}`);
    } finally {
      this.schedule(TICK_MS);
    }
  }

  private async execute(key: string, run: () => Promise<unknown>, startedAt: Date): Promise<void> {
    let failure: string | undefined;
    try {
      await run();
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      this.logger.error(`Scheduled job ${key} failed: ${failure}`);
    } finally {
      this.running.delete(key);
      await this.settings.finishJob(key, startedAt, failure).catch(() => undefined);
    }
  }
}
