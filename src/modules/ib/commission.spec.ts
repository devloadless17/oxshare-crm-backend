import { describe, expect, it } from 'vitest';
import {
  calculate,
  checkPlausible,
  resolveChain,
  type ChainEntry,
  type ChainNode,
  type ProgramTerms,
  type RevenueEvent,
} from './commission';

/**
 * The commission engine's pure core.
 *
 * Every assertion here covers a case with a WRONG answer that pays real money
 * and does not throw: a suspended partner still earning, a cycle hanging the
 * payout walk, a rate applied to the wrong base, a unit error paying seventy
 * times the revenue, a rebate credited to the introducer instead of the client
 * it is owed to. None of these surface as errors — they surface as a balance
 * somebody has to claw back.
 *
 * Mutation-checked when written: each guarantee was deliberately broken and the
 * named test failed on the right assertion. A test asserting "10% of 1000 is
 * 100" would prove nothing on its own, which is why the ugly values and the
 * refusal paths carry most of the weight below.
 *
 * ## What changed when programmes landed, and why some numbers are mirrored
 *
 * The rate used to be keyed on the RUNG an earner occupied. It is keyed on
 * DEPTH now: `level1Rate` is what you earn from your OWN client, `level2Rate`
 * from a sub-partner's. So a sub-partner who introduced this client is paid the
 * level-1 rate — under the old model they were paid the level-2 rate for
 * business they had brought in themselves, which is the defect the change
 * fixes and the reason several expectations below are the mirror of what they
 * were.
 */

/**
 * A closed trade on which the BROKER kept 1000 — its own commission plus swap.
 * This is the only base a revenue share may be taken of.
 */
const DEAL: RevenueEvent = {
  grossAmount: '1000.00000000',
  currency: 'USD',
  source: 'deal',
  lots: '10',
};

/** The same size with no lot count. Lots never enter the arithmetic. */
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
  return { parentIbUserId: null, active: true, level: 1, programId: 'prog-a', ...overrides };
}

function lookupFrom(nodes: ChainNode[]): (id: string) => ChainNode | undefined {
  const map = new Map(nodes.map((n) => [n.userId, n]));
  return (id) => map.get(id);
}

/** One programme, defaulted to terms that pay both depths and no rebate. */
function program(overrides: Partial<ProgramTerms> & { id: string }): ProgramTerms {
  return {
    mode: 'commission_only',
    level1Rate: '10.0000',
    level2Rate: '5.0000',
    rebateRate: '0.0000',
    enabled: true,
    ...overrides,
  };
}

function programs(entries: ProgramTerms[]): Map<string, ProgramTerms> {
  return new Map(entries.map((entry) => [entry.id, entry]));
}

/** A chain entry. Every field of it decides a payment, so none is implicit. */
function earner(over: Partial<ChainEntry> & { ibUserId: string; depth: number }): ChainEntry {
  return { level: over.depth, programId: 'prog-a', ...over };
}

