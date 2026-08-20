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
 * payout walk, a rate applied to the wrong base, a unit error
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
 * A deal without lots.
 *
 * It is no longer a meaningful distinction for `checkPlausible` — since
 * `per_lot` went (migration 0055) the share test applies to EVERY event,
 * lots or not — but the fixture stays because most of these cases are about
 * the arithmetic rather than the lot count. `DEAL` is the one with lots, and
 * the regressions at the bottom of that block are what pin the difference.
 */
const SHARE_BASE: RevenueEvent = {
  grossAmount: '1000.00000000',
  currency: 'USD',
  source: 'deal',
};

/** A deal with no lot count — the shape a revenue share is taken of. */
const DEAL_NO_LOTS: RevenueEvent = {
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
   * The two `per_lot` cases that stood here are gone with migration 0055: the
   * model was removed, `rateValue` has one unit, and a rate can no longer be
   * "silently treated as a percentage" because a percentage is all it can be.
   * The LOT COUNT still rides on the event — `checkPlausible` reads it — so the
   * fixtures keep carrying one.
   */

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
      terms([{ level: 1, rateValue: '70.0000' }]),
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

  /*
   * ── The regression that made this whole guard dead in production ──
   *
   * `checkPlausible` used to return `ok: true` the moment an event carried a
   * lot count, a leftover from `per_lot` (removed in migration 0055). The deal
   * feed is the only live accrual path and it ALWAYS sets lots, so the unit-
   * error backstop and its COMMISSION_CEILING_BREACH alert never fired on a
   * single real accrual.
   *
   * Every existing case above uses a lots-free fixture, which is precisely why
   * nothing caught it. These two use `DEAL` — the fixture with `lots: '10'` —
   * so the exemption cannot come back without turning this file red.
   */
  it('refuses an impossible total on a deal that CARRIES a lot count', () => {
    const verdict = checkPlausible(DEAL, [
      { ibUserId: 'ib-1', depth: 1, level: 1, amount: '70000.00000000' },
    ]);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain('unit error');
  });

  it('still accepts a sane share on a deal that carries a lot count', () => {
    const verdict = checkPlausible(DEAL, [
      { ibUserId: 'ib-1', depth: 1, level: 1, amount: '250.00000000' },
    ]);
    expect(verdict.ok).toBe(true);
  });
});

describe("the broker's revenue cap", () => {
  /*
   * The defect this exists to prevent, in one test: the shipped ladder was
   * Master 70% and Sub 30%, and each rung takes its share of the FULL revenue.
   * A two-level chain therefore paid out 100% and the house kept nothing —
   * silently, since `checkPlausible` only refuses totals GREATER than the base.
   */
  it('scales a chain that would pay out everything the broker earned', () => {
    const result = calculate(
      DEAL_NO_LOTS,
      [
        { ibUserId: 'master', depth: 2, level: 1 },
        { ibUserId: 'sub', depth: 1, level: 2 },
      ],
      terms([
        { level: 1, rateValue: '70.0000' },
        { level: 2, rateValue: '30.0000' },
      ]),
      '50',
    );

    const total = result.accruals.reduce((sum, a) => sum + Number(a.amount), 0);
    // 1000 of revenue, capped at 50% — the broker keeps 500 whatever the ladder says.
    expect(total).toBeCloseTo(500, 8);
    expect(result.skippedReason).toContain('cap');
  });

  it('keeps the ladder’s proportions when it scales', () => {
    const result = calculate(
      DEAL_NO_LOTS,
      [
        { ibUserId: 'master', depth: 2, level: 1 },
        { ibUserId: 'sub', depth: 1, level: 2 },
      ],
      terms([
        { level: 1, rateValue: '70.0000' },
        { level: 2, rateValue: '30.0000' },
      ]),
      '50',
    );

    const master = result.accruals.find((a) => a.ibUserId === 'master');
    const sub = result.accruals.find((a) => a.ibUserId === 'sub');
    // 70:30 before, 70:30 after — everyone earns less, nobody is zeroed.
    expect(Number(master?.amount)).toBeCloseTo(350, 8);
    expect(Number(sub?.amount)).toBeCloseTo(150, 8);
  });

  it('leaves a chain that already fits alone', () => {
    const result = calculate(
      DEAL_NO_LOTS,
      [{ ibUserId: 'ib-1', depth: 1, level: 1 }],
      terms([{ level: 1, rateValue: '30.0000' }]),
      '50',
    );
    expect(result.accruals[0]?.amount).toBe('300.00000000');
    expect(result.skippedReason).toBeUndefined();
  });

  /*
   * ── THE REGRESSION THIS BLOCK EXISTS FOR ──────────────────────────────────
   *
   * The cap was gated on `event.lots === undefined`, so any event carrying a lot
   * count skipped it. Every real commission carries one — `CommissionService`
   * sets `lots: position.lots` on the deal event, and a deal is the only source
   * that pays since deposits stopped being revenue.
   *
   * So the broker's floor was bypassed on every commission the running system
   * produced, and the tests above all passed because they used a fixture with no
   * lots. `DEAL` here is the shape production actually sends.
   */
  it('caps a revenue share on a deal that CARRIES lots', () => {
    const result = calculate(
      DEAL,
      [
        { ibUserId: 'master', depth: 2, level: 1 },
        { ibUserId: 'sub', depth: 1, level: 2 },
      ],
      terms([
        { level: 1, rateValue: '70.0000' },
        { level: 2, rateValue: '30.0000' },
      ]),
      '50',
    );

    expect(result.accruals.find((a) => a.ibUserId === 'master')?.amount).toBe('350.00000000');
    expect(result.accruals.find((a) => a.ibUserId === 'sub')?.amount).toBe('150.00000000');
    expect(result.skippedReason).toContain('cap');
  });

  /*
   * The two mixed-model cases that stood here are gone with migration 0055.
   * They pinned which legs counted toward the ceiling when a chain held a
   * revenue share above a per-lot rebate; with one model left, every leg counts
   * and there is no mixture to get wrong.
   *
   * What replaces them is the property those tests were really protecting: a
   * chain that fits is paid in full, and one that does not is scaled — both
   * covered above and in `the numbers` below.
   */
  it('leaves a two-rung chain alone when it fits inside the cap', () => {
    const result = calculate(
      DEAL,
      [
        { ibUserId: 'master', depth: 2, level: 1 },
        { ibUserId: 'sub', depth: 1, level: 2 },
      ],
      terms([
        { level: 1, rateValue: '30.0000' },
        { level: 2, rateValue: '10.0000' },
      ]),
      '50',
    );

    // 300 + 100 = 400, inside the 500 ceiling, so neither leg moves.
    expect(result.accruals.find((a) => a.ibUserId === 'master')?.amount).toBe('300.00000000');
    expect(result.accruals.find((a) => a.ibUserId === 'sub')?.amount).toBe('100.00000000');
    expect(result.skippedReason).toBeUndefined();
  });
});

