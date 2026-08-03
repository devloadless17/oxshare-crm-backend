import { describe, expect, it } from 'vitest';
import {
  Accrual,
  IbNode,
  calculate,
  resolveChain,
  wouldCreateCycle,
} from './commission';

// ARCHITECTURE §11, fourth acceptance test: the two-level rule. Pure functions,
// so these run in milliseconds with no database — which is the point of the
// seam. §8.6: "an IB three levels above a trading client earns nothing".

const ib = (userId: string, parentIbUserId: string | null = null, status: IbNode['status'] = 'approved'): IbNode => ({
  userId,
  parentIbUserId,
  status,
  programId: 'prog-1',
});

const lookupFrom = (nodes: IbNode[]) => {
  const map = new Map(nodes.map((n) => [n.userId, n]));
  return (userId: string) => map.get(userId);
};

describe('§11 two-level test — resolveChain', () => {
  it('an L1 WITH an approved parent yields exactly two levels', () => {
    const lookup = lookupFrom([ib('L1', 'L2'), ib('L2')]);
    const chain = resolveChain('L1', lookup);
    expect(chain).toEqual([
      { ibUserId: 'L1', level: 1 },
      { ibUserId: 'L2', level: 2 },
    ]);
  });

  it('an L1 WITHOUT a parent yields exactly one level', () => {
    const lookup = lookupFrom([ib('L1', null)]);
    expect(resolveChain('L1', lookup)).toEqual([{ ibUserId: 'L1', level: 1 }]);
  });

  it('a THREE-DEEP chain still yields exactly two — the third earns nothing', () => {
    const lookup = lookupFrom([ib('L1', 'L2'), ib('L2', 'L3'), ib('L3')]);
    const chain = resolveChain('L1', lookup);
    expect(chain).toHaveLength(2);
    expect(chain.map((c) => c.ibUserId)).toEqual(['L1', 'L2']);
    expect(chain.some((c) => c.ibUserId === 'L3')).toBe(false);
  });

  it('a five-deep chain is still capped at two', () => {
    const lookup = lookupFrom([ib('A', 'B'), ib('B', 'C'), ib('C', 'D'), ib('D', 'E'), ib('E')]);
    expect(resolveChain('A', lookup)).toHaveLength(2);
  });
});

describe('resolveChain — approval gates the chain', () => {
  it('pays nobody when L1 is not approved', () => {
    for (const status of ['pending', 'rejected', 'suspended'] as const) {
      const lookup = lookupFrom([ib('L1', 'L2', status), ib('L2')]);
      expect(resolveChain('L1', lookup), `status ${status}`).toEqual([]);
    }
  });

  it('pays L1 only when the parent is not approved', () => {
    const lookup = lookupFrom([ib('L1', 'L2'), ib('L2', null, 'suspended')]);
    expect(resolveChain('L1', lookup)).toEqual([{ ibUserId: 'L1', level: 1 }]);
  });

  it('pays nobody when there is no referring IB at all', () => {
    const lookup = lookupFrom([]);
    expect(resolveChain(null, lookup)).toEqual([]);
    expect(resolveChain(undefined, lookup)).toEqual([]);
    expect(resolveChain('ghost', lookup)).toEqual([]);
  });
});

describe('resolveChain — cycle guard (§8.6)', () => {
  it('never pays the same IB twice when a parent points back', () => {
    const lookup = lookupFrom([ib('A', 'B'), ib('B', 'A')]);
    const chain = resolveChain('A', lookup);
    expect(chain).toEqual([
      { ibUserId: 'A', level: 1 },
      { ibUserId: 'B', level: 2 },
    ]);
    expect(new Set(chain.map((c) => c.ibUserId)).size).toBe(chain.length);
  });

  it('terminates on a self-parent instead of looping', () => {
    const lookup = lookupFrom([ib('A', 'A')]);
    expect(resolveChain('A', lookup)).toEqual([{ ibUserId: 'A', level: 1 }]);
  });

  // Resolution stops at L2, but assignment validation walks the whole ancestry:
  // a loop at any depth is nonsense data, and refusing it at write time is cheap.
  it('rejects parent assignments that would create a cycle at any depth', () => {
    const lookup = lookupFrom([ib('A', null), ib('B', 'A'), ib('C', 'B')]);
    expect(wouldCreateCycle('A', 'A', lookup)).toBe(true); // self
    expect(wouldCreateCycle('A', 'B', lookup)).toBe(true); // B's parent is A
    expect(wouldCreateCycle('A', 'C', lookup)).toBe(true); // C → B → A, deeper than L2
    expect(wouldCreateCycle('C', 'A', lookup)).toBe(false); // legitimate
  });
});