describe('resolveChain', () => {
  it('pays nobody when the client was never referred', () => {
    expect(resolveChain(null, lookupFrom([]))).toEqual([]);
    expect(resolveChain(undefined, lookupFrom([]))).toEqual([]);
  });

  it('resolves the introducer alone when they have no parent', () => {
    const chain = resolveChain('ib-1', lookupFrom([node({ userId: 'ib-1', level: 1 })]));
    expect(chain).toEqual<ChainEntry[]>([
      { ibUserId: 'ib-1', depth: 1, level: 1, programId: 'prog-a' },
    ]);
  });

  /*
   * The programme travels WITH the earner. Reading it from anywhere else — the
   * client, the deal, the first rung — pays one partner on another's negotiated
   * terms, and nothing about the resulting amount would look wrong.
   */
  it('carries each partner’s own programme into the chain', () => {
    const chain = resolveChain(
      'ib-2',
      lookupFrom([
        node({ userId: 'ib-2', parentIbUserId: 'ib-1', level: 2, programId: 'prog-b' }),
        node({ userId: 'ib-1', level: 1, programId: 'prog-a' }),
      ]),
    );

    expect(chain.map((c) => [c.ibUserId, c.depth, c.programId])).toEqual([
      ['ib-2', 1, 'prog-b'],
      ['ib-1', 2, 'prog-a'],
    ]);
  });

  it('never returns more than two rungs, however deep the tree is', () => {
    const chain = resolveChain(
      'ib-3',
      lookupFrom([
        node({ userId: 'ib-3', parentIbUserId: 'ib-2' }),
        node({ userId: 'ib-2', parentIbUserId: 'ib-1' }),
        node({ userId: 'ib-1' }),
      ]),
    );

    expect(chain).toHaveLength(2);
    expect(chain.map((c) => c.ibUserId)).toEqual(['ib-3', 'ib-2']);
  });

  /*
   * Suspension is a decision about a partner's whole subtree. Letting their
   * parent keep collecting through them pays somebody for a relationship the
   * operator has just switched off.
   */
  it('stops at a suspended partner, so nobody above them earns through them', () => {
    const chain = resolveChain(
      'ib-2',
      lookupFrom([
        node({ userId: 'ib-2', parentIbUserId: 'ib-1', active: false }),
        node({ userId: 'ib-1' }),
      ]),
    );

    expect(chain).toEqual([]);
  });

  it('pays the introducer alone when only the parent is suspended', () => {
    const chain = resolveChain(
      'ib-2',
      lookupFrom([
        node({ userId: 'ib-2', parentIbUserId: 'ib-1' }),
        node({ userId: 'ib-1', active: false }),
      ]),
    );

    expect(chain.map((c) => c.ibUserId)).toEqual(['ib-2']);
  });

  it('pays nobody when the referring partner has no account row', () => {
    expect(resolveChain('ghost', lookupFrom([]))).toEqual([]);
  });

  /*
   * Postgres cannot prevent a cycle on a self-referencing key, so this walk is
   * the only thing between a mis-assigned parent and a hung money path.
   */
  it('terminates on a cycle instead of looping forever', () => {
    const chain = resolveChain(
      'ib-1',
      lookupFrom([
        node({ userId: 'ib-1', parentIbUserId: 'ib-2' }),
        node({ userId: 'ib-2', parentIbUserId: 'ib-1' }),
      ]),
    );

    expect(chain.map((c) => c.ibUserId)).toEqual(['ib-1', 'ib-2']);
  });
});

