import { describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { HealthService } from '../src/modules/health/health.service';
import type { DependencyHealthDto, ReadinessDto } from '../src/modules/health/dto/health.dto';
import type { Db } from '../src/database/db';

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

const configWith = (values: Record<string, string>) =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigService;

const dependency = (report: ReadinessDto, name: string): DependencyHealthDto | undefined =>
  report.dependencies.find((d) => d.name === name);

describe('R-6.4 readiness', () => {
  it('is ready, and times the probe, when Postgres answers', async () => {
    const report = await new HealthService(dbThat('succeeds'), configWith({})).readiness();

    expect(report.status).toBe('ready');
    expect(dependency(report, 'postgres')).toMatchObject({ status: 'up', required: true });
    expect(dependency(report, 'postgres')?.latencyMs).toBeTypeOf('number');
  });

  it('is NOT ready, with a required dependency down, when Postgres fails', async () => {
    const report = await new HealthService(dbThat('fails'), configWith({})).readiness();

    expect(report.status).toBe('not_ready');
    expect(dependency(report, 'postgres')).toMatchObject({ status: 'down', required: true });
  });

  it('never leaks connection detail to an unauthenticated caller', async () => {
    // /health/ready is public. A raw pg error echoes the host, port and user
    // back to whoever asked; the reason belongs in the logs, not the response.
    const report = await new HealthService(dbThat('fails'), configWith({})).readiness();

    expect(dependency(report, 'postgres')?.detail).not.toMatch(/connection terminated/);
    expect(dependency(report, 'postgres')?.detail).toMatch(/server logs/);
  });

  it('gives up on a hanging database instead of hanging with it', async () => {
    // Without the probe timeout this test would never finish — which is exactly
    // what an unreachable host does to a readiness endpoint that has none.
    const report = await new HealthService(dbThat('hangs'), configWith({})).readiness();

    expect(report.status).toBe('not_ready');
    expect(dependency(report, 'postgres')?.status).toBe('down');
  }, 10_000);

  it('reports unbuilt dependencies as not_configured, and stays ready', async () => {
    // Redis and the bridge are later milestones. Reporting them as `down` would
    // make every instance permanently unready; omitting them would let "ready"
    // quietly mean "ready apart from the parts nobody checked".
    const report = await new HealthService(dbThat('succeeds'), configWith({})).readiness();

    expect(report.status).toBe('ready');
    expect(dependency(report, 'redis')).toMatchObject({
      status: 'not_configured',
      required: false,
    });
    expect(dependency(report, 'mt5-bridge')?.status).toBe('not_configured');
  });

  it('shows a configured-but-unprobed dependency as up rather than missing', async () => {
    const report = await new HealthService(
      dbThat('succeeds'),
      configWith({ REDIS_URL: 'redis://localhost:6379' }),
    ).readiness();

    expect(dependency(report, 'redis')?.status).toBe('up');
    expect(dependency(report, 'redis')?.detail).toMatch(/not probed yet/);
  });
});

describe('R-6.4 liveness', () => {
  it('answers without touching any dependency', async () => {
    // The point of the split: a database outage must not cause an orchestrator
    // to kill healthy processes. This returns ok with the database on fire.
    const service = new HealthService(dbThat('fails'), configWith({}));

    expect(service.liveness().status).toBe('ok');
    expect(service.liveness().uptimeSeconds).toBeGreaterThanOrEqual(0);
    await expect(service.readiness()).resolves.toMatchObject({ status: 'not_ready' });
  });
});
