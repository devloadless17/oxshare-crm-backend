import { describe, expect, it } from 'vitest';
import {
  calculate,
  checkPlausible,
  resolveChain,
  type ChainEntry,
  type ChainNode,
  type LevelTerms,
  type RevenueEvent,
} from './commission';

/**
 * The commission engine's pure core.
 *
 * Every assertion here covers a case with a WRONG answer that pays real money
 * and does not throw: a suspended partner still earning, a cycle hanging the
 * payout walk, a `per_lot` rate silently treated as a percentage, a unit error
 * paying seventy times a deposit. None of these surface as errors — they
 * surface as a balance somebody has to claw back.
 *
 * Mutation-checked when written: each guarantee was deliberately broken and the
 * named test failed on the right assertion. A test asserting "10% of 100 is 10"
 * would prove nothing on its own, which is why the ugly values and the refusal
 * paths carry most of the weight below.
 */

/**
 * A closed trade on which the BROKER kept 1000 — spread markup plus its own
 * commission. This is the only base a revenue share may be taken of.
 *
 * The fixture used to be a DEPOSIT of the same size, which is what made the
 * old numbers look reasonable and be wrong: 70% of a deposit is 70% of the
 * client's own money.
 */
const DEAL: RevenueEvent = {
  grossAmount: '1000.00000000',
  currency: 'USD',
  source: 'deal',
  lots: '10',
};

/**
 * A deal WITHOUT lots — the shape `checkPlausible` guards.
 *
 * The share test only applies where a share was taken, so per-lot events are
 * deliberately outside it: a rebate can exceed the broker's revenue on one
 * trade without being an error.
 */
const SHARE_BASE: RevenueEvent = {
  grossAmount: '1000.00000000',
  currency: 'USD',
  source: 'deal',
};

/** The same size, from the source a share may NOT be taken of. */
const DEPOSIT: RevenueEvent = {
  grossAmount: '1000.00000000',
  currency: 'USD',
  source: 'deposit',
};

function node(overrides: Partial<ChainNode> & { userId: string }): ChainNode {
  return { parentIbUserId: null, active: true, level: 1, ...overrides };
}

function lookupFrom(nodes: ChainNode[]): (id: string) => ChainNode | undefined {
  const map = new Map(nodes.map((n) => [n.userId, n]));
  return (id) => map.get(id);
}

function terms(entries: Partial<LevelTerms>[]): Map<number, LevelTerms> {
  return new Map(
    entries.map((entry) => {
      const full: LevelTerms = {
        level: entry.level ?? 1,
        payoutModel: entry.payoutModel ?? 'revenue_share',
        rateValue: entry.rateValue ?? '10.0000',
        enabled: entry.enabled ?? true,
      };
      return [full.level, full];
    }),
  );
}