describe('calculate — whose rate applies', () => {
  /*
   * THE regression the programme model exists for.
   *
   * `ib-2` is a level-2 partner who introduced this client themselves, so they
   * are paid the LEVEL-1 rate — what you earn from your own business. Their
   * parent, one hop from the trade, takes the level-2 rate. Keyed on the rung
   * instead, `ib-2` would collect 5% on a client they brought in while the
   * parent collected 10% on one they never met.
   */
  it('pays by DEPTH, not by the rung the earner sits on', () => {
    const result = calculate(
      DEAL,
      [
        earner({ ibUserId: 'ib-2', depth: 1, level: 2 }),
        earner({ ibUserId: 'ib-1', depth: 2, level: 1 }),
      ],
      programs([program({ id: 'prog-a', level1Rate: '10.0000', level2Rate: '5.0000' })]),
    );

    expect(result.accruals.map((a) => [a.ibUserId, a.amount])).toEqual([
      ['ib-2', '100.00000000'],
      ['ib-1', '50.00000000'],
    ]);
  });

  /*
   * Two partners in one chain on different negotiated terms — the case a single
   * rate ladder could not express at all, and the reason programmes exist.
   */
  it('pays each earner from their OWN programme', () => {
    const result = calculate(
      DEAL,
      [
        earner({ ibUserId: 'ib-2', depth: 1, programId: 'prog-b' }),
        earner({ ibUserId: 'ib-1', depth: 2, programId: 'prog-a' }),
      ],
      programs([
        program({ id: 'prog-a', level2Rate: '5.0000' }),
        program({ id: 'prog-b', level1Rate: '25.0000' }),
      ]),
    );

    expect(result.accruals.map((a) => [a.ibUserId, a.amount, a.rateValue])).toEqual([
      ['ib-2', '250.00000000', '25.0000'],
      ['ib-1', '50.00000000', '5.0000'],
    ]);
  });

  /*
   * A fractional rate on an eight-decimal base. The assertion is an ugly value
   * on purpose: a refactor to `Number()` still passes "10% of 1000" and fails
   * this one.
   */
  it('keeps full precision on a fractional rate', () => {
    const result = calculate(
      { grossAmount: '12345678901234567.89', currency: 'USD', source: 'deal' },
      [earner({ ibUserId: 'ib-1', depth: 1 })],
      programs([program({ id: 'prog-a', level1Rate: '2.5000' })]),
    );

    expect(result.accruals[0]?.amount).toBe('308641972530864.19725000');
  });

  /*
   * A share of a deposit is a share of the CLIENT's money. This was live once:
   * a level at 70% paid a partner $700 of the broker's own funds on a $1,000
   * deposit the client could still withdraw in full.
   */
  it('refuses to take a share of a deposit, whatever the rate', () => {
    const result = calculate(
      DEPOSIT,
      [earner({ ibUserId: 'ib-1', depth: 1 })],
      programs([program({ id: 'prog-a', level1Rate: '70.0000' })]),
    );

    expect(result.accruals).toEqual([]);
    expect(result.skippedReason).toContain('deposit');
  });

  it('pays nothing under a disabled programme, and says why', () => {
    const result = calculate(
      DEAL,
      [earner({ ibUserId: 'ib-1', depth: 1 })],
      programs([program({ id: 'prog-a', enabled: false })]),
    );

    expect(result.accruals).toEqual([]);
    expect(result.skippedReason).toContain('disabled');
  });

  it('pays nothing when the earner’s programme is missing entirely', () => {
    const result = calculate(DEAL, [earner({ ibUserId: 'ib-1', depth: 1 })], programs([]));

    expect(result.accruals).toEqual([]);
    expect(result.skippedReason).toContain('no configured programme');
  });

  it('pays nothing at a depth the programme rates at zero', () => {
    const result = calculate(
      DEAL,
      [earner({ ibUserId: 'ib-1', depth: 2 })],
      programs([program({ id: 'prog-a', level2Rate: '0.0000' })]),
    );

    expect(result.accruals).toEqual([]);
    expect(result.skippedReason).toContain('depth 2');
  });

  it('pays nothing on a non-positive base', () => {
    const result = calculate(
      { ...DEAL, grossAmount: '0.00000000' },
      [earner({ ibUserId: 'ib-1', depth: 1 })],
      programs([program({ id: 'prog-a' })]),
    );

    expect(result.accruals).toEqual([]);
    expect(result.skippedReason).toContain('non-positive');
  });

  /*
   * `ib_accruals_amount_positive` REFUSES a zero row, and every earner on a
   * trade is inserted in ONE statement — so a single dust-sized leg would take
   * down the accrual of every legitimate earner beside it.
   */
  it('skips a leg that rounds to nothing rather than writing an empty accrual', () => {
    const result = calculate(
      { ...DEAL, grossAmount: '0.00000001' },
      [earner({ ibUserId: 'ib-1', depth: 1 })],
      programs([program({ id: 'prog-a', level1Rate: '0.0001' })]),
    );

    expect(result.accruals).toEqual([]);
  });

  it('pays one earner while skipping another in the same chain', () => {
    const result = calculate(
      DEAL,
      [
        earner({ ibUserId: 'ib-2', depth: 1, programId: 'prog-b' }),
        earner({ ibUserId: 'ib-1', depth: 2, programId: 'prog-a' }),
      ],
      programs([
        program({ id: 'prog-a', enabled: false }),
        program({ id: 'prog-b', level1Rate: '10.0000' }),
      ]),
    );

    expect(result.accruals.map((a) => a.ibUserId)).toEqual(['ib-2']);
    expect(result.skippedReason).toContain('disabled');
  });
});

