import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommissionScheduler } from '../src/modules/ib/commission.scheduler';
import { DealCommissionScheduler } from '../src/modules/trading/mt5/deal-commission.scheduler';
import type { DealAccrualRun } from '../src/modules/trading/mt5/deal-commission.service';
import { ALERT_KINDS } from '../src/common/logging/alerts';

/**
 * The pipeline must drain faster than it fills — the property nothing tested.
 *
 * ## The ceiling this pins open
 *
 * Both jobs took ONE batch per run and stopped:
 *
 *   accruePending   200 deals   × once a minute = 288,000/day
 *   confirmPending  500 accruals × once an hour  =  12,000/day
 *
 * The second is the one that ends the platform. 100k clients holding two MT5
 * accounts each, trading once a day, produce hundreds of thousands of accruals
 * a day — a commission leg, an L2 leg, a client rebate. Against 12,000 drained,
 * the unpaid queue grows by more than an order of magnitude more than it sheds,
 * every day, for ever.
 *
 * And it is INVISIBLE, which is what makes it worth a suite: a run that credits
 * a full batch and a run that credits everything owed log the same sentence. The
 * first symptom is a partner asking where their money is.
 *
 * ## Why these are unit tests with fakes
 *
 * Every assertion here is about the LOOP — how many times the job calls the
 * service, and when it stops. Running it against Postgres would test the
 * service's own batching again, which `deal-commission.spec.ts` and
 * `ib-rebate.spec.ts` already do against real data.
 */

function accrualRun(overrides: Partial<DealAccrualRun> = {}): DealAccrualRun {
  return {
    examined: 0,
    accrued: 0,
    accrualRows: 0,
    nothingOwed: 0,
    legsConsumed: 0,
    orphaned: 0,
    deferred: 0,
    failed: 0,
    predating: 0,
    awaitingBacklogDecision: false,
    ...overrides,
  };
}

/**
 * A lease this instance always wins, so these cases test the DRAIN.
 *
 * Leader election is a separate concern with its own suite — mixing it in here
 * would mean every throughput assertion also depended on the lease, and a
 * failure could not tell you which of the two broke.
 */
const alwaysLeads = () =>
  ({
    run: (_name: string, _ttlMs: number, work: () => Promise<void>) => work(),
  }) as never;

let errors: unknown[];

