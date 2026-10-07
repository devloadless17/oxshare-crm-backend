import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { MetadataScanner, Reflector } from '@nestjs/core';
import type { DiscoveryService } from '@nestjs/core';
import { scheduledJobs } from '../src/database/schema';
import { AppSettingsStore } from '../src/store/app-settings.store';
import { SettingsService } from '../src/modules/settings/settings.service';
import { ScheduledJobsRunner } from '../src/common/scheduling/scheduled-jobs.runner';
import { ScheduledJob } from '../src/common/scheduling/scheduled-job.decorator';
import { NotFoundError, ValidationError } from '../src/common/errors/domain-errors';
import type { Actor } from '../src/common/security/actor';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * EVERY BACKGROUND JOB'S TIMING, SET IN SETTINGS (owner, 29 Sep 2026; 0167).
 *
 * Pinned against real Postgres:
 *  - a due run is CLAIMED by exactly one caller, however many instances ask,
 *    and not again until the interval has passed; "Run now" makes it due;
 *  - the runner starts a `@ScheduledJob` method when it is due, records how
 *    it went (and the error, cleared by the next success), and skips it while
 *    it is not due;
 *  - an interval is changed only within the job's bounds, and the commission
 *    pair's interval IS the Trading setting (also the hold window);
 *  - "Run now" is refused for the commission pair and for a bridge job;
 *  - the bridge reading its interval is stamped.
 */
let ctx: MoneyTestContext;
let store: AppSettingsStore;
let settings: SettingsService;
const audit = { record: vi.fn(), recordWithin: vi.fn() };
const ACTOR: Actor = {
  id: '00000000-0000-4000-8000-0000000000a1',
  email: 'jobs@x',
  permissions: ['*'],
};

const row = async (key: string) =>
  (await ctx.db.select().from(scheduledJobs).where(eq(scheduledJobs.key, key)))[0];

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  store = new AppSettingsStore(ctx.db);
  settings = new SettingsService(
    store,
    { get: () => undefined } as never,
    audit as never,
    { namesByIds: vi.fn().mockResolvedValue(new Map()) } as never,
  );
}, 180_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

beforeEach(async () => {
  audit.record.mockClear();
  await ctx.db.execute(sql`
    UPDATE scheduled_jobs SET last_started_at = NULL, last_finished_at = NULL,
           last_error = NULL, last_error_at = NULL, external_read_at = NULL
  `);
});

describe('claiming a run', () => {
  it('is one caller’s, once per interval — "Run now" makes it due again', async () => {
    const claims = await Promise.all([1, 2, 3, 4].map(() => store.claimJob('wallet.reconcile')));
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await store.claimJob('wallet.reconcile')).toBeNull(); // an hour has not passed

    await store.requestJobRun('wallet.reconcile');
    expect(await store.claimJob('wallet.reconcile')).not.toBeNull();
  });

  it('is due again once the interval has passed', async () => {
    await store.claimJob('security.sweep');
    await ctx.db.execute(sql`
      UPDATE scheduled_jobs SET last_started_at = now() - interval '2 hours' WHERE key = 'security.sweep'
    `);
    expect(await store.claimJob('security.sweep')).not.toBeNull();
  });
});