describe('calculate — the client’s rebate', () => {
  /*
   * The whole point of the mode. A commission-only programme paying a rebate
   * would hand the client money the broker never agreed to give back, on every
   * trade, silently.
   */
  it('pays no rebate under a commission-only programme', () => {
    const result = calculate(
      DEAL,
      [earner({ ibUserId: 'ib-1', depth: 1 })],
      programs([program({ id: 'prog-a', mode: 'commission_only', rebateRate: '5.0000' })]),
    );

    expect(result.rebate).toBeUndefined();
    expect(result.accruals).toHaveLength(1);
  });

  it('pays both legs under a hybrid programme', () => {
    const result = calculate(
      DEAL,
      [earner({ ibUserId: 'ib-1', depth: 1 })],
      programs([
        program({ id: 'prog-a', mode: 'hybrid', level1Rate: '10.0000', rebateRate: '5.0000' }),
      ]),
    );

    expect(result.accruals[0].amount).toBe('100.00000000');
    expect(result.rebate?.amount).toBe('50.00000000');
    expect(result.rebate?.rateValue).toBe('5.0000');
  });

  /*
   * `rebate_only` is a real model — the broker buys volume by handing the
   * spread back — and the partner earning nothing on it is the point rather
   * than an omission.
   */
  it('pays the client and no partner under a rebate-only programme', () => {
    const result = calculate(
      DEAL,
      [earner({ ibUserId: 'ib-1', depth: 1 })],
      programs([
        program({ id: 'prog-a', mode: 'rebate_only', level1Rate: '10.0000', rebateRate: '5.0000' }),
      ]),
    );

    expect(result.accruals).toEqual([]);
    expect(result.rebate?.amount).toBe('50.00000000');
    expect(result.skippedReason).toContain('rebate-only');
  });

  /*
   * THE attribution rule. The rebate is a term of the relationship the client is
   * actually in, so it comes from the partner who introduced them. A parent
   * further up setting it would be altering terms in a relationship they do not
   * own, and two programmes in one chain would otherwise have no defined answer
   * at all.
   */
  it('takes the rebate from the introducer’s programme, never the parent’s', () => {
    const result = calculate(
      DEAL,
      [
        earner({ ibUserId: 'ib-2', depth: 1, programId: 'prog-b' }),
        earner({ ibUserId: 'ib-1', depth: 2, programId: 'prog-a' }),
      ],
      programs([
        program({ id: 'prog-a', mode: 'hybrid', rebateRate: '90.0000' }),
        program({ id: 'prog-b', mode: 'hybrid', rebateRate: '2.0000' }),
      ]),
    );

    expect(result.rebate?.programId).toBe('prog-b');
    expect(result.rebate?.amount).toBe('20.00000000');
  });

  /*
   * `ibUserId` on a rebate is ATTRIBUTION, not entitlement. Reading it as the
   * beneficiary pays the introducer their own client's rebate — which balances
   * perfectly and is wrong about who holds the money.
   */
  it('records the introducer as the source of the rebate, not its recipient', () => {
    const result = calculate(
      DEAL,
      [earner({ ibUserId: 'ib-1', depth: 1 })],
      programs([program({ id: 'prog-a', mode: 'hybrid', rebateRate: '5.0000' })]),
    );

    expect(result.rebate?.ibUserId).toBe('ib-1');
  });

  it('omits a rebate that rounds away rather than writing an empty one', () => {
    const result = calculate(
      { ...DEAL, grossAmount: '0.00000001' },
      [earner({ ibUserId: 'ib-1', depth: 1 })],
      programs([program({ id: 'prog-a', mode: 'hybrid', rebateRate: '0.0001' })]),
    );

    expect(result.rebate).toBeUndefined();
  });

  it('pays no rebate on a deposit, exactly as it pays no commission', () => {
    const result = calculate(
      DEPOSIT,
      [earner({ ibUserId: 'ib-1', depth: 1 })],
      programs([program({ id: 'prog-a', mode: 'hybrid', rebateRate: '5.0000' })]),
    );

    expect(result.rebate).toBeUndefined();
  });

  /*
   * A suspended introducer breaks the chain before the rebate is reached, so
   * the client stops receiving one too. The conservative reading, deliberately:
   * the rebate is a term of the relationship the operator has just suspended.
   */
  it('pays no rebate when the chain resolves to nobody', () => {
    const result = calculate(
      DEAL,
      [],
      programs([program({ id: 'prog-a', mode: 'hybrid', rebateRate: '5.0000' })]),
    );

    expect(result.rebate).toBeUndefined();
    expect(result.accruals).toEqual([]);
  });
});

