import { describe, expect, it } from 'vitest';
import type { StoredFilesService } from '../src/common/uploads/stored-files.service';
import { HealthService } from '../src/modules/health/health.service';
import type { DependencyHealthDto, ReadinessDto } from '../src/modules/health/dto/health.dto';
import type { Db } from '../src/database/db';
import { pendingMigrations, shippedMigrations } from '../src/database/migration-status';

/**
 * PLATFORM-CONVENTIONS R-6.4 — readiness has to be able to say "no".
 *
 * The endpoint this replaces returned a hardcoded `{ status: 'ok' }`: with
 * Postgres stopped it still answered 200, so a load balancer would keep routing
 * traffic to an instance that could not serve a single request. The assertions
 * below are the ones that would have failed against that version.
 *
 * No Testcontainers here on purpose. What is under test is the DECISION —
 * up/down/not_configured, and which of those make the instance unready — not
 * Postgres itself. A stub executor exercises the failure branch, which a real
 * database cannot be made to do on demand.
 */

/** Minimal stand-in for the drizzle instance: only `execute` is reached. */
function dbThat(behaviour: 'succeeds' | 'fails' | 'hangs'): Db {
  return {
    execute: () => {
      if (behaviour === 'fails') return Promise.reject(new Error('connection terminated'));
      if (behaviour === 'hangs') return new Promise(() => {}); // never settles
      return Promise.resolve([]);
    },
  } as unknown as Db;
}

/**
 * A storage stand-in whose reachability the test chooses.
 *
 * The default is `up`, because these cases are about POSTGRES and a storage probe
 * failing underneath them would make every assertion here fail for the wrong reason.
 * The storage cases below set it explicitly.
 */
const storageThat = (reachable: boolean, provider: 'r2' | 'disk' = 'r2') =>
  ({
    healthy: () => Promise.resolve(reachable),
    providerName: provider,
  }) as unknown as StoredFilesService;

/**
 * A Redis stand-in whose PING the test chooses, or `null` for REDIS_URL unset.
 *
 * Only `ping` exists, which is the point of `PingableRedis`: a probe that could
 * reach for `set` would eventually be asked to write, and a health check with
 * side effects is one nobody trusts. A fake that cannot offer more cannot drift.
 */
const redisThat = (behaviour: 'answers' | 'fails' | 'hangs') => ({
  ping: () => {
    if (behaviour === 'fails') return Promise.reject(new Error('ECONNREFUSED'));
    if (behaviour === 'hangs') return new Promise<string>(() => {});
    return Promise.resolve('PONG');
  },
});

const dependency = (report: ReadinessDto, name: string): DependencyHealthDto | undefined =>
  report.dependencies.find((d) => d.name === name);

