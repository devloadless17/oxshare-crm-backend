import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { JobLeaseService } from '../src/common/scheduling/job-lease.service';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * One instance runs each scheduled job — against real Postgres, because every
 * guarantee here is one the database makes.
 *
 * ## What this is protecting
 *
 * `@Cron` fires on EVERY instance. Correctness survives that: each money job is
 * idempotent by construction and says so in its own docblock. What does not
 * survive is the cost — four replicas are four drains of the same commission
 * queue, contending on the same rows to reach the outcome one of them would
 * have reached alone, with drain budgets long enough to overlap the next tick.
 *
 * ## Why the ORDER of those two sentences matters
 *
 * This is an optimisation, and it must stay one. `acquire` fails OPEN so a
 * database blip cannot turn "the coordination layer is down" into "no
 * commission was paid today" — and that is only safe because the jobs tolerate
 * running twice. A lease that failed closed would be a new single point of
 * failure in front of every scheduled job on the platform.
 */

let ctx: MoneyTestContext;
let leases: JobLeaseService;

const JOB = 'test.job';

async function leaseRow() {
  const { rows } = await ctx.db.execute<{ holder: string; expired: boolean }>(sql`
    SELECT holder, (expires_at <= now()) AS expired FROM job_leases WHERE name = ${JOB}
  `);
  return rows[0];
}

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  leases = new JobLeaseService(ctx.db);
}, 180_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

beforeEach(async () => {
  await ctx.db.execute(sql`DELETE FROM job_leases`);
});

describe('taking the lease', () => {
  it('runs the work and reports that it ran', async () => {
    const work = vi.fn().mockResolvedValue(undefined);

    await expect(leases.run(JOB, 60_000, work)).resolves.toBe(true);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('RELEASES on the way out, so the next tick is not blocked', async () => {
    /*
     * The expiry is a crash backstop, not the normal path. A job that ends must
     * hand the lease straight back — otherwise an hourly job with a ten-minute
     * TTL would be fine, and a one-minute job with a ten-minute TTL would run
     * once every ten minutes and nothing would say why.
     */
    await leases.run(JOB, 3_600_000, () => Promise.resolve());

    expect((await leaseRow()).expired).toBe(true);

    const second = vi.fn().mockResolvedValue(undefined);
    await expect(leases.run(JOB, 3_600_000, second)).resolves.toBe(true);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('releases even when the work THREW', async () => {
    /*
     * Otherwise one failing run becomes a silent outage lasting the whole TTL —
     * the scheduler logs the error and then the job simply stops happening.
     */
    await expect(
      leases.run(JOB, 3_600_000, () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');

    expect((await leaseRow()).expired).toBe(true);
  });
});

describe('while another instance holds it', () => {
  it('does NOT run the work', async () => {
    const other = new JobLeaseService(ctx.db);
    // Hold it without releasing, which is what a run in progress looks like.
    await ctx.db.execute(sql`
      INSERT INTO job_leases (name, holder, expires_at)
      VALUES (${JOB}, 'other-host#1', now() + interval '10 minutes')
    `);

    const work = vi.fn().mockResolvedValue(undefined);
    await expect(other.run(JOB, 60_000, work)).resolves.toBe(false);

    // The whole point: a skipped tick is a NON-EVENT. The holder is doing it.
    expect(work).not.toHaveBeenCalled();
  });

  it('does not steal a live lease, and leaves the holder alone', async () => {
    await ctx.db.execute(sql`
      INSERT INTO job_leases (name, holder, expires_at)
      VALUES (${JOB}, 'other-host#1', now() + interval '10 minutes')
    `);

    await leases.run(JOB, 60_000, () => Promise.resolve());

    /*
     * If the upsert had no `WHERE expires_at < now()` predicate it would always
     * win, every instance would take the lease from every other one on every
     * tick, and the table would look busy while doing nothing at all.
     */
    expect((await leaseRow()).holder).toBe('other-host#1');
  });

  it('TAKES OVER once the lease has expired', async () => {
    /*
     * The crash backstop. An instance that dies mid-job releases nothing, and
     * without this the job would never run again on any instance.
     */
    await ctx.db.execute(sql`
      INSERT INTO job_leases (name, holder, expires_at)
      VALUES (${JOB}, 'dead-host#9', now() - interval '1 minute')
    `);

    const work = vi.fn().mockResolvedValue(undefined);
    await expect(leases.run(JOB, 60_000, work)).resolves.toBe(true);
    expect(work).toHaveBeenCalledTimes(1);
  });
});

describe('when the lease table cannot be used', () => {
  it('FAILS OPEN and runs the job anyway', async () => {
    /*
     * The judgement this class rests on. Skipping when coordination is
     * unavailable would mean a database blip stops every scheduled job on every
     * instance — "no commission was paid today" — which is far worse than the
     * duplicate work the lease exists to avoid. The jobs are idempotent; the
     * optimisation is allowed to fail, the job is not.
     */
    const broken = new JobLeaseService({
      insert: () => {
        throw new Error('relation "job_leases" does not exist');
      },
      update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
    } as never);

    const work = vi.fn().mockResolvedValue(undefined);
    await expect(broken.run(JOB, 60_000, work)).resolves.toBe(true);
    expect(work).toHaveBeenCalledTimes(1);
  });
});