describe('the broker’s revenue cap', () => {
  /*
   * Each rung's rate is a share of the FULL revenue, so the rates ADD: a chain
   * at 70 + 30 pays out everything the house earned and leaves it nothing.
   */
  it('scales a chain that would pay out everything the broker earned', () => {
    const result = calculate(
      DEAL,
      [earner({ ibUserId: 'ib-2', depth: 1 }), earner({ ibUserId: 'ib-1', depth: 2 })],
      programs([program({ id: 'prog-a', level1Rate: '70.0000', level2Rate: '30.0000' })]),
      '50',
    );

    expect(result.accruals.map((a) => a.amount)).toEqual(['350.00000000', '150.00000000']);
    expect(result.skippedReason).toContain('cap');
  });

  it('keeps the proportions between the legs when it scales', () => {
    const result = calculate(
      DEAL,
      [earner({ ibUserId: 'ib-2', depth: 1 }), earner({ ibUserId: 'ib-1', depth: 2 })],
      programs([program({ id: 'prog-a', level1Rate: '60.0000', level2Rate: '30.0000' })]),
      '45',
    );

    // 2:1 before the cap, and 2:1 after it.
    expect(result.accruals[0].amount).toBe('300.00000000');
    expect(result.accruals[1].amount).toBe('150.00000000');
  });

  /*
   * THE hole the rebate could have opened. The client's leg comes out of the
   * same revenue, so a cap that scaled only the partners would let the total
   * exceed the broker's floor by exactly the rebate — while reporting that the
   * floor had been enforced.
   */
  it('counts the rebate inside the cap and scales it with the rest', () => {
    const result = calculate(
      DEAL,
      [earner({ ibUserId: 'ib-1', depth: 1 })],
      programs([
        program({ id: 'prog-a', mode: 'hybrid', level1Rate: '60.0000', rebateRate: '40.0000' }),
      ]),
      '50',
    );

    // 60:40 before, 60:40 after, and 500 in total rather than 1000.
    expect(result.accruals[0].amount).toBe('300.00000000');
    expect(result.rebate?.amount).toBe('200.00000000');
  });

  it('leaves a chain that already fits alone', () => {
    const result = calculate(
      DEAL,
      [earner({ ibUserId: 'ib-1', depth: 1 })],
      programs([program({ id: 'prog-a', level1Rate: '10.0000' })]),
      '50',
    );

    expect(result.accruals[0].amount).toBe('100.00000000');
    expect(result.skippedReason).toBeUndefined();
  });

  it('ignores a non-positive cap, which the settings layer cannot produce', () => {
    const result = calculate(
      DEAL,
      [earner({ ibUserId: 'ib-1', depth: 1 })],
      programs([program({ id: 'prog-a', level1Rate: '10.0000' })]),
      '-5',
    );

    expect(result.accruals[0].amount).toBe('100.00000000');
  });

  /*
   * Scaling can recreate exactly what the per-leg rounding guard removes, and a
   * zero row is refused by a CHECK constraint rather than stored harmlessly.
   */
  it('drops a leg that the cap scales below the storable minimum', () => {
    const result = calculate(
      { ...DEAL, grossAmount: '1.00000000' },
      [earner({ ibUserId: 'ib-1', depth: 1 })],
      programs([program({ id: 'prog-a', level1Rate: '99.0000' })]),
      '0.0000001',
    );

    expect(result.accruals).toEqual([]);
    expect(result.skippedReason).toContain('storable minimum');
  });

  it('drops the rebate when the cap scales it away', () => {
    const result = calculate(
      { ...DEAL, grossAmount: '1.00000000' },
      [earner({ ibUserId: 'ib-1', depth: 1 })],
      programs([program({ id: 'prog-a', mode: 'rebate_only', rebateRate: '99.0000' })]),
      '0.0000001',
    );

    expect(result.rebate).toBeUndefined();
  });
});