describe('the runner', () => {
  class Jobs {
    calls = 0;
    fail = false;
    @ScheduledJob('notifications.prune')
    async prune(): Promise<void> {
      this.calls += 1;
      await Promise.resolve();
      if (this.fail) throw new Error('prune broke');
    }
  }

  const runnerFor = (jobs: Jobs) => {
    const discovery = { getProviders: () => [{ instance: jobs }] } as unknown as DiscoveryService;
    const runner = new ScheduledJobsRunner(
      discovery,
      new MetadataScanner(),
      new Reflector(),
      store,
    );
    const internals = runner as unknown as {
      discover(): void;
      tick(): Promise<void>;
      running: Set<string>;
    };
    internals.discover();
    return { runner, internals };
  };

  const settle = async (internals: { running: Set<string> }) => {
    for (let i = 0; i < 50 && internals.running.size > 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  };

  it('starts a due job once, records the run, and leaves it until it is due again', async () => {
    const jobs = new Jobs();
    const { runner, internals } = runnerFor(jobs);
    try {
      expect(runner.registeredKeys()).toEqual(['notifications.prune']);
      await internals.tick();
      await settle(internals);
      expect(jobs.calls).toBe(1);
      const after = await row('notifications.prune');
      expect(after.lastFinishedAt).not.toBeNull();
      expect(after.lastDurationMs).not.toBeNull();
      expect(after.lastError).toBeNull();

      await internals.tick(); // a day has not passed
      await settle(internals);
      expect(jobs.calls).toBe(1);
    } finally {
      runner.onModuleDestroy();
    }
  });

  it('records a failure, and the next success clears it', async () => {
    const jobs = new Jobs();
    jobs.fail = true;
    const { runner, internals } = runnerFor(jobs);
    try {
      await internals.tick();
      await settle(internals);
      expect((await row('notifications.prune')).lastError).toBe('prune broke');

      jobs.fail = false;
      await store.requestJobRun('notifications.prune');
      await internals.tick();
      await settle(internals);
      expect((await row('notifications.prune')).lastError).toBeNull();
      expect(jobs.calls).toBe(2);
    } finally {
      runner.onModuleDestroy();
    }
  });
});

describe('Settings → Scheduled jobs', () => {
  it('lists every job with its interval and bounds — and none of the MT5 safety nets', async () => {
    const { items } = await settings.listJobs();
    const keys = items.map((job) => job.key);
    /*
     * The three MT5 jobs are not the admin's to see (owner, 7 Oct 2026): the
     * bridge sweep is the bridge's own, and the two CRM ones are hidden safety
     * nets behind instant, event-driven sync.
     */
    expect(keys).not.toContain('bridge.sweep');
    expect(keys).not.toContain('mt5.syncAccounts');
    expect(keys).not.toContain('mt5.syncGroups');
    expect(items.find((job) => job.key === 'payments.reconcileProviders')).toMatchObject({
      runsOn: 'crm',
      intervalSeconds: 300,
      minSeconds: 60,
    });
  });

  it('changes an interval within its bounds, audited — and refuses one outside them', async () => {
    await settings.setJobInterval('payments.reconcileProviders', 900, ACTOR);
    expect((await row('payments.reconcileProviders')).intervalSeconds).toBe(900);
    expect(audit.record).toHaveBeenCalledWith(
      ACTOR.id,
      'settings.jobs.update',
      'app_settings',
      'payments.reconcileProviders',
      { intervalSeconds: { before: 300, after: 900 } },
    );
    await expect(
      settings.setJobInterval('payments.reconcileProviders', 5, ACTOR),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(settings.setJobInterval('nope', 60, ACTOR)).rejects.toBeInstanceOf(NotFoundError);
    await settings.setJobInterval('payments.reconcileProviders', 300, ACTOR);
  });

  it('refuses to edit or start the hidden MT5 safety nets, as if they did not exist', async () => {
    for (const key of ['mt5.syncAccounts', 'mt5.syncGroups', 'bridge.sweep']) {
      await expect(settings.setJobInterval(key, 3600, ACTOR)).rejects.toBeInstanceOf(NotFoundError);
      await expect(settings.runJobNow(key, ACTOR)).rejects.toBeInstanceOf(NotFoundError);
    }
  });

  it('the commission pair’s interval IS the Trading setting', async () => {
    await settings.setJobInterval('ib.confirmAccruals', 120, ACTOR);
    const { items } = await settings.listJobs();
    expect(items.find((job) => job.key === 'ib.accrueDeals')?.intervalSeconds).toBe(120);
    expect(audit.record).toHaveBeenCalledWith(
      ACTOR.id,
      'settings.trading.update',
      'app_settings',
      'trading',
      expect.anything(),
    );
  });

  it('runs a CRM job now — but not the commission pair', async () => {
    await store.claimJob('payments.reconcileProviders');
    await settings.runJobNow('payments.reconcileProviders', ACTOR);
    expect((await row('payments.reconcileProviders')).lastStartedAt).toBeNull();
    await expect(settings.runJobNow('ib.accrueDeals', ACTOR)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
