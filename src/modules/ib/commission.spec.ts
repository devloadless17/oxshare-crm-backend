import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import {
  calculate,
  checkPlausible,
  resolveChain,
  MAX_CHAIN_DEPTH,
  type ChainEntry,
  type ChainNode,
  type CommissionTypeTerms,
  type LevelTerms,
  type RevenueEvent,
} from './commission';

/**
 * The commission engine's pure core.
 *
 * Every assertion here covers a case with a WRONG answer that pays real money
 * and does not throw: a suspended partner still earning, a cycle hanging the
 * payout walk, a share applied to the wrong pool, a unit error paying a
 * hundred times the rate card, a rebate credited to the introducer instead of
 * the client it is owed to, a trade on an unlinked account marked done having
 * paid nobody. None of these surface as errors — they surface as a balance
 * somebody has to claw back, or as one nobody ever receives.
 *
 * ## The model under test (0140)
 *
 *     partner at level N  earns  lots × type.commissionPerLot × level_N.commissionShare / 100
 *     the trading client  gets   lots × type.rebatePerLot     × introducer.rebateShare  / 100
 *
 * The TYPE is the traded product's rate card; a LEVEL is a percentage of it,
 * keyed on the earner's own rung. The shares of the rungs in a chain are
 * INDEPENDENT — level 1 takes its full share on a sub-partner's client's trade
 * — which is 0114's rule kept, and several expectations below are shaped by it.
 */

/** The product's rate card: $10 a lot to the partners, $3 a lot back to the client. */
const TYPE: CommissionTypeTerms = {
  id: 'type-standard',
  name: 'Standard terms',
  enabled: true,
  commissionPerLot: '10.00000000',
  rebatePerLot: '3.00000000',
};

/** A closed trade of TWO lots on that product: a $20 commission pool, a $6 rebate pool. */
const DEAL: RevenueEvent = {
  currency: 'USD',
  source: 'deal',
  lots: '2',
  terms: TYPE,
};

/** The same size, from the source a share may NOT be taken of. */
const DEPOSIT: RevenueEvent = {
  currency: 'USD',
  source: 'deposit',
  lots: '2',
  terms: TYPE,
};

/**
 * A partner in the tree.
 *
 * `level` defaults to 1 — a partner dealing with the broker directly. Tests
 * about a recruited partner set it, because that is what decides their share.
 */
function node(overrides: Partial<ChainNode> & { userId: string }): ChainNode {
  return { parentIbUserId: null, active: true, level: 1, ...overrides };
}

function lookupFrom(nodes: ChainNode[]): (id: string) => ChainNode | undefined {
  const map = new Map(nodes.map((n) => [n.userId, n]));
  return (id) => map.get(id);
}

/**
 * One rung of the ladder: 70% of the product's commission to the partner, 50%
 * of its rebate to the client, unless a test says otherwise.
 */
function level(over: Partial<LevelTerms> & { level: number }): LevelTerms {
  return {
    id: `lvl-${over.level}`,
    enabled: true,
    commissionShare: '70.0000',
    rebateShare: '50.0000',
    ...over,
  };
}

/** The ladder, keyed by rung — the shape `calculate` reads. */
function ladderOf(...rungs: LevelTerms[]): Map<number, LevelTerms> {
  return new Map(rungs.map((rung) => [rung.level, rung]));
}

/** The default two-rung ladder: 70% at level 1, 30% at level 2. */
function defaultLadder(): Map<number, LevelTerms> {
  return ladderOf(level({ level: 1 }), level({ level: 2, commissionShare: '30.0000' }));
}

/**
 * A chain entry. Every field decides a payment, so none is implicit.
 *
 * `level` defaults to the entry's DEPTH, which is the common case in these
 * tests — a chain read straight up from the client, where the introducer is a
 * level 1 and their parent a level 2. Tests about the difference between the
 * two pass `level` explicitly.
 */