describe('resolveChain', () => {
  it('pays nobody when the client was never referred', () => {
    expect(resolveChain(null, lookupFrom([]))).toEqual([]);
    expect(resolveChain(undefined, lookupFrom([]))).toEqual([]);
  });

  it('resolves the introducer alone when they have no parent', () => {
    const chain = resolveChain('ib-1', lookupFrom([node({ userId: 'ib-1', level: 1 })]));
    expect(chain).toEqual<ChainEntry[]>([{ ibUserId: 'ib-1', depth: 1, level: 1 }]);
  });

  it('resolves the introducer and their parent', () => {
    const chain = resolveChain(
      'ib-2',
      lookupFrom([
        node({ userId: 'ib-2', parentIbUserId: 'ib-1', level: 2 }),
        node({ userId: 'ib-1', level: 1 }),
      ]),
    );
    expect(chain.map((entry) => entry.ibUserId)).toEqual(['ib-2', 'ib-1']);
    expect(chain.map((entry) => entry.depth)).toEqual([1, 2]);
  });

  /*
   * Resolution stops at two. A third rung existing in the data must not earn —
   * without the cap the walk would keep climbing and pay a partner the ladder
   * does not reach.
   */
  it('never returns more than two rungs, however deep the tree is', () => {
    const chain = resolveChain(
      'ib-3',
      lookupFrom([
        node({ userId: 'ib-3', parentIbUserId: 'ib-2', level: 3 }),
        node({ userId: 'ib-2', parentIbUserId: 'ib-1', level: 2 }),
        node({ userId: 'ib-1', level: 1 }),
      ]),
    );
    expect(chain).toHaveLength(2);
    expect(chain.map((entry) => entry.ibUserId)).toEqual(['ib-3', 'ib-2']);
  });

  /*
   * A SUSPENDED partner earns nothing AND breaks the chain. Letting the parent
   * keep collecting through a suspended child would pay somebody for a
   * relationship the operator has just switched off.
   */
  it('stops at a suspended partner, so nobody above them earns through them', () => {
    const chain = resolveChain(
      'ib-2',
      lookupFrom([
        node({ userId: 'ib-2', parentIbUserId: 'ib-1', level: 2, active: false }),
        node({ userId: 'ib-1', level: 1 }),
      ]),
    );
    expect(chain).toEqual([]);
  });

  it('pays the introducer alone when only the parent is suspended', () => {
    const chain = resolveChain(
      'ib-2',
      lookupFrom([
        node({ userId: 'ib-2', parentIbUserId: 'ib-1', level: 2 }),
        node({ userId: 'ib-1', level: 1, active: false }),
      ]),
    );
    expect(chain.map((entry) => entry.ibUserId)).toEqual(['ib-2']);
  });

  it('pays nobody when the referring partner has no account row', () => {
    expect(resolveChain('ghost', lookupFrom([]))).toEqual([]);
  });

  /*
   * THE hang. Postgres cannot prevent a cycle on a self-referencing key, so
   * `seen` is the only thing between a mis-assigned parent and an infinite loop
   * ON THE MONEY PATH. Without it this test does not fail — it never returns.
   */
  it('terminates on a cycle instead of looping forever', () => {
    const chain = resolveChain(
      'ib-1',
      lookupFrom([
        node({ userId: 'ib-1', parentIbUserId: 'ib-2', level: 1 }),
        node({ userId: 'ib-2', parentIbUserId: 'ib-1', level: 2 }),
      ]),
    );
    // Two distinct partners, each once — nobody is paid twice for one deposit.
    expect(chain).toHaveLength(2);
    expect(new Set(chain.map((entry) => entry.ibUserId)).size).toBe(2);
  });
});

