import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { TransferResumeScheduler } from '../src/modules/payments/transfer-resume.scheduler';
import { ALERT_KINDS } from '../src/common/logging/alerts';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * THE FIRST TEST THIS FILE HAS EVER HAD.
 *
 * `transfer-resume.scheduler.ts` is 203 lines that run every minute against
 * money a client has already been debited for, and it had NO spec. That is not
 * an oversight anyone would notice: a resume path only executes when something
 * has already gone wrong, which is the hardest state to fixture and the easiest
 * to assume is rare.
 *
 * ## What is under test
 *
 * The alarm's NUMBER. `stale` is filtered out of `stuck`, and `stuck` is capped
 * at BATCH (10) and drained OLDEST FIRST — so the figure that reached the page
 * was never "how many transfers are stuck", it was "how many of the ten oldest
 * are", which saturates at ten precisely when things are getting worse.
 *
 * It matters because of how the loop behaves under a persistent failure: ten
 * transfers that cannot be resumed keep their place at the front of the queue
 * every minute, so newer pending transfers are never examined and therefore
 * never counted, however long they have been waiting. An operator reading
 * "10 transfers pending" while fifty are is under-reacting to a number this
 * system handed them.
 *
 * The commission engine met the same distinction and records it: it returns
 * `orphaned` and `deferred` as BACKLOGS rather than batch tallies.
 */
let ctx: MoneyTestContext;
let errors: unknown[];