beforeEach(() => {
  errors = [];
  vi.spyOn(Logger.prototype, 'error').mockImplementation((arg: unknown) => {
    errors.push(arg);
  });
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function alerts(kind: string) {
  return errors.filter(
    (arg): arg is { kind: string; severity: string } =>
      typeof arg === 'object' &&
      arg !== null &&
      'alert' in arg &&
      'kind' in arg &&
      arg.kind === kind,
  );
}

describe('the confirm job drains the payable queue', () => {
  it('keeps going while every batch comes back FULL', async () => {
    const confirmPending = vi
      .fn()
      .mockResolvedValueOnce({ confirmed: 500, failed: 0, held: 0 })
      .mockResolvedValueOnce({ confirmed: 500, failed: 0, held: 0 })
      .mockResolvedValue({ confirmed: 12, failed: 0, held: 0 });

    const scheduler = new CommissionScheduler({ confirmPending } as never, alwaysLeads(), {
      /* The interval drives the drain BUDGET now (0113), so the stub answers
         the hourly default this spec's timings were written against. */
      getTrading: () => Promise.resolve(null),
    } as never);
    await scheduler.confirm();

    /*
     * Three calls, not one. Before this, a thousand matured accruals took three
     * HOURS to pay because each run took 500 and went back to sleep.
     */
    expect(confirmPending).toHaveBeenCalledTimes(3);
  });

  it('stops on the first SHORT batch, so a quiet hour costs one query', async () => {
    const confirmPending = vi.fn().mockResolvedValue({ confirmed: 0, failed: 0, held: 0 });

    const scheduler = new CommissionScheduler({ confirmPending } as never, alwaysLeads(), {
      /* The interval drives the drain BUDGET now (0113), so the stub answers
         the hourly default this spec's timings were written against. */
      getTrading: () => Promise.resolve(null),
    } as never);
    await scheduler.confirm();

    // A short batch means nothing is due. Asking again cannot find more, and a
    // job that spins on an empty queue is worse than one that trickles.
    expect(confirmPending).toHaveBeenCalledTimes(1);
    expect(alerts(ALERT_KINDS.COMMISSION_QUEUE_STALLED)).toHaveLength(0);
  });

  it('a batch that FAILED still counts as drained work', async () => {
    /*
     * `failed` accruals stay pending and are retried next run. They must count
     * toward the batch being full, or a run where every accrual failed reads as
     * a short batch and the job stops early on exactly the queue that needs it.
     */
    const confirmPending = vi
      .fn()
      .mockResolvedValueOnce({ confirmed: 0, failed: 500, held: 0 })
      .mockResolvedValue({ confirmed: 1, failed: 0, held: 0 });

    const scheduler = new CommissionScheduler({ confirmPending } as never, alwaysLeads(), {
      /* The interval drives the drain BUDGET now (0113), so the stub answers
         the hourly default this spec's timings were written against. */
      getTrading: () => Promise.resolve(null),
    } as never);
    await scheduler.confirm();

    expect(confirmPending).toHaveBeenCalledTimes(2);
  });

  it('raises the backlog alarm when the budget runs out with the queue still full', async () => {
    /*
     * The signal that did not exist. Hitting the budget with full batches means
     * commission is being earned faster than it is being credited — the failure
     * that otherwise shows up as a support ticket months later.
     */
    vi.useFakeTimers();
    const confirmPending = vi.fn().mockImplementation(() => {
      // Every batch full, and each one burns two minutes of the budget.
      vi.advanceTimersByTime(2 * 60_000);
      return Promise.resolve({ confirmed: 500, failed: 0, held: 0 });
    });

    const scheduler = new CommissionScheduler({ confirmPending } as never, alwaysLeads(), {
      /* The interval drives the drain BUDGET now (0113), so the stub answers
         the hourly default this spec's timings were written against. */
      getTrading: () => Promise.resolve(null),
    } as never);
    await scheduler.confirm();
    vi.useRealTimers();

    const raised = alerts(ALERT_KINDS.COMMISSION_QUEUE_STALLED);
    expect(raised).toHaveLength(1);
    // Notify, not page: nothing is lost — the accrual rows are the record — and
    // the fix is a capacity decision made in working hours.
    expect(raised[0].severity).toBe('notify');
  });
});

describe('the accrual job drains the deal queue', () => {
  it('keeps going while every batch comes back FULL', async () => {
    const accruePending = vi
      .fn()
      .mockResolvedValueOnce(accrualRun({ examined: 200, accrued: 200, accrualRows: 200 }))
      .mockResolvedValue(accrualRun({ examined: 7, accrued: 7, accrualRows: 7 }));

    const scheduler = new DealCommissionScheduler(
      {
        accruePending,
        backlog: vi.fn().mockResolvedValue(0),
        orphanBacklog: vi.fn().mockResolvedValue(0),
      } as never,
      alwaysLeads(),
      /*
       * The interval drives the drain BUDGET now (0114), so the stub answers
       * `null` — `tradingTermsFrom` reads that as the hourly default, which is
       * what these timings were written against.
       */
      { getTrading: () => Promise.resolve(null) } as never,
    );
    await scheduler.accrue();

    expect(accruePending).toHaveBeenCalledTimes(2);
  });

  it('stops immediately when the engine is HOLDING for the backlog decision', async () => {
    /*
     * The hold does not resolve itself and answers identically every call, so
     * looping on it turns one honest message into a spin.
     */
    const accruePending = vi
      .fn()
      .mockResolvedValue(accrualRun({ awaitingBacklogDecision: true, orphaned: 3 }));

    const scheduler = new DealCommissionScheduler(
      {
        accruePending,
        backlog: vi.fn().mockResolvedValue(0),
        orphanBacklog: vi.fn().mockResolvedValue(0),
      } as never,
      alwaysLeads(),
      /*
       * The interval drives the drain BUDGET now (0114), so the stub answers
       * `null` — `tradingTermsFrom` reads that as the hourly default, which is
       * what these timings were written against.
       */
      { getTrading: () => Promise.resolve(null) } as never,
    );
    await scheduler.accrue();

    expect(accruePending).toHaveBeenCalledTimes(1);
  });

  it('reports a stuck backlog ONCE, not once per batch', async () => {
    /*
     * `orphaned` and `deferred` are backlog READINGS, not batch tallies — the
     * service re-counts them every run precisely because such deals never appear
     * in a batch. Summing them across a drain would multiply one stuck backlog
     * by the number of batches and alarm on a number that does not exist.
     */
    const accruePending = vi
      .fn()
      .mockResolvedValueOnce(accrualRun({ examined: 200, accrued: 200, orphaned: 250 }))
      .mockResolvedValue(accrualRun({ examined: 3, accrued: 3, orphaned: 250 }));

    const scheduler = new DealCommissionScheduler(
      {
        accruePending,
        backlog: vi.fn().mockResolvedValue(0),
        orphanBacklog: vi.fn().mockResolvedValue(0),
      } as never,
      alwaysLeads(),
      /*
       * The interval drives the drain BUDGET now (0114), so the stub answers
       * `null` — `tradingTermsFrom` reads that as the hourly default, which is
       * what these timings were written against.
       */
      { getTrading: () => Promise.resolve(null) } as never,
    );
    await scheduler.accrue();

    const raised = alerts(ALERT_KINDS.COMMISSION_QUEUE_STALLED);
    expect(raised).toHaveLength(1);
    // 250, the reading — not 500, the sum of two identical readings.
    expect((raised[0] as { context?: Record<string, number> }).context?.unlinked).toBe(250);
  });
});