describe('checkPlausible', () => {
  const leg = (ibUserId: string, amount: string) => ({
    ibUserId,
    depth: 1,
    level: 1,
    programId: 'prog-a',
    rateValue: '10.0000',
    amount,
  });

  /*
   * The backstop against a unit error — `70` meaning 70% versus `70` meaning
   * 70× — reaching a wallet.
   */
  it('refuses a total that exceeds the revenue it is a share of', () => {
    const verdict = checkPlausible(DEAL_NO_LOTS, [leg('ib-1', '70000.00000000')]);

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain('exceeds');
  });

  it('accepts a normal share of the same revenue', () => {
    expect(checkPlausible(DEAL_NO_LOTS, [leg('ib-1', '100.00000000')]).ok).toBe(true);
  });

  it('refuses legs that are individually fine but together exceed the base', () => {
    const verdict = checkPlausible(DEAL_NO_LOTS, [
      leg('ib-1', '600.00000000'),
      leg('ib-2', '600.00000000'),
    ]);

    expect(verdict.ok).toBe(false);
  });

  it('accepts a total exactly equal to the base', () => {
    expect(checkPlausible(DEAL_NO_LOTS, [leg('ib-1', '1000.00000000')]).ok).toBe(true);
  });

  /*
   * The rebate leaves the broker by the same door. A check that ignored it
   * would pass a programme handing 900% back to the client while refusing one
   * paying 101% to a partner.
   */
  it('counts the rebate in the total it checks', () => {
    const verdict = checkPlausible(DEAL_NO_LOTS, [leg('ib-1', '600.00000000')], {
      ibUserId: 'ib-1',
      programId: 'prog-a',
      rateValue: '50.0000',
      amount: '600.00000000',
    });

    expect(verdict.ok).toBe(false);
  });

  /*
   * A lot count does NOT exempt an event. Both guards that used to do so dated
   * from `per_lot`, and because the live feed always sets `lots` they returned
   * `ok: true` on 100% of real accruals — the ceiling was dead code in
   * production while every test of it passed on a fixture with no lots.
   */
  it('refuses an impossible total on a deal that CARRIES a lot count', () => {
    expect(checkPlausible(DEAL, [leg('ib-1', '70000.00000000')]).ok).toBe(false);
  });

  it('still accepts a sane share on a deal that carries a lot count', () => {
    expect(checkPlausible(DEAL, [leg('ib-1', '100.00000000')]).ok).toBe(true);
  });
});

describe('the numbers', () => {
  it('ignores the lot count entirely', () => {
    const withLots = calculate(
      { ...DEAL, lots: '10000' },
      [earner({ ibUserId: 'ib-1', depth: 1 })],
      programs([program({ id: 'prog-a', level1Rate: '10.0000' })]),
    );
    const without = calculate(
      DEAL_NO_LOTS,
      [earner({ ibUserId: 'ib-1', depth: 1 })],
      programs([program({ id: 'prog-a', level1Rate: '10.0000' })]),
    );

    expect(withLots.accruals[0].amount).toBe(without.accruals[0].amount);
  });

  it('rounds a half up at the eighth decimal rather than truncating', () => {
    const result = calculate(
      { ...DEAL, grossAmount: '0.00000005' },
      [earner({ ibUserId: 'ib-1', depth: 1 })],
      programs([program({ id: 'prog-a', level1Rate: '50.0000' })]),
    );

    // 0.00000005 × 50% = 0.000000025 → 0.00000003, not 0.00000002.
    expect(result.accruals[0].amount).toBe('0.00000003');
  });

  /*
   * Pinned so the division stays a division. A rate multiplied by 100 instead
   * of divided by it passes every "10% of 1000" assertion above — it is only
   * visible against a rate whose two readings differ by four orders of
   * magnitude.
   */
  it('divides the rate by a hundred, so 200% is twice the revenue and not 200×', () => {
    const result = calculate(
      DEAL,
      [earner({ ibUserId: 'ib-1', depth: 1 })],
      programs([program({ id: 'prog-a', level1Rate: '200.0000' })]),
    );

    expect(result.accruals[0].amount).toBe('2000.00000000');
  });
});