describe('calculate — the money maths (§6.1 decimals)', () => {
  const chain2 = [
    { ibUserId: 'L1', level: 1 as const },
    { ibUserId: 'L2', level: 2 as const },
  ];
  const program = {
    mode: 'commission' as const,
    method: 'spread_share' as const,
    commissionValue: '30', // 30% of spread revenue
    rebateValue: '0',
    l1Share: '70',
    l2Share: '30',
  };

  const byLevel = (accruals: Accrual[]) =>
    Object.fromEntries(accruals.map((a) => [a.level, a.amount]));

  it('splits the pool by the configured L1/L2 shares', () => {
    // pool = spread 2.0 × volume 5 × 30% = 3.0
    const result = calculate({ spread: '2.0', volume: '5' }, program, chain2);
    expect(result.base).toBe('3.00000000');
    const legs = byLevel(result.accruals);
    expect(legs[1]).toBe('2.10000000'); // 70% of 3
    expect(legs[2]).toBe('0.90000000'); // 30% of 3
  });

  it('never pays out more than the pool', () => {
    const result = calculate({ spread: '2.0', volume: '5' }, program, chain2);
    const paid = result.accruals.reduce((acc, a) => acc + Number(a.amount), 0);
    expect(paid).toBeLessThanOrEqual(Number(result.base));
  });

  it('holds precision where floats drift', () => {
    // 0.1 × 3 × 10% = 0.03 — a float would give 0.030000000000000006
    const result = calculate(
      { spread: '0.1', volume: '3' },
      { ...program, commissionValue: '10', l1Share: '100', l2Share: '0' },
      chain2,
    );
    expect(result.base).toBe('0.03000000');
    expect(byLevel(result.accruals)[1]).toBe('0.03000000');
  });

  it('pays only L1 when the chain has one entry', () => {
    const result = calculate({ spread: '2.0', volume: '5' }, program, [chain2[0]]);
    expect(result.accruals).toHaveLength(1);
    expect(result.accruals[0].level).toBe(1);
  });

  it('pays nobody when the chain is empty', () => {
    const result = calculate({ spread: '2.0', volume: '5' }, program, []);
    expect(result.accruals).toEqual([]);
    expect(result.base).toBe('3.00000000'); // pool exists; nobody is owed it
  });

  it('omits zero legs rather than writing empty accruals', () => {
    const result = calculate(
      { spread: '2.0', volume: '5' },
      { ...program, l1Share: '100', l2Share: '0' },
      chain2,
    );
    expect(result.accruals).toHaveLength(1);
    expect(result.accruals[0].ibUserId).toBe('L1');
  });
});

describe('calculate — declared methods (D-11 answered by configuration)', () => {
  const chain = [{ ibUserId: 'L1', level: 1 as const }];
  const base = { mode: 'commission' as const, rebateValue: '0', l1Share: '100', l2Share: '0' };

  it('per_lot pays value × volume, ignoring the spread', () => {
    const result = calculate(
      { spread: '999', volume: '2.5' },
      { ...base, method: 'per_lot', commissionValue: '8' },
      chain,
    );
    expect(result.base).toBe('20.00000000');
  });

  it('fixed_per_deal pays the same regardless of size', () => {
    const small = calculate({ spread: '1', volume: '0.01' }, { ...base, method: 'fixed_per_deal', commissionValue: '5' }, chain);
    const large = calculate({ spread: '9', volume: '100' }, { ...base, method: 'fixed_per_deal', commissionValue: '5' }, chain);
    expect(small.base).toBe('5.00000000');
    expect(large.base).toBe(small.base);
  });

  it('spread_share scales with volume — the documented assumption, stated', () => {
    const one = calculate({ spread: '2', volume: '1' }, { ...base, method: 'spread_share', commissionValue: '50' }, chain);
    const ten = calculate({ spread: '2', volume: '10' }, { ...base, method: 'spread_share', commissionValue: '50' }, chain);
    expect(one.base).toBe('1.00000000');
    expect(ten.base).toBe('10.00000000');
  });
});

describe('calculate — modes decide who is paid', () => {
  const chain = [{ ibUserId: 'L1', level: 1 as const }];
  const shape = { method: 'per_lot' as const, l1Share: '100', l2Share: '0' };

  it('commission mode pays the IB and no rebate', () => {
    const r = calculate({ spread: '1', volume: '1' }, { ...shape, mode: 'commission', commissionValue: '10', rebateValue: '0' }, chain);
    expect(r.accruals[0].amount).toBe('10.00000000');
    expect(r.rebate).toBe('0.00000000');
  });

  it('rebate mode pays the client and no IB', () => {
    const r = calculate({ spread: '1', volume: '1' }, { ...shape, mode: 'rebate', commissionValue: '0', rebateValue: '4' }, chain);
    expect(r.accruals).toEqual([]);
    expect(r.rebate).toBe('4.00000000');
  });

  it('hybrid mode pays both', () => {
    const r = calculate({ spread: '1', volume: '1' }, { ...shape, mode: 'hybrid', commissionValue: '10', rebateValue: '4' }, chain);
    expect(r.accruals[0].amount).toBe('10.00000000');
    expect(r.rebate).toBe('4.00000000');
  });
});