/**
 * The arithmetic itself, at the scale the column stores.
 *
 * The engine's job is one multiplication and one division per leg, and every
 * bug this suite has caught lived in the EDGES of that: which base, which
 * rounding, which legs count toward the cap. These pin the numbers.
 */
describe('the numbers', () => {
  const chain = (level: number): ChainEntry[] => [{ ibUserId: 'ib-1', depth: 1, level }];

  /** Broker revenue × rate% → the partner's share, at 8dp. */
  const share = (
    grossAmount: string,
    rateValue: string,
    maxSharePct?: string,
  ): string | undefined =>
    calculate(
      { grossAmount, currency: 'USD', source: 'deal', lots: '1' },
      chain(1),
      terms([{ level: 1, rateValue }]),
      maxSharePct,
    ).accruals[0]?.amount;

  it.each([
    ['1000.00000000', '70.0000', '700.00000000'],
    ['1000.00000000', '30.0000', '300.00000000'],
    ['1000.00000000', '100.0000', '1000.00000000'],
    ['1000.00000000', '0.5000', '5.00000000'],
    ['0.00000001', '50.0000', '0.00000001'],
    ['33.33000000', '33.3300', '11.10888900'],
    // Seventeen significant digits — `Number()` is already wrong before the
    // multiplication, which is why nothing here touches one.
    ['12345678901.23456789', '10.0000', '1234567890.12345679'],
  ])('takes %s at %s%% → %s', (gross, rate, expected) => {
    expect(share(gross, rate)).toBe(expected);
  });

  it.each([
    // ceiling 500: the 70% leg alone exceeds it and scales to the whole ceiling.
    ['70.0000', '50', '500.00000000'],
    // ceiling 800: 70% is 700, under it, so it is paid in full.
    ['70.0000', '80', '700.00000000'],
    // A cap of 100 is not a no-op to reach — it is exactly the total, and
    // `greaterThan` must not fire on equality.
    ['100.0000', '100', '1000.00000000'],
  ])('a %s%% rate under a %s%% broker cap pays %s', (rate, cap, expected) => {
    expect(share('1000.00000000', rate, cap)).toBe(expected);
  });

  /*
   * A cap of 0 is a REAL setting, not a misconfiguration to be ignored: the
   * settings DTO validates `ibMaxRevenueSharePct` as 0–100, so an operator can
   * switch partner payouts off entirely and this is how they do it.
   *
   * What must NOT happen is a zero-amount accrual reaching the insert.
   * `ib_accruals_amount_positive` is a CHECK, and the service writes every
   * earner on a trade in one statement — so a single zero row refuses the whole
   * batch, including the legs that were owed something.
   */
  it('pays nobody under a cap of zero, and returns no rows rather than zero rows', () => {
    const result = calculate(
      DEAL,
      [
        { ibUserId: 'a', depth: 1, level: 1 },
        { ibUserId: 'b', depth: 2, level: 2 },
      ],
      terms([
        { level: 1, rateValue: '70.0000' },
        { level: 2, rateValue: '30.0000' },
      ]),
      '0',
    );

    expect(result.accruals).toEqual([]);
    expect(result.skippedReason).toContain('dropped');
  });

  it('drops only the leg that scales away, keeping the one that survives', () => {
    const result = calculate(
      { grossAmount: '1000.00000000', currency: 'USD', source: 'deal', lots: '1' },
      [
        { ibUserId: 'big', depth: 1, level: 1 },
        { ibUserId: 'dust', depth: 2, level: 2 },
      ],
      terms([
        { level: 1, rateValue: '99.9999' },
        { level: 2, rateValue: '0.0001' },
      ]),
      '0.00001',
    );

    /*
     * The ceiling is 0.0001 against a 1000.0000 total, so the factor is ~1e-7.
     * The 0.0001% leg is worth 0.001 before scaling and rounds to nothing after
     * it; the 99.9999% leg survives. Every returned row must be storable.
     */
    expect(result.accruals.every((a) => Number(a.amount) > 0)).toBe(true);
    expect(result.accruals.map((a) => a.ibUserId)).toEqual(['big']);
  });

  it('ignores a negative cap, which the settings layer cannot produce', () => {
    // `cap.isPositive()` is false only below zero — decimal.js treats +0 as
    // positive, which is what makes the zero case above a real cap. Pinned
    // because the two read alike and behave oppositely.
    expect(share('1000.00000000', '70.0000', '-10')).toBe('700.00000000');
  });

  it('never pays more than the ceiling, however many rungs share it', () => {
    const result = calculate(
      DEAL,
      [
        { ibUserId: 'a', depth: 1, level: 1 },
        { ibUserId: 'b', depth: 2, level: 2 },
      ],
      terms([
        { level: 1, rateValue: '55.5500' },
        { level: 2, rateValue: '44.4500' },
      ]),
      '37',
    );

    /*
     * The invariant, asserted as a SUM rather than per leg: rounding each scaled
     * leg to 8dp independently could push the total a dust above the ceiling,
     * and the broker's floor is a promise about the total.
     */
    const total = result.accruals.reduce((sum, a) => sum + Number(a.amount), 0);
    expect(total).toBeLessThanOrEqual(370);
    expect(total).toBeCloseTo(370, 6);
  });

  it('pays each rung its OWN rate before any cap applies', () => {
    const result = calculate(
      DEAL,
      [
        { ibUserId: 'sub', depth: 1, level: 2 },
        { ibUserId: 'master', depth: 2, level: 1 },
      ],
      terms([
        { level: 1, rateValue: '12.5000' },
        { level: 2, rateValue: '7.2500' },
      ]),
      '90',
    );

    // 1000 × 12.5% and 1000 × 7.25%. Together 197.50, well inside the 900
    // ceiling, so neither moves — the ladder is what decides, not the cap.
    expect(result.accruals.find((a) => a.ibUserId === 'master')?.amount).toBe('125.00000000');
    expect(result.accruals.find((a) => a.ibUserId === 'sub')?.amount).toBe('72.50000000');
    expect(result.skippedReason).toBeUndefined();
  });

  /*
   * LOTS DO NOT ENTER THE ARITHMETIC, and that is worth pinning now that they
   * once did. The event still carries a lot count — `checkPlausible` reads it,
   * and the deal feed supplies it — but with `per_lot` gone the only base is the
   * broker's revenue. A trade of 2.5 lots and one of 250 pay the same on the
   * same revenue.
   */
  it('ignores the lot count entirely', () => {
    const small = calculate(
      { grossAmount: '400.00000000', currency: 'USD', source: 'deal', lots: '2.5' },
      chain(1),
      terms([{ level: 1, rateValue: '25.0000' }]),
      '50',
    );
    const large = calculate(
      { grossAmount: '400.00000000', currency: 'USD', source: 'deal', lots: '250' },
      chain(1),
      terms([{ level: 1, rateValue: '25.0000' }]),
      '50',
    );

    expect(small.accruals[0]?.amount).toBe('100.00000000');
    expect(large.accruals[0]?.amount).toBe(small.accruals[0]?.amount);
  });

  it('rounds a half up at the eighth decimal rather than truncating', () => {
    // 0.000000125 → the stored scale has to resolve the ninth digit somehow,
    // and silently dropping it would lose a partner money on every trade.
    const result = share('0.00000025', '50.0000');
    expect(result).toBe('0.00000013');
  });
});
