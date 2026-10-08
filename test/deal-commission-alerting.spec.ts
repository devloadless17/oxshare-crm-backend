import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DealCommissionScheduler } from '../src/modules/trading/mt5/deal-commission.scheduler';
import type { DealAccrualRun } from '../src/modules/trading/mt5/deal-commission.service';
import { ALERT_KINDS } from '../src/common/logging/alerts';

/**
 * The alarm on the queue that pays partners.
 *
 * ## Why this suite exists
 *
 * Holding un-accruable deals out of the batch is what stops one wrong rate from
 * stopping commission for everybody — but it also removes the only evidence
 * anybody ever had that something was stuck. A refused deal used to fill a log
 * with retries and jam a visible queue; now it sits quietly, harming nothing
 * and paying nobody.
 *
 * So the fix and this alarm are one change, not two. `deal-commission.spec.ts`
 * proves a stuck deal cannot starve the queue; this proves somebody is told it
 * is stuck. Without the second half the first half is a way to make an unpaid
 * partner harder to notice.
 *
 * No database: every branch here is a decision about numbers the service
 * already counted, and running it against Postgres would test the counting
 * again rather than the routing.
 */

/** One drain of the queue, with nothing wrong unless a case says so. */
function run(overrides: Partial<DealAccrualRun> = {}): DealAccrualRun {
  return {
    examined: 0,
    accrued: 0,
    accrualRows: 0,
    nothingOwed: 0,
    demo: 0,
    legsConsumed: 0,
    orphaned: 0,
    unrecorded: 0,
    deferred: 0,
    failed: 0,
    predating: 0,
    awaitingBacklogDecision: false,
    ...overrides,
  };
}

/** A scheduler over a queue that reports exactly what each case asks for. */
function schedulerReturning(...runs: DealAccrualRun[]): DealCommissionScheduler {
  const accruePending = vi.fn();
  for (const r of runs) accruePending.mockResolvedValueOnce(r);

  return new DealCommissionScheduler(
    {
      accruePending,
      backlog: vi.fn().mockResolvedValue(0),
      orphanBacklog: vi.fn().mockResolvedValue(0),
    } as never,
    /*
     * A lease this instance always wins. Leader election has its own suite; if
     * it were mocked to refuse here, every case in this file would pass by
     * never running the job at all — the worst kind of green.
     */
    { run: (_n: string, _t: number, work: () => Promise<void>) => work() } as never,
    /*
     * The interval drives the drain BUDGET now (0114), so the stub answers
     * `null` — `tradingTermsFrom` reads that as the hourly default, which is
     * what these timings were written against.
     */
    { getTrading: () => Promise.resolve(null) } as never,
    { confirmPending: vi.fn().mockResolvedValue({ confirmed: 0, failed: 0 }) } as never,
  );
}

/** Every alert line raised, in order — `raiseAlert` logs the payload as-is. */
function alertsRaised(errors: unknown[]) {
  return errors.filter(
    (arg): arg is { kind: string; severity: string; context: Record<string, number> } =>
      typeof arg === 'object' && arg !== null && 'alert' in arg,
  );
}

let errors: unknown[];

beforeEach(() => {
  errors = [];
  vi.spyOn(Logger.prototype, 'error').mockImplementation((arg: unknown) => {
    errors.push(arg);
  });
  // The other levels are noise here, and this suite deliberately drives the
  // orphan path, which warns.
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('the queue says when nothing is going to pay it', () => {
  it('stays silent on a healthy run', async () => {
    const scheduler = schedulerReturning(run({ examined: 5, accrued: 5, accrualRows: 5 }));

    await scheduler.accrue();

    expect(alertsRaised(errors)).toHaveLength(0);
  });

  it('stays silent on the handful of orphans every broker has', async () => {
    /*
     * A manager's own login and a broker-side test account trade, and nothing
     * will ever link them. Alerting on those is how this kind gets muted, and a
     * muted alert on the commission queue is worse than none — it reads as
     * coverage.
     */
    const scheduler = schedulerReturning(run({ orphaned: 12, unrecorded: 12 }));

    await scheduler.accrue();

    expect(alertsRaised(errors)).toHaveLength(0);
  });

  it('stays silent on deals whose account is recorded but has no client yet', async () => {
    /*
     * Production, 8 Oct 2026: the directory records every MT5 account (0166),
     * so other desks' accounts sit here with no client and their deals wait —
     * 119,000 and rising, with nothing wrong. Alarming on that fired every hour
     * for ever. Only a deal on a login with NO account row is a stall.
     */
    const scheduler = schedulerReturning(run({ orphaned: 119_000, unrecorded: 0 }));

    await scheduler.accrue();

    expect(alertsRaised(errors)).toHaveLength(0);
  });

  it('alerts once a batch of trades cannot be attributed to anybody', async () => {
    const scheduler = schedulerReturning(run({ orphaned: 200, unrecorded: 200 }));

    await scheduler.accrue();

    const [alert] = alertsRaised(errors);
    expect(alert.kind).toBe(ALERT_KINDS.COMMISSION_QUEUE_STALLED);
    expect(alert.context).toEqual({ refused: 0, unlinked: 200 });
  });

  it('alerts on refused deals at a far lower count, because a refusal is a mistake', async () => {
    /*
     * Ten rather than two hundred. An orphan is an ordinary state during
     * onboarding; a REFUSAL means the engine had something to pay and could
     * not, which is never ordinary and never fixes itself.
     */
    const scheduler = schedulerReturning(run({ deferred: 10 }));

    await scheduler.accrue();

    const [alert] = alertsRaised(errors);
    expect(alert.kind).toBe(ALERT_KINDS.COMMISSION_QUEUE_STALLED);
    expect(alert.severity).toBe('notify');
    expect(alert.context).toEqual({ refused: 10, unlinked: 0 });
  });

  it('does not fire again a minute later, because the cron runs every minute', async () => {
    const scheduler = schedulerReturning(run({ deferred: 40 }), run({ deferred: 40 }));

    await scheduler.accrue();
    await scheduler.accrue();

    // One line per hour, not sixty. An alert that repeats every minute is one
    // somebody filters out, and this is the last one that can afford that.
    expect(alertsRaised(errors)).toHaveLength(1);
  });

  it('fires immediately for a SECOND incident rather than waiting out the window', async () => {
    /*
     * The window has to be reset by the condition clearing, not just by time.
     * Otherwise a problem fixed at 09:05 buys silence until 10:00, and a fresh
     * one at 09:10 goes unreported for fifty minutes — which is exactly when
     * somebody is changing rates and most likely to break another.
     */
    const scheduler = schedulerReturning(
      run({ deferred: 40 }),
      run({ deferred: 0, examined: 3, accrued: 3 }),
      run({ deferred: 40 }),
    );

    await scheduler.accrue();
    await scheduler.accrue();
    await scheduler.accrue();

    expect(alertsRaised(errors)).toHaveLength(2);
  });

  it('reports a stuck queue even on a run that examined nothing', async () => {
    /*
     * The whole point of the fix is that stuck deals are no longer queued, so
     * they no longer appear in `examined`. A scheduler that returns early on
     * "no deals in the batch" would go silent precisely when the queue is at
     * its worst — which is the shape of the bug being fixed, moved one level up.
     */
    const scheduler = schedulerReturning(run({ examined: 0, deferred: 30 }));

    await scheduler.accrue();

    expect(alertsRaised(errors)).toHaveLength(1);
  });
});