describe('calculate', () => {
  it('takes each earner at their OWN level rate', () => {
    const chain: ChainEntry[] = [
      { ibUserId: 'ib-2', depth: 1, level: 2 },
      { ibUserId: 'ib-1', depth: 2, level: 1 },
    ];
    const result = calculate(
      DEAL,
      chain,
      terms([
        { level: 1, rateValue: '5.0000' },
        { level: 2, rateValue: '10.0000' },
      ]),
    );

    // 10% and 5% of 1000 — NOT one rate applied to both.
    expect(result.accruals.map((a) => a.amount)).toEqual(['100.00000000', '50.00000000']);
  });

  /*
   * Fractional rates on an eight-decimal base. The assertion is an ugly value
   * on purpose: a refactor to `Number()` would still pass a `10% of 100` test
   * and fail this one.
   */
  it('keeps full precision on a fractional rate', () => {
    const result = calculate(
      { grossAmount: '12345678901234567.89', currency: 'USD', source: 'deal' },
      [{ ibUserId: 'ib-1', depth: 1, level: 1 }],
      terms([{ level: 1, rateValue: '2.5000' }]),
    );
    expect(result.accruals[0]?.amount).toBe('308641972530864.19725000');
  });

  /*
   * `per_lot` REFUSES rather than guessing. Treating the rate as a percentage
   * would pay a plausible wrong number; treating it as a flat amount would pay
   * the same on a $10 deposit as on a $10,000 one.
   */
  it('pays per_lot as a rate TIMES the lots, not a percentage', () => {
    const result = calculate(
      DEAL,
      [{ ibUserId: 'ib-1', depth: 1, level: 1 }],
      terms([{ level: 1, payoutModel: 'per_lot', rateValue: '2.5000' }]),
    );
    // 2.50 per lot × 10 lots. A percentage would have paid 25.00 of the 1000.
    expect(result.accruals).toEqual([
      { ibUserId: 'ib-1', depth: 1, level: 1, amount: '25.00000000' },
    ]);
  });

  it('refuses a per_lot level when the event carries no lots, and says why', () => {
    const result = calculate(
      { grossAmount: '1000.00000000', currency: 'USD', source: 'deal' },
      [{ ibUserId: 'ib-1', depth: 1, level: 1 }],
      terms([{ level: 1, payoutModel: 'per_lot', rateValue: '2.5000' }]),
    );
    expect(result.accruals).toEqual([]);
    expect(result.skippedReason).toContain('per_lot');
  });

  /*
   * THE REGRESSION THIS FILE EXISTS TO HOLD.
   *
   * A revenue share of a deposit paid 70% of the client's own money to their
   * partner — of the broker's funds, since a deposit is a liability. It ran in
   * production shape and the plausibility guard could not catch it, because a
   * share smaller than its base is what a CORRECT share looks like.
   */
  it('refuses to take a share of a deposit, whatever the rate', () => {
    const result = calculate(
      DEPOSIT,
      [{ ibUserId: 'ib-1', depth: 1, level: 1 }],
      terms([{ level: 1, payoutModel: 'revenue_share', rateValue: '70.0000' }]),
    );
    expect(result.accruals).toEqual([]);
    expect(result.skippedReason).toContain('deposit');
  });

  it('pays nothing for a disabled level, and says why', () => {
    const result = calculate(
      DEAL,
      [{ ibUserId: 'ib-1', depth: 1, level: 1 }],
      terms([{ level: 1, enabled: false }]),
    );
    expect(result.accruals).toEqual([]);
    expect(result.skippedReason).toContain('disabled');
  });

  it('pays nothing when the level has no configured terms', () => {
    const result = calculate(DEAL, [{ ibUserId: 'ib-1', depth: 1, level: 7 }], terms([]));
    expect(result.accruals).toEqual([]);
    expect(result.skippedReason).toContain('no configured terms');
  });

  /*
   * A zero or refunded base must never produce a NEGATIVE accrual — that would
   * be a debit dressed as an earning, and the accruals table's own CHECK
   * constraint would reject it at the last moment rather than here.
   */
  it('pays nothing on a non-positive base', () => {
    for (const gross of ['0', '-500.00000000']) {
      const result = calculate(
        { grossAmount: gross, currency: 'USD', source: 'deal' },
        [{ ibUserId: 'ib-1', depth: 1, level: 1 }],
        terms([{ level: 1 }]),
      );
      expect(result.accruals).toEqual([]);
    }
  });

  it('skips a leg that rounds to nothing rather than writing an empty accrual', () => {
    const result = calculate(
      { grossAmount: '0.00000001', currency: 'USD', source: 'deal' },
      [{ ibUserId: 'ib-1', depth: 1, level: 1 }],
      // 0.00000001 × 0.0001% is far below the 8dp the ledger stores.
      terms([{ level: 1, rateValue: '0.0001' }]),
    );
    expect(result.accruals).toEqual([]);
  });

  it('pays one earner while skipping another in the same chain', () => {
    const result = calculate(
      DEAL,
      [
        { ibUserId: 'ib-2', depth: 1, level: 2 },
        { ibUserId: 'ib-1', depth: 2, level: 1 },
      ],
      terms([
        { level: 1, enabled: false },
        { level: 2, rateValue: '10.0000' },
      ]),
    );
    expect(result.accruals).toHaveLength(1);
    expect(result.accruals[0]?.ibUserId).toBe('ib-2');
    expect(result.skippedReason).toContain('disabled');
  });
});

describe('checkPlausible', () => {
  /*
   * THE unit-error backstop. A rate entered as `70` meaning 70× rather than 70%
   * accrues seventy times the deposit — a number that looks like a large payout
   * rather than a bug, and that nothing else in the pipeline would question.
   */
  it('refuses a total that exceeds the revenue it is a share of', () => {
    const verdict = checkPlausible(SHARE_BASE, [
      { ibUserId: 'ib-1', depth: 1, level: 1, amount: '70000.00000000' },
    ]);
    expect(verdict.ok).toBe(false);
  });

  it('accepts a normal split of the same deposit', () => {
    const verdict = checkPlausible(SHARE_BASE, [
      { ibUserId: 'ib-2', depth: 1, level: 2, amount: '100.00000000' },
      { ibUserId: 'ib-1', depth: 2, level: 1, amount: '50.00000000' },
    ]);
    expect(verdict.ok).toBe(true);
  });

  /*
   * The ceiling is on the TOTAL, not per leg. Two legs each under the deposit
   * can still sum past it, which is the case a per-accrual check would miss.
   */
  it('refuses when the legs are individually fine but together exceed the base', () => {
    const verdict = checkPlausible(SHARE_BASE, [
      { ibUserId: 'ib-2', depth: 1, level: 2, amount: '600.00000000' },
      { ibUserId: 'ib-1', depth: 2, level: 1, amount: '600.00000000' },
    ]);
    expect(verdict.ok).toBe(false);
  });

  it('accepts a total exactly equal to the base', () => {
    const verdict = checkPlausible(SHARE_BASE, [
      { ibUserId: 'ib-1', depth: 1, level: 1, amount: '1000.00000000' },
    ]);
    expect(verdict.ok).toBe(true);
  });
});