beforeAll(async () => {
  ctx = await startMoneyTestDb();
}, 120_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

beforeEach(async () => {
  /*
   * Transfers cleared between cases, because this scheduler reads the WHOLE
   * table rather than anything the case owns. Without it the second case
   * inherits the first's 25 stuck rows and alarms on them — which is exactly
   * how the "raises nothing when they are young" floor first failed, correctly,
   * by catching an un-isolated fixture rather than a defect.
   */
  await ctx.db.execute(sql`DELETE FROM transfers`);
  errors = [];
  vi.spyOn(Logger.prototype, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(...args);
  });
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

/** Every alert payload raised, in order. */
function alertsRaised() {
  return errors.filter(
    (a): a is { alert: string; kind: string; context: Record<string, number> } =>
      typeof a === 'object' && a !== null && 'alert' in a,
  );
}

/**
 * A scheduler whose executor NEVER resolves anything — the persistent failure
 * this alarm exists for. The lease always succeeds: mocking it to refuse would
 * make every case here pass by never running the job, the worst kind of green.
 */
function scheduler(execute = vi.fn().mockResolvedValue({ state: 'pending' })) {
  return {
    sched: new TransferResumeScheduler(
      ctx.db,
      { execute } as never,
      { run: (_n: string, _t: number, work: () => Promise<void>) => work() } as never,
    ),
    execute,
  };
}

/** N pending transfers, all older than the stale threshold. */
async function seedStuck(n: number, ageMinutes = 60): Promise<string> {
  const { rows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name)
    VALUES (${`resume-${Date.now()}-${n}@test.local`}, 'x', 'Stuck', 'Client')
    RETURNING id
  `);
  const userId = rows[0].id;
  const { rows: w } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO wallets (user_id, currency, kind) VALUES (${userId}, 'USD', 'main') RETURNING id
  `);
  const { rows: a } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO trading_accounts (user_id, environment, currency, balance, status)
    VALUES (${userId}, 'live'::trading_environment, 'USD', '0', 'active'::trading_account_status)
    RETURNING id
  `);
  for (let i = 0; i < n; i += 1) {
    await ctx.db.execute(sql`
      INSERT INTO transfers (user_id, wallet_id, trading_account_id, direction, amount,
                             currency, state, created_at)
      VALUES (${userId}, ${w[0].id}, ${a[0].id}, 'wallet_to_account'::transfer_direction,
              '10.00000000', 'USD', 'pending'::transfer_state,
              now() - (${ageMinutes} || ' minutes')::interval)
    `);
  }
  return userId;
}

describe('the stuck-transfer alarm counts the BACKLOG, not the batch', () => {
  it('reports all 25 stuck transfers, not the 10 this run could look at', async () => {
    await seedStuck(25);

    await scheduler().sched.resume();

    const alerts = alertsRaised();
    const stuckAlert = alerts.find((a) => a.kind === ALERT_KINDS.TRANSFER_STUCK);
    expect(stuckAlert, 'no TRANSFER_STUCK alarm was raised at all').toBeDefined();

    /*
     * THE ASSERTION. Under the defect this read 10 — BATCH — however many were
     * actually waiting, because the number was derived from the slice the run
     * happened to select rather than from the table.
     */
    expect(
      stuckAlert!.context.count,
      'the alarm reported the batch size rather than the backlog',
    ).toBe(25);
    // And it still says what this particular run could reach, which is the
    // signal that the queue is not draining.
    expect(stuckAlert!.context.inThisBatch).toBe(10);
  });

  it('raises NOTHING when the pending transfers are young', async () => {
    // The floor: an alarm that fires on healthy state gets muted, and takes the
    // real ones with it. Two minutes old is ordinary, not stuck.
    await seedStuck(4, 2);

    await scheduler().sched.resume();

    expect(alertsRaised().filter((a) => a.kind === ALERT_KINDS.TRANSFER_STUCK)).toHaveLength(0);
  });
});

describe('the resume backoff (0123) — a stuck transfer leaves the front of the queue', () => {
  /*
   * Without this, `TransferResumeScheduler` drains OLDEST FIRST with LIMIT 10,
   * so ten transfers that can never be resumed keep their place at the head of
   * the queue every minute for ever and newer pending transfers are never
   * examined at all — not slowly, NEVER. The commission engine calls this shape
   * "the worst shape a money job can have" and solved it in 0092; this is that
   * mechanism, copied.
   */
  it('records the failure and pushes the row into the future', async () => {
    await seedStuck(1);
    const { sched } = scheduler(vi.fn().mockRejectedValue(new Error('MT5 refused the login')));

    await sched.resume();

    const { rows } = await ctx.db.execute<{
      resume_attempts: number;
      resume_last_error: string;
      future: boolean;
    }>(sql`
      SELECT resume_attempts, resume_last_error, (resume_after > now()) AS future
        FROM transfers LIMIT 1
    `);
    expect(rows[0].resume_attempts).toBe(1);
    expect(rows[0].resume_last_error).toContain('MT5 refused the login');
    expect(rows[0].future, 'the row was not backed off and still owns the queue').toBe(true);
    // AND IT IS STILL PENDING. The backoff decides how often, never what
    // happens to it — auto-failing a transfer MT5 may have applied would hand
    // the client their money twice.
    const { rows: state } = await ctx.db.execute<{ state: string }>(
      sql`SELECT state FROM transfers LIMIT 1`,
    );
    expect(state[0].state).toBe('pending');
  });

  it('holds a backed-off row OUT of the batch, so a newer transfer is reached', async () => {
    await seedStuck(1, 120); // the old, stuck one
    await ctx.db.execute(sql`UPDATE transfers SET resume_after = now() + interval '30 minutes'`);
    await seedStuck(1, 60); // a NEWER pending transfer behind it

    const { sched, execute } = scheduler();
    await sched.resume();

    /*
     * Exactly one execute, and it must be the NEWER row. Under the defect the
     * older one is selected every run and this newer transfer is never reached
     * — the starvation, in one assertion.
     */
    expect(execute).toHaveBeenCalledTimes(1);
    const { rows } = await ctx.db.execute<{ id: string }>(
      sql`SELECT id FROM transfers WHERE resume_after IS NULL`,
    );
    expect(execute).toHaveBeenCalledWith(rows[0].id);
  });

  it('STILL resumes a transfer that has never been attempted (resume_after IS NULL)', async () => {
    /*
     * THE TRAP THIS CASE EXISTS FOR. The gate is `IS NULL OR <= now()`. With a
     * bare `<= now()` the comparison against NULL is NULL — which is not TRUE —
     * so every FIRST attempt would be filtered out and the scheduler would
     * resume nothing at all, for ever, silently. It would look like a working
     * backoff and be a disabled one.
     */
    await seedStuck(3);
    const { sched, execute } = scheduler();

    await sched.resume();

    expect(execute, 'the backoff gate swallowed every first attempt').toHaveBeenCalledTimes(3);
  });
});