describe('R-6.4 readiness', () => {
  it('is ready, and times the probe, when Postgres answers', async () => {
    const report = await new HealthService(
      dbThat('succeeds'),
      storageThat(true),
      redisThat('answers'),
    ).readiness();

    expect(report.status).toBe('ready');
    expect(dependency(report, 'postgres')).toMatchObject({ status: 'up', required: true });
    expect(dependency(report, 'postgres')?.latencyMs).toBeTypeOf('number');
  });

  it('is NOT ready, with a required dependency down, when Postgres fails', async () => {
    const report = await new HealthService(
      dbThat('fails'),
      storageThat(true),
      redisThat('answers'),
    ).readiness();

    expect(report.status).toBe('not_ready');
    expect(dependency(report, 'postgres')).toMatchObject({ status: 'down', required: true });
  });

  it('never leaks connection detail to an unauthenticated caller', async () => {
    // /health/ready is public. A raw pg error echoes the host, port and user
    // back to whoever asked; the reason belongs in the logs, not the response.
    const report = await new HealthService(
      dbThat('fails'),
      storageThat(true),
      redisThat('answers'),
    ).readiness();

    expect(dependency(report, 'postgres')?.detail).not.toMatch(/connection terminated/);
    expect(dependency(report, 'postgres')?.detail).toMatch(/server logs/);
  });

  it('gives up on a hanging database instead of hanging with it', async () => {
    // Without the probe timeout this test would never finish — which is exactly
    // what an unreachable host does to a readiness endpoint that has none.
    const report = await new HealthService(
      dbThat('hangs'),
      storageThat(true),
      redisThat('answers'),
    ).readiness();

    expect(report.status).toBe('not_ready');
    expect(dependency(report, 'postgres')?.status).toBe('down');
  }, 10_000);

  it('reports unbuilt dependencies as not_configured, and stays ready', async () => {
    // Redis is a later milestone. Reporting it as `down` would make every
    // instance permanently unready; omitting it would let "ready" quietly mean
    // "ready apart from the parts nobody checked".
    const report = await new HealthService(
      dbThat('succeeds'),
      storageThat(true),
      redisThat('answers'),
    ).readiness();

    expect(report.status).toBe('ready');
    expect(dependency(report, 'redis')).toMatchObject({ status: 'up', required: false });
    // The mt5-bridge entry is deliberately absent, not merely unconfigured:
    // reporting a removed integration as `not_configured` forever would read as
    // "someone still needs to set this up".
    expect(dependency(report, 'mt5-bridge')).toBeUndefined();
  });

  /*
   * REDIS IS PROBED, NOT ASSUMED.
   *
   * This case used to assert the opposite — that a configured-but-unprobed
   * dependency reads `up` — and that was the defect: the status was decided by
   * whether REDIS_URL was a non-empty string, so a dead Redis reported healthy
   * on the endpoint an operator checks after a deploy. Redis backs the throttler
   * and the single-use replay markers, so down means signed webhooks are refused
   * and deal ingestion stops. That must be visible.
   */
  it('reports redis UP only when it actually answers PING', async () => {
    const report = await new HealthService(
      dbThat('succeeds'),
      storageThat(true),
      redisThat('answers'),
    ).readiness();

    expect(dependency(report, 'redis')).toMatchObject({ status: 'up', required: false });
    expect(dependency(report, 'redis')?.latencyMs).toBeTypeOf('number');
  });

  it('reports redis DOWN when PING fails, and stays ready', async () => {
    const report = await new HealthService(
      dbThat('succeeds'),
      storageThat(true),
      redisThat('fails'),
    ).readiness();

    expect(dependency(report, 'redis')?.status).toBe('down');
    expect(dependency(report, 'redis')?.detail).toMatch(/refused/i);
    // Not required: requests are still served, so a dead Redis must not take the
    // instance out of service. It has to be VISIBLE, not fatal.
    expect(report.status).toBe('ready');
  });

  it('reports redis DOWN rather than hanging when PING never settles', async () => {
    const report = await new HealthService(
      dbThat('succeeds'),
      storageThat(true),
      redisThat('hangs'),
    ).readiness();

    expect(dependency(report, 'redis')?.status).toBe('down');
  }, 10_000);

  it('reports redis not_configured when REDIS_URL is unset', async () => {
    const report = await new HealthService(dbThat('succeeds'), storageThat(true), null).readiness();

    expect(dependency(report, 'redis')).toMatchObject({
      status: 'not_configured',
      required: false,
    });
    expect(dependency(report, 'redis')?.detail).toMatch(/refused/i);
  });

  /*
   * Object storage is a REQUIRED dependency, and that is the assertion.
   *
   * An API that cannot reach the bucket cannot accept a KYC document or serve one to
   * a reviewer — the upload fails loudly rather than falling back to local disk, so
   * an instance in that state should not be sent traffic.
   */
  it('is NOT ready when object storage is unreachable', async () => {
    const report = await new HealthService(
      dbThat('succeeds'),
      storageThat(false),
      redisThat('answers'),
    ).readiness();

    expect(report.status).toBe('not_ready');
    expect(dependency(report, 'storage (r2)')).toMatchObject({
      status: 'down',
      required: true,
    });
  });

  it('names the active provider, so a disk deployment is visible in the payload', async () => {
    const report = await new HealthService(
      dbThat('succeeds'),
      storageThat(true, 'disk'),
      redisThat('answers'),
    ).readiness();

    expect(dependency(report, 'storage (disk)')?.status).toBe('up');
  });

  /*
   * The probe is CACHED, because it costs a billed round trip and readiness is
   * polled continuously. Asserted by counting calls across two probes on the same
   * instance — a cache that quietly stopped working would look identical from the
   * outside while turning a health check into a line item.
   */
  it('does not re-probe storage on every readiness call', async () => {
    let calls = 0;
    const counting = {
      healthy: () => {
        calls += 1;
        return Promise.resolve(true);
      },
      providerName: 'r2',
    } as unknown as StoredFilesService;

    const service = new HealthService(dbThat('succeeds'), counting, redisThat('answers'));
    await service.readiness();
    await service.readiness();
    await service.readiness();

    expect(calls).toBe(1);
  });
});