function earner(over: Partial<ChainEntry> & { ibUserId: string; depth: number }): ChainEntry {
  return { level: over.depth, ...over };
}

describe('resolveChain', () => {
  it('pays nobody when the client was never referred', () => {
    expect(resolveChain(null, lookupFrom([]))).toEqual([]);
    expect(resolveChain(undefined, lookupFrom([]))).toEqual([]);
  });

  it('resolves the introducer alone when they have no parent', () => {
    const chain = resolveChain('ib-1', lookupFrom([node({ userId: 'ib-1' })]));
    expect(chain).toEqual<ChainEntry[]>([
      { ibUserId: 'ib-1', depth: 1, level: 1, programId: undefined },
    ]);
  });

  /*
   * The historical programme travels WITH the earner, so an accrual for a
   * partner never re-levelled still records what used to price them.
   */
  it('carries each partner’s own programme into the chain', () => {
    const chain = resolveChain(
      'ib-2',
      lookupFrom([
        node({ userId: 'ib-2', parentIbUserId: 'ib-1', programId: 'prog-b' }),
        node({ userId: 'ib-1', programId: 'prog-a' }),
      ]),
    );

    expect(chain.map((c) => [c.ibUserId, c.depth, c.programId])).toEqual([
      ['ib-2', 1, 'prog-b'],
      ['ib-1', 2, 'prog-a'],
    ]);
  });

  /*
   * THE 0102 regression, and the reason the walk had to stop being capped at 2.
   *
   * A three-deep chain used to return two entries, so the third ancestor was
   * unreachable however the ladder was configured. `calculate` is what decides
   * who is PAID; resolution must reach far enough for it to be asked.
   */
  it('resolves past two, so a third-level ancestor can be considered at all', () => {
    const chain = resolveChain(
      'ib-3',
      lookupFrom([
        node({ userId: 'ib-3', parentIbUserId: 'ib-2' }),
        node({ userId: 'ib-2', parentIbUserId: 'ib-1' }),
        node({ userId: 'ib-1' }),
      ]),
    );

    expect(chain.map((c) => [c.ibUserId, c.depth])).toEqual([
      ['ib-3', 1],
      ['ib-2', 2],
      ['ib-1', 3],
    ]);
  });

  /*
   * The cycle guard, on a chain with no cycle in it. `MAX_CHAIN_DEPTH` is not a
   * payout policy — how far earnings travel is which rungs are on the ladder —
   * but an unbounded walk over a self-referencing key is the one thing that
   * hangs the money path, so the bound is asserted rather than assumed.
   */
  it('stops walking at MAX_CHAIN_DEPTH, however deep the tree is', () => {
    const deep = Array.from({ length: MAX_CHAIN_DEPTH + 5 }, (_, index) =>
      node({
        userId: `ib-${index}`,
        parentIbUserId: index === MAX_CHAIN_DEPTH + 4 ? null : `ib-${index + 1}`,
      }),
    );

    const chain = resolveChain('ib-0', lookupFrom(deep));

    expect(chain).toHaveLength(MAX_CHAIN_DEPTH);
    expect(chain.at(-1)?.depth).toBe(MAX_CHAIN_DEPTH);
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

describe('calculate — whose share applies', () => {
  it('pays the introducer their rung’s share of the product’s commission', () => {
    const result = calculate(DEAL, [earner({ ibUserId: 'ib-1', depth: 1 })], defaultLadder());

    /* 70% of a $20 pool (2 lots × $10). */
    expect(result.accruals).toEqual([
      {
        ibUserId: 'ib-1',
        depth: 1,
        levelId: 'lvl-1',
        programId: undefined,
        commissionTypeId: 'type-standard',
        rateValue: '70.0000',
        baseAmount: '20.00000000',
        amount: '14.00000000',
      },
    ]);
    expect(result.skippedReason).toBeUndefined();
    expect(result.unpriceable).toBeUndefined();
  });

  /*
   * ── THE SHARES ARE INDEPENDENT, AND THAT IS 0114's RULE ─────────────────
   *
   * On a sub-partner's client's trade the sub takes their share AND the main
   * partner takes their own in full. Nothing is carved out of anybody:
   * recruiting must not reduce what the main partner earns.
   */
  it('pays each earner from their OWN rung, independently of the others', () => {
    const result = calculate(
      DEAL,
      [
        earner({ ibUserId: 'ib-2', depth: 1, level: 2 }),
        earner({ ibUserId: 'ib-1', depth: 2, level: 1 }),
      ],
      defaultLadder(),
    );

    expect(result.accruals.map((a) => [a.ibUserId, a.depth, a.rateValue, a.amount])).toEqual([
      ['ib-2', 1, '30.0000', '6.00000000'],
      ['ib-1', 2, '70.0000', '14.00000000'],
    ]);
  });

  /*
   * The rung is a property of the PARTNER, not of the trade. A level 1
   * partner is paid the same on their own client's trade (depth 1) and on a
   * sub-partner's (depth 2): the depth is recorded, the share does not move.
   */
  it('pays a rung the same wherever in the chain the trade happened', () => {
    const own = calculate(
      DEAL,
      [earner({ ibUserId: 'ib-1', depth: 1, level: 1 })],
      defaultLadder(),
    );
    const below = calculate(
      DEAL,
      [
        earner({ ibUserId: 'ib-2', depth: 1, level: 2 }),
        earner({ ibUserId: 'ib-1', depth: 2, level: 1 }),
      ],
      defaultLadder(),
    );

    const mainOwn = own.accruals.find((a) => a.ibUserId === 'ib-1');
    const mainBelow = below.accruals.find((a) => a.ibUserId === 'ib-1');
    expect(mainOwn?.amount).toBe('14.00000000');
    expect(mainBelow?.amount).toBe('14.00000000');
    expect(mainOwn?.depth).toBe(1);
    expect(mainBelow?.depth).toBe(2);
  });

  /*
   * The arrangement this deployment ran before 0140 — "$10 to the main partner,
   * $3 to the sub" — is a 100% / 30% ladder on a $10 type. Pinned so the
   * conversion has a number to be checked against, and because the sum being
   * MORE than the type's figure is the model working, not a fault.
   */
  it('reproduces the old $10 main / $3 sub arrangement with 100% and 30%', () => {
    const result = calculate(
      { ...DEAL, lots: '1' },
      [
        earner({ ibUserId: 'sub', depth: 1, level: 2 }),
        earner({ ibUserId: 'main', depth: 2, level: 1 }),
      ],
      ladderOf(
        level({ level: 1, commissionShare: '100.0000' }),
        level({ level: 2, commissionShare: '30.0000' }),
      ),
    );

    expect(result.accruals.map((a) => [a.ibUserId, a.amount])).toEqual([
      ['sub', '3.00000000'],
      ['main', '10.00000000'],
    ]);
  });

  it('scales with volume, because every term is per lot', () => {
    const half = calculate(
      { ...DEAL, lots: '0.5' },
      [earner({ ibUserId: 'ib-1', depth: 1 })],
      defaultLadder(),
    );
    const ten = calculate(
      { ...DEAL, lots: '10' },
      [earner({ ibUserId: 'ib-1', depth: 1 })],
      defaultLadder(),
    );

    expect(half.accruals[0]?.amount).toBe('3.50000000');
    expect(ten.accruals[0]?.amount).toBe('70.00000000');
  });

  it('keeps full precision on a fractional share', () => {
    const result = calculate(
      { ...DEAL, lots: '1' },
      [earner({ ibUserId: 'ib-1', depth: 1 })],
      ladderOf(level({ level: 1, commissionShare: '33.3333' })),
    );

    expect(result.accruals[0]?.amount).toBe('3.33333000');
    expect(result.accruals[0]?.rateValue).toBe('33.3333');
  });

  /*
   * A rung the ladder does not reach pays nothing AND SAYS SO. The rest of the
   * chain is unaffected: one partner's missing rung must not cancel another's.
   */
  it('pays nobody standing on a rung the ladder does not reach, and says which', () => {
    const result = calculate(
      DEAL,
      [
        earner({ ibUserId: 'ib-3', depth: 1, level: 3 }),
        earner({ ibUserId: 'ib-2', depth: 2, level: 2 }),
        earner({ ibUserId: 'ib-1', depth: 3, level: 1 }),
      ],
      defaultLadder(),
    );

    expect(result.accruals.map((a) => a.ibUserId)).toEqual(['ib-2', 'ib-1']);
    expect(result.skippedReason).toMatch(/level 3/);
    expect(result.unpriceable).toBeUndefined();
  });

  it('pays nothing under a disabled level, and says why', () => {
    const result = calculate(
      DEAL,
      [earner({ ibUserId: 'ib-1', depth: 1 })],
      ladderOf(level({ level: 1, enabled: false })),
    );

    expect(result.accruals).toEqual([]);
    expect(result.skippedReason).toMatch(/disabled/);
  });

  it('pays nothing on a rung whose share is zero', () => {
    const result = calculate(
      DEAL,
      [earner({ ibUserId: 'ib-1', depth: 1 })],
      ladderOf(level({ level: 1, commissionShare: '0.0000' })),
    );

    expect(result.accruals).toEqual([]);
    expect(result.skippedReason).toMatch(/no share/);
  });

  it('refuses to take a share of a deposit, whatever the ladder says', () => {
    const result = calculate(DEPOSIT, [earner({ ibUserId: 'ib-1', depth: 1 })], defaultLadder());

    expect(result.accruals).toEqual([]);
    expect(result.rebate).toBeUndefined();
    expect(result.skippedReason).toMatch(/deposit/);
  });

  it('pays nobody when the chain resolves to nobody, without a reason', () => {
    expect(calculate(DEAL, [], defaultLadder())).toEqual({ accruals: [] });
  });

  /*
   * A leg that rounds to nothing at eight places is not written: the ledger
   * refuses a zero amount, and an empty accrual is noise, not a record.
   */
  it('skips a leg that rounds to nothing rather than writing an empty accrual', () => {
    const result = calculate(
      { ...DEAL, lots: '0.0001' },
      [earner({ ibUserId: 'ib-1', depth: 1 })],
      ladderOf(level({ level: 1, commissionShare: '0.0001' })),
    );

    expect(result.accruals).toEqual([]);
  });
});

describe('calculate — the product’s terms', () => {
  /*
   * ── NO PRODUCT IS A REFUSAL, NOT AN EMPTY RESULT ──────────────────────────
   *
   * An account linked to no product has nothing that says what its trades pay.
   * The money may be owed, and what is missing is a link somebody can restore
   * in ten seconds — so the trade must be REFUSED and retried, never marked
   * done having paid nobody. `unpriceable` is what the caller keys that on.
   */
  it('refuses a trade on an account linked to no product', () => {
    const result = calculate(
      { ...DEAL, terms: undefined },
      [earner({ ibUserId: 'ib-1', depth: 1 })],
      defaultLadder(),
    );

    expect(result.accruals).toEqual([]);
    expect(result.rebate).toBeUndefined();
    expect(result.unpriceable).toHaveLength(1);
    expect(result.unpriceable?.[0]).toMatch(/no product/);
    expect(result.skippedReason).toBeUndefined();
  });

  /* A product configured to pay nothing is DONE, and says so — the opposite
     of the case above, and the two must not look the same to the queue. */
  it('pays nobody on a product with no commission type, and says so', () => {
    const result = calculate(
      { ...DEAL, terms: null },
      [earner({ ibUserId: 'ib-1', depth: 1 })],
      defaultLadder(),
    );

    expect(result.accruals).toEqual([]);
    expect(result.unpriceable).toBeUndefined();
    expect(result.skippedReason).toMatch(/no commission type/);
  });

  it('pays nobody on a disabled commission type', () => {
    const result = calculate(
      { ...DEAL, terms: { ...TYPE, enabled: false } },
      [earner({ ibUserId: 'ib-1', depth: 1 })],
      defaultLadder(),
    );

    expect(result.accruals).toEqual([]);
    expect(result.rebate).toBeUndefined();
    expect(result.skippedReason).toMatch(/disabled/);
  });

  it('pays nobody when the type pays nothing per lot, and says which type', () => {
    const result = calculate(
      { ...DEAL, terms: { ...TYPE, commissionPerLot: '0' } },
      [earner({ ibUserId: 'ib-1', depth: 1 })],
      defaultLadder(),
    );

    expect(result.accruals).toEqual([]);
    expect(result.skippedReason).toMatch(/Standard terms/);
  });

  it('earns nothing and reports why when the trade has no volume', () => {
    const noLots = calculate(
      { ...DEAL, lots: undefined },
      [earner({ ibUserId: 'ib-1', depth: 1 })],
      defaultLadder(),
    );
    const zeroLots = calculate(
      { ...DEAL, lots: '0' },
      [earner({ ibUserId: 'ib-1', depth: 1 })],
      defaultLadder(),
    );

    expect(noLots.accruals).toEqual([]);
    expect(noLots.skippedReason).toMatch(/no volume/);
    expect(zeroLots.accruals).toEqual([]);
    expect(zeroLots.skippedReason).toMatch(/no volume/);
  });

  /*
   * The one property a money ledger has to keep: the amount on a row is
   * reproducible from the row alone. `baseAmount` is the POOL (lots × the
   * type's amount) and `rateValue` the share, so `base × rate / 100 = amount`
   * holds after the type or the level has been edited.
   */
  it('records the type and the pool so the row reproduces its own arithmetic', () => {
    const result = calculate(
      { ...DEAL, lots: '1.37' },
      [
        earner({ ibUserId: 'ib-2', depth: 1, level: 2 }),
        earner({ ibUserId: 'ib-1', depth: 2, level: 1 }),
      ],
      defaultLadder(),
    );

    for (const leg of [...result.accruals, result.rebate]) {
      expect(leg?.commissionTypeId).toBe('type-standard');
      const reproduced = new Decimal(leg?.baseAmount ?? '0')
        .times(leg?.rateValue ?? '0')
        .dividedBy(100)
        .toFixed(8);
      expect(reproduced).toBe(leg?.amount);
    }
    expect(result.accruals[0]?.baseAmount).toBe('13.70000000');
    expect(result.rebate?.baseAmount).toBe('4.11000000');
  });
});

describe('calculate — the client’s rebate', () => {
  it('pays the client their introducer’s share of the product’s rebate', () => {
    const result = calculate(DEAL, [earner({ ibUserId: 'ib-1', depth: 1 })], defaultLadder());

    /* 50% of a $6 pool (2 lots × $3). */
    expect(result.rebate).toEqual({
      ibUserId: 'ib-1',
      levelId: 'lvl-1',
      programId: undefined,
      commissionTypeId: 'type-standard',
      rateValue: '50.0000',
      baseAmount: '6.00000000',
      amount: '3.00000000',
    });
  });

  /*
   * The rebate is a term of the ONE relationship the client is actually in.
   * A partner further up the chain setting it would be altering terms in a
   * relationship they do not own.
   */
  it('takes the rebate from the introducer’s rung, never the parent’s', () => {
    const result = calculate(
      DEAL,
      [
        earner({ ibUserId: 'ib-2', depth: 1, level: 2 }),
        earner({ ibUserId: 'ib-1', depth: 2, level: 1 }),
      ],
      ladderOf(
        level({ level: 1, rebateShare: '50.0000' }),
        level({ level: 2, commissionShare: '30.0000', rebateShare: '20.0000' }),
      ),
    );

    expect(result.rebate?.ibUserId).toBe('ib-2');
    expect(result.rebate?.rateValue).toBe('20.0000');
    expect(result.rebate?.amount).toBe('1.20000000');
  });

  it('records the introducer as the source of the rebate, not its recipient', () => {
    const result = calculate(DEAL, [earner({ ibUserId: 'ib-1', depth: 1 })], defaultLadder());

    /* The beneficiary is the trading client, who is not in the chain at all —
       the caller supplies them. The row must not name the partner as payee. */
    expect(result.rebate?.ibUserId).toBe('ib-1');
    expect(result.accruals.map((a) => a.ibUserId)).not.toContain('client');
  });

  it('pays no rebate when the introducer’s rung has a zero rebate share', () => {
    const result = calculate(
      DEAL,
      [earner({ ibUserId: 'ib-1', depth: 1 })],
      ladderOf(level({ level: 1, rebateShare: '0.0000' })),
    );

    expect(result.rebate).toBeUndefined();
    expect(result.accruals).toHaveLength(1);
  });

  it('pays the client and no partner when the rung’s commission share is zero', () => {
    const result = calculate(
      DEAL,
      [earner({ ibUserId: 'ib-1', depth: 1 })],
      ladderOf(level({ level: 1, commissionShare: '0.0000', rebateShare: '100.0000' })),
    );

    expect(result.accruals).toEqual([]);
    expect(result.rebate?.amount).toBe('6.00000000');
  });

  it('pays no rebate when the type returns nothing to the client', () => {
    const result = calculate(
      { ...DEAL, terms: { ...TYPE, rebatePerLot: '0' } },
      [earner({ ibUserId: 'ib-1', depth: 1 })],
      defaultLadder(),
    );

    expect(result.rebate).toBeUndefined();
    expect(result.accruals).toHaveLength(1);
  });

  it('pays no rebate on a deposit, exactly as it pays no commission', () => {
    expect(
      calculate(DEPOSIT, [earner({ ibUserId: 'ib-1', depth: 1 })], defaultLadder()).rebate,
    ).toBeUndefined();
  });

  it('pays no rebate when the chain resolves to nobody', () => {
    expect(calculate(DEAL, [], defaultLadder()).rebate).toBeUndefined();
  });

  it('omits a rebate that rounds away rather than writing an empty one', () => {
    const result = calculate(
      { ...DEAL, lots: '0.0001' },
      [earner({ ibUserId: 'ib-1', depth: 1 })],
      ladderOf(level({ level: 1, rebateShare: '0.0001' })),
    );

    expect(result.rebate).toBeUndefined();
  });

  /* The rebate is a term of the introducer's rung; a disabled rung has no
     terms. The parent above is unaffected — the chain does not break. */
  it('pays no rebate when the introducer’s rung is disabled, and still pays the parent', () => {
    const result = calculate(
      DEAL,
      [
        earner({ ibUserId: 'ib-2', depth: 1, level: 2 }),
        earner({ ibUserId: 'ib-1', depth: 2, level: 1 }),
      ],
      ladderOf(level({ level: 1 }), level({ level: 2, enabled: false })),
    );

    expect(result.rebate).toBeUndefined();
    expect(result.accruals.map((a) => a.ibUserId)).toEqual(['ib-1']);
  });
});

describe('checkPlausible — the per-lot ceiling', () => {
  const chain = [
    earner({ ibUserId: 'ib-2', depth: 1, level: 2 }),
    earner({ ibUserId: 'ib-1', depth: 2, level: 1 }),
  ];

  it('accepts a chain inside the ceiling', () => {
    const result = calculate(DEAL, chain, defaultLadder());
    /* $6 + $14 + $3 = $23 on 2 lots, against a $100 allowance at the default. */
    expect(checkPlausible(DEAL, result.accruals, result.rebate)).toEqual({ ok: true });
  });

  it('accepts nothing to check', () => {
    expect(checkPlausible(DEAL, [], undefined)).toEqual({ ok: true });
  });

  /*
   * THE UNIT ERROR. A "1000" typed on the type where "10.00" was meant pays a
   * hundred times the rate card, and nothing about the accrual row would look
   * wrong — the share is right, the pool is what the type says. This is the
   * only guard that sees the sum, and it refuses rather than scales.
   */
  it('refuses a total over the ceiling, naming it as the unit-error guard', () => {
    const typo: RevenueEvent = { ...DEAL, terms: { ...TYPE, commissionPerLot: '1000' } };
    const result = calculate(typo, chain, defaultLadder());

    const verdict = checkPlausible(typo, result.accruals, result.rebate);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toMatch(/ceiling of 50 per lot/);
      expect(verdict.reason).toMatch(/unit-error/);
    }
  });

  it('honours a configured ceiling rather than the default', () => {
    const result = calculate(DEAL, chain, defaultLadder());

    /* $23 on 2 lots is $11.50 a lot: fine at 12, refused at 11. */
    expect(checkPlausible(DEAL, result.accruals, result.rebate, '12')).toEqual({ ok: true });
    expect(checkPlausible(DEAL, result.accruals, result.rebate, '11').ok).toBe(false);
  });

  it('accepts a total exactly ON the ceiling', () => {
    const result = calculate(DEAL, chain, defaultLadder());
    expect(checkPlausible(DEAL, result.accruals, result.rebate, '11.5')).toEqual({ ok: true });
  });

  /*
   * The client's leg leaves the broker by the same door, so a unit error on
   * the rebate is exactly as expensive as one on the commission. A check that
   * ignored it would pass a type paying $900 a lot back to the client.
   */
  it('counts the client’s rebate against the ceiling', () => {
    const result = calculate(DEAL, chain, defaultLadder());

    /* Commission alone is $20 on 2 lots = $10 a lot; with the $3 rebate it is $11.50. */
    expect(checkPlausible(DEAL, result.accruals, undefined, '10')).toEqual({ ok: true });
    expect(checkPlausible(DEAL, result.accruals, result.rebate, '10').ok).toBe(false);
  });
});

describe('the numbers', () => {
  it('rounds a half up at the eighth decimal rather than truncating', () => {
    const result = calculate(
      { ...DEAL, lots: '1', terms: { ...TYPE, commissionPerLot: '0.00000015' } },
      [earner({ ibUserId: 'ib-1', depth: 1 })],
      ladderOf(level({ level: 1, commissionShare: '50.0000' })),
    );

    /* 0.000000075 → 0.00000008, not 0.00000007. */
    expect(result.accruals[0]?.amount).toBe('0.00000008');
  });

  it('divides the share by a hundred, so 100% is the whole pool and not 100×', () => {
    const result = calculate(
      DEAL,
      [earner({ ibUserId: 'ib-1', depth: 1 })],
      ladderOf(level({ level: 1, commissionShare: '100.0000', rebateShare: '100.0000' })),
    );

    expect(result.accruals[0]?.amount).toBe('20.00000000');
    expect(result.rebate?.amount).toBe('6.00000000');
  });

  it('never hands back a JS number', () => {
    const result = calculate(DEAL, [earner({ ibUserId: 'ib-1', depth: 1 })], defaultLadder());

    for (const leg of [...result.accruals, result.rebate]) {
      expect(typeof leg?.amount).toBe('string');
      expect(typeof leg?.baseAmount).toBe('string');
      expect(typeof leg?.rateValue).toBe('string');
    }
  });
});