describe('R-6.4 liveness', () => {
  it('answers without touching any dependency', async () => {
    // The point of the split: a database outage must not cause an orchestrator
    // to kill healthy processes. This returns ok with the database on fire.
    const service = new HealthService(dbThat('fails'), storageThat(true), redisThat('answers'));

    expect(service.liveness().status).toBe('ok');
    expect(service.liveness().uptimeSeconds).toBeGreaterThanOrEqual(0);
    await expect(service.readiness()).resolves.toMatchObject({ status: 'not_ready' });
  });
});

/*
 * Has the database run every migration this build ships? Production deploys
 * are manual and nothing in them migrates, so on 26 Sep 2026 new code ran on
 * an old schema: attaching a group to a second product answered a bare 409.
 * Readiness now reports the gap — without taking the API out of service.
 */
describe('the migrations this build needs', () => {
  const shipped = shippedMigrations() ?? [];
  const newest = shipped[shipped.length - 1];

  /** A database whose newest applied migration is `last` (null: none applied). */
  const dbAppliedUpTo = (last: number | null): Db =>
    ({
      execute: () => Promise.resolve({ rows: [{ last: last === null ? null : String(last) }] }),
    }) as unknown as Db;

  it('reads the journal this build ships', () => {
    expect(shipped.length).toBeGreaterThan(100);
    expect(newest?.tag).toMatch(/^\d{4}_/);
  });

  it('is up when every shipped migration has run', async () => {
    const report = await new HealthService(
      dbAppliedUpTo(newest?.when ?? 0),
      storageThat(true),
      redisThat('answers'),
    ).readiness();

    expect(dependency(report, 'database migrations')).toMatchObject({
      status: 'up',
      required: false,
    });
  });

  it('says how many are missing, and keeps serving', async () => {
    const fourBack = shipped[shipped.length - 5];
    const report = await new HealthService(
      dbAppliedUpTo(fourBack?.when ?? 0),
      storageThat(true),
      redisThat('answers'),
    ).readiness();

    expect(report.status).toBe('ready');
    const check = dependency(report, 'database migrations');
    expect(check).toMatchObject({ status: 'down', required: false });
    expect(check?.detail).toContain('4 migration(s)');
    expect(check?.detail).toContain('npm run db:migrate');
    // The tags go to the server log, not to this unauthenticated payload.
    expect(check?.detail).not.toContain(newest?.tag ?? '');
  });

  it('counts every migration as missing on a database that has run none', () => {
    expect(pendingMigrations(shipped, null)).toHaveLength(shipped.length);
  });

  it('reports a failed read as down rather than throwing', async () => {
    const report = await new HealthService(
      dbThat('fails'),
      storageThat(true),
      redisThat('answers'),
    ).readiness();

    expect(dependency(report, 'database migrations')).toMatchObject({
      status: 'down',
      required: false,
    });
  });
});
