import { describe, expect, it } from 'vitest';
import {
  calculate,
  checkPlausible,
  resolveChain,
  MAX_CHAIN_DEPTH,
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
 * DEPTH now: tier 1 is what you earn from your OWN client, tier 2 from a
 * sub-partner's. So a sub-partner who introduced this client is paid the tier-1
 * rate — under the old model they were paid the level-2 rate for business they
 * had brought in themselves, which is the defect the change fixes and the
 * reason several expectations below are the mirror of what they were.
 *
 * ## What changed again in 0102: the ladder is a LIST
 *
 * `level1Rate` / `level2Rate` were a fixed PAIR, so two levels was the deepest
 * anything could express and `MAX_CHAIN_DEPTH` was 2 to match. A programme now
 * carries `tiers`, a map from depth to rate, and its SIZE is how far its
 * holder's earnings reach. `MAX_CHAIN_DEPTH` is 10 and is a cycle guard.
 *
 * `ladder()` below builds that map, so most expectations here are unchanged —
 * the arithmetic did not move, only where the rates are read from.
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
  return { parentIbUserId: null, active: true, programId: 'prog-a', ...overrides };
}

function lookupFrom(nodes: ChainNode[]): (id: string) => ChainNode | undefined {
  const map = new Map(nodes.map((n) => [n.userId, n]));
  return (id) => map.get(id);
}

/**
 * A tier ladder from depth 1 upward.
 *
 * `null` OMITS that depth, which is a different statement from a zero: absent
 * means "this programme does not reach here", zero means "it reaches here and
 * pays nothing". `calculate` distinguishes them in the reason it reports, and
 * the database refuses the second outright — so both paths need a way to be
 * constructed, and this is it.
 */
function ladder(...rates: (string | null)[]): Map<number, string> {
  const map = new Map<number, string>();
  rates.forEach((rate, index) => {
    if (rate !== null) map.set(index + 1, rate);
  });
  return map;
}

/** One programme, defaulted to terms that pay two depths and no rebate. */
function program(overrides: Partial<ProgramTerms> & { id: string }): ProgramTerms {
  return {
    mode: 'commission_only',
    tiers: ladder('10.0000', '5.0000'),
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
  return { programId: 'prog-a', ...over };
}

describe('resolveChain', () => {
  it('pays nobody when the client was never referred', () => {
    expect(resolveChain(null, lookupFrom([]))).toEqual([]);
    expect(resolveChain(undefined, lookupFrom([]))).toEqual([]);
  });

  it('resolves the introducer alone when they have no parent', () => {
    const chain = resolveChain('ib-1', lookupFrom([node({ userId: 'ib-1' })]));
    expect(chain).toEqual<ChainEntry[]>([{ ibUserId: 'ib-1', depth: 1, programId: 'prog-a' }]);
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
   * unreachable however their programme was configured — while the console
   * derived a payout depth from the rung count and told an operator earnings
   * travelled three levels. `calculate` is what decides who is PAID; resolution
   * must reach far enough for it to be asked.
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
   * payout policy — how far earnings travel is each programme's tier count —
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

describe('calculate — whose rate applies', () => {
  /*
   * THE regression the programme model exists for.
   *
   * `ib-2` is a sub-partner who introduced this client themselves, so they are
   * paid the TIER-1 rate — what you earn from your own business. Their parent,
   * one hop further from the trade, takes tier 2. Keyed on a rung instead,
   * `ib-2` would collect 5% on a client they brought in while the parent
   * collected 10% on one they never met.
   */
  it('pays by DEPTH, not by where the earner sits in the tree', () => {
    const result = calculate(
      DEAL,
      [earner({ ibUserId: 'ib-2', depth: 1 }), earner({ ibUserId: 'ib-1', depth: 2 })],
      programs([program({ id: 'prog-a', tiers: ladder('10.0000', '5.0000') })]),
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
        program({ id: 'prog-a', tiers: ladder('10.0000', '5.0000') }),
        program({ id: 'prog-b', tiers: ladder('25.0000', '5.0000') }),
      ]),
    );

    expect(result.accruals.map((a) => [a.ibUserId, a.amount, a.rateValue])).toEqual([
      ['ib-2', '250.00000000', '25.0000'],
      ['ib-1', '50.00000000', '5.0000'],
    ]);
  });

  /*
   * ── FR-IB-17: MULTI-LEVEL DISTRIBUTION ─────────────────────────────────────
   *
   * "Commission is distributed up the chain" past two, which the fixed
   * `level1Rate` / `level2Rate` pair could not express at all. Three tiers, three
   * earners, each on their own depth's rate.
   *
   * The ugly middle rate is deliberate: 60/25/12.5 of 1000 would pass with the
   * depth-2 and depth-3 rates transposed if they were the same number.
   */
  it('pays every depth its own tier, past the old two-level ceiling', () => {
    const result = calculate(
      DEAL,
      [
        earner({ ibUserId: 'ib-3', depth: 1 }),
        earner({ ibUserId: 'ib-2', depth: 2 }),
        earner({ ibUserId: 'ib-1', depth: 3 }),
      ],
      programs([program({ id: 'prog-a', tiers: ladder('60.0000', '25.0000', '12.5000') })]),
    );

    expect(result.accruals.map((a) => [a.ibUserId, a.depth, a.amount])).toEqual([
      ['ib-3', 1, '600.00000000'],
      ['ib-2', 2, '250.00000000'],
      ['ib-1', 3, '125.00000000'],
    ]);
  });

  /*
   * ## The ROW COUNT is the reach, and this is what that means at runtime
   *
   * A two-tier programme pays its holder nothing on a client three hops below
   * them. Not zero — NOTHING, with no accrual row written, because a zero-amount
   * row is refused by `ib_accruals_amount_positive` and would take every
   * legitimate earner on the same trade down with it.
   *
   * The old engine had no third branch: `depth === 1 ? level1Rate : level2Rate`
   * paid `level2Rate` to a depth-3 ancestor, silently treating "as deep as the
   * type can express" as "as deep as the broker configured".
   */
  it('pays nobody past the end of their OWN programme’s ladder', () => {
    const result = calculate(
      DEAL,
      [
        earner({ ibUserId: 'ib-3', depth: 1 }),
        earner({ ibUserId: 'ib-2', depth: 2 }),
        earner({ ibUserId: 'ib-1', depth: 3 }),
      ],
      programs([program({ id: 'prog-a', tiers: ladder('10.0000', '5.0000') })]),
    );

    expect(result.accruals.map((a) => a.ibUserId)).toEqual(['ib-3', 'ib-2']);
    expect(result.skippedReason).toContain('reaches 2 level(s)');
  });

  /*
   * Reach is per PROGRAMME, so one partner's contract cannot cancel another's.
   *
   * The introducer here is on a one-tier programme and the two above them are on
   * a three-tier one. If reach were read from the introducer — or capped
   * platform-wide, as the rung ladder did — both ancestors would earn nothing on
   * terms they had negotiated and were never told had been overridden.
   */
  it('lets a deep programme pay through a shallow one below it', () => {
    const result = calculate(
      DEAL,
      [
        earner({ ibUserId: 'ib-3', depth: 1, programId: 'shallow' }),
        earner({ ibUserId: 'ib-2', depth: 2, programId: 'deep' }),
        earner({ ibUserId: 'ib-1', depth: 3, programId: 'deep' }),
      ],
      programs([
        program({ id: 'shallow', tiers: ladder('40.0000') }),
        program({ id: 'deep', tiers: ladder('10.0000', '8.0000', '4.0000') }),
      ]),
    );

    expect(result.accruals.map((a) => [a.ibUserId, a.amount])).toEqual([
      ['ib-3', '400.00000000'],
      ['ib-2', '80.00000000'],
      ['ib-1', '40.00000000'],
    ]);
  });

  /*
   * An ABSENT tier and a ZERO tier are different statements, and the reason each
   * is reported differently is that they need different fixes: "your programme
   * does not reach that far" is a ladder to extend, "it pays nothing there" is a
   * rate to correct. An empty result with one message for both sends an operator
   * to the wrong screen.
   *
   * The database refuses the zero outright (`ib_program_tiers_rate_positive`), so
   * this path is reachable only through an in-memory caller — which is exactly
   * why the pure function keeps its own guard.
   */
  it('distinguishes a ladder that ends from a tier that pays nothing', () => {
    const ended = calculate(
      DEAL,
      [earner({ ibUserId: 'ib-1', depth: 2 })],
      programs([program({ id: 'prog-a', tiers: ladder('10.0000') })]),
    );
    const zeroed = calculate(
      DEAL,
      [earner({ ibUserId: 'ib-1', depth: 2 })],
      programs([program({ id: 'prog-a', tiers: ladder('10.0000', '0.0000') })]),
    );

    expect(ended.accruals).toEqual([]);
    expect(ended.skippedReason).toContain('reaches 1 level(s)');

    expect(zeroed.accruals).toEqual([]);
    expect(zeroed.skippedReason).toContain('pays nothing at depth 2');
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
      programs([program({ id: 'prog-a', tiers: ladder('2.5000', '5.0000') })]),
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
      programs([program({ id: 'prog-a', tiers: ladder('70.0000', '5.0000') })]),
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
      programs([program({ id: 'prog-a', tiers: ladder('10.0000', '0.0000') })]),
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
      programs([program({ id: 'prog-a', tiers: ladder('0.0001', '5.0000') })]),
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
        program({ id: 'prog-b', tiers: ladder('10.0000', '5.0000') }),
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
        program({
          id: 'prog-a',
          mode: 'hybrid',
          tiers: ladder('10.0000', '5.0000'),
          rebateRate: '5.0000',
        }),
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
        program({
          id: 'prog-a',
          mode: 'rebate_only',
          tiers: ladder('10.0000', '5.0000'),
          rebateRate: '5.0000',
        }),
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

/*
 * `describe('the broker's revenue cap')` IS GONE (0103), with the cap itself.
 *
 * Six cases covered `maxSharePct`: that it scaled the chain pro rata rather
 * than paying rungs in order until the pool ran out, that the rebate was inside
 * the cap rather than beside it, and that a leg scaled below the storable
 * minimum was dropped instead of stored as a zero the CHECK constraint would
 * refuse.
 *
 * All of it went with the "Maximum paid to partners" setting. What still stops
 * an over-payment is `checkPlausible` below — which REFUSES rather than scales,
 * so a chain configured past 100% defers on the retry backoff and pays in full
 * once the programmes are corrected, instead of paying a reduced amount and
 * logging that it had.
 */

describe('checkPlausible', () => {
  const leg = (ibUserId: string, amount: string) => ({
    ibUserId,
    depth: 1,
    programId: 'prog-a',
    rateValue: '10.0000',
    /* The base this leg is a share of (0106). `checkPlausible` bounds the
     * TOTAL against the event, so the per-leg base is carried but not read
     * here — it is required by the type because a money row must always be
     * able to explain its own arithmetic. */
    baseAmount: '1000.00000000',
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
      baseAmount: '1000.00000000',
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
      programs([program({ id: 'prog-a', tiers: ladder('10.0000', '5.0000') })]),
    );
    const without = calculate(
      DEAL_NO_LOTS,
      [earner({ ibUserId: 'ib-1', depth: 1 })],
      programs([program({ id: 'prog-a', tiers: ladder('10.0000', '5.0000') })]),
    );

    expect(withLots.accruals[0].amount).toBe(without.accruals[0].amount);
  });

  it('rounds a half up at the eighth decimal rather than truncating', () => {
    const result = calculate(
      { ...DEAL, grossAmount: '0.00000005' },
      [earner({ ibUserId: 'ib-1', depth: 1 })],
      programs([program({ id: 'prog-a', tiers: ladder('50.0000', '5.0000') })]),
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
      programs([program({ id: 'prog-a', tiers: ladder('200.0000', '5.0000') })]),
    );

    expect(result.accruals[0].amount).toBe('2000.00000000');
  });
});

/*
 * ── THE BROKER'S TOTAL PAYOUT CEILING (0106) ─────────────────────────────────
 *
 * `ib_max_total_payout_pct` bounds what ONE TRADE may cost across every leg.
 *
 * It exists because the per-programme guard cannot see a chain: two partners
 * holding different programmes are each within their own limit and together
 * over the broker's. The seeded catalogue proved it — 60% at depth 1 and 40% at
 * depth 2 paid out exactly 100% of the revenue, and nothing refused it, because
 * `checkPlausible` only ever refused a total ABOVE the revenue.
 */
describe('checkPlausible — the broker’s ceiling', () => {
  const leg = (ibUserId: string, amount: string) => ({
    ibUserId,
    depth: 1,
    programId: 'prog-a',
    rateValue: '10.0000',
    /* The base this leg is a share of (0106). `checkPlausible` bounds the
     * TOTAL against the event, so the per-leg base is carried but not read
     * here — it is required by the type because a money row must always be
     * able to explain its own arithmetic. */
    baseAmount: '1000.00000000',
    amount,
  });

  it('refuses a chain that costs more than the configured ceiling', () => {
    // 400 of a 1000 revenue, against a ceiling of 30%.
    const verdict = checkPlausible(DEAL_NO_LOTS, [leg('ib-1', '400.00000000')], undefined, '30');

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toContain('ceiling');
      expect(verdict.reason).toContain('30%');
    }
  });

  it('accepts a chain exactly ON the ceiling', () => {
    const verdict = checkPlausible(DEAL_NO_LOTS, [leg('ib-1', '300.00000000')], undefined, '30');

    expect(verdict.ok).toBe(true);
  });

  /*
   * The regression this whole control exists for. Before 0106 this passed:
   * a share of exactly 100% is not GREATER than the revenue, so the only guard
   * in place let it through and the broker kept nothing.
   */
  it('refuses the 60/40 chain that used to pay out the entire revenue', () => {
    const chain = [leg('sara', '600.00000000'), leg('ahmad', '400.00000000')];

    // The old guard alone still lets it through — this is what was shipping.
    expect(checkPlausible(DEAL_NO_LOTS, chain).ok).toBe(true);

    // With a ceiling the broker can actually live on, it is refused.
    const verdict = checkPlausible(DEAL_NO_LOTS, chain, undefined, '70');
    expect(verdict.ok).toBe(false);
  });

  /*
   * The default must not change what a running platform pays, so 100 has to
   * behave exactly like no ceiling at all.
   */
  it('defaults to 100, which refuses only what the old guard refused', () => {
    expect(checkPlausible(DEAL_NO_LOTS, [leg('ib-1', '1000.00000000')]).ok).toBe(true);
    expect(checkPlausible(DEAL_NO_LOTS, [leg('ib-1', '1000.00000000')], undefined, '100').ok).toBe(
      true,
    );
    expect(checkPlausible(DEAL_NO_LOTS, [leg('ib-1', '1000.00000001')], undefined, '100').ok).toBe(
      false,
    );
  });

  /*
   * A unit error and a chain over budget send an operator to two different
   * screens, so the message that fires has to name the right one. At the
   * default both thresholds are the same number, and the rate is the likelier
   * fault — so it wins.
   */
  it('reports a unit error as a unit error, not as a ceiling breach', () => {
    const verdict = checkPlausible(DEAL_NO_LOTS, [leg('ib-1', '70000.00000000')], undefined, '30');

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toContain('exceeds');
      expect(verdict.reason).not.toContain('ceiling');
    }
  });

  it('counts the client’s rebate against the ceiling too', () => {
    const verdict = checkPlausible(
      DEAL_NO_LOTS,
      [leg('ib-1', '200.00000000')],
      {
        ibUserId: 'ib-1',
        programId: 'prog-a',
        rateValue: '15.0000',
        baseAmount: '1000.00000000',
        amount: '150.00000000',
      },
      '30',
    );

    // 200 + 150 = 350, over the 300 the ceiling allows.
    expect(verdict.ok).toBe(false);
  });
});

/*
 * ── FR-IB-16: WHICH REVENUE A PROGRAMME'S RATES ARE A PERCENTAGE OF ──────────
 *
 * "configure the exact commission and rebate mathematics ... through the IB
 * program catalogue". The base is half of what a partner agreed to, so it
 * travels with their terms rather than switching platform-wide.
 */
describe('calculate — the revenue basis is a term of the programme', () => {
  const CHAIN = [earner({ ibUserId: 'sara', depth: 1, programId: 'charges' })];

  const byBasis = new Map<'commission_swap' | 'spread' | 'commission_swap_spread', string>([
    ['commission_swap', '1000.00000000'],
    ['spread', '400.00000000'],
  ]);

  it('prices a leg on the basis its own programme names', () => {
    const onSpread = calculate(
      DEAL_NO_LOTS,
      [earner({ ibUserId: 'sara', depth: 1, programId: 'spread-priced' })],
      programs([
        program({ id: 'spread-priced', tiers: ladder('10.0000'), revenueBasis: 'spread' }),
      ]),
      byBasis,
    );

    // 10% of the SPREAD figure (400), not of the charges figure (1000).
    expect(onSpread.accruals[0]?.amount).toBe('40.00000000');
  });

  it('pays two partners in one chain on the two bases they each agreed to', () => {
    const result = calculate(
      DEAL_NO_LOTS,
      [
        earner({ ibUserId: 'sara', depth: 1, programId: 'charges' }),
        earner({ ibUserId: 'ahmad', depth: 2, programId: 'spread-priced' }),
      ],
      programs([
        program({ id: 'charges', tiers: ladder('10.0000', '5.0000') }),
        program({
          id: 'spread-priced',
          tiers: ladder('10.0000', '5.0000'),
          revenueBasis: 'spread',
        }),
      ]),
      byBasis,
    );

    // sara: 10% of 1000. ahmad: 5% of 400 — his own contract, at his own depth.
    expect(result.accruals.map((a) => a.amount)).toEqual(['100.00000000', '20.00000000']);
  });

  /*
   * A basis the caller could not price is ABSENT from the map, and absent is
   * not zero. Zero is a price; absent means "no answer" — most often an account
   * linked to no product under a basis that needs one. Falling back to the
   * default revenue would pay this partner on terms nobody agreed to, at a
   * number that looks perfectly ordinary on the accrual row.
   */
  it('refuses a leg whose basis could not be priced, rather than substituting another', () => {
    const result = calculate(
      DEAL_NO_LOTS,
      CHAIN,
      programs([
        program({
          id: 'charges',
          tiers: ladder('10.0000'),
          revenueBasis: 'commission_swap_spread',
        }),
      ]),
      byBasis,
    );

    expect(result.accruals).toEqual([]);
    /*
     * `unpriceable`, and NOT `skippedReason` — the distinction is the whole
     * point. `skippedReason` means the partner is owed nothing and the deal is
     * finished with, which the queue acts on by marking it DONE. This partner
     * IS owed something and we cannot say how much, so the caller must refuse
     * and defer. Asserting the wrong field here would pass while the commission
     * was being discarded.
     */
    expect(result.unpriceable?.join(' ')).toContain('commission_swap_spread');
    expect(result.skippedReason).toBeUndefined();
  });

  /*
   * Backward compatibility, and it is load-bearing: every caller that has one
   * revenue figure — and every deployment before 0106 — must keep pricing every
   * leg on it.
   */
  it('prices everything on the single gross when no map is given', () => {
    const result = calculate(
      DEAL_NO_LOTS,
      CHAIN,
      programs([program({ id: 'charges', tiers: ladder('10.0000'), revenueBasis: 'spread' })]),
    );

    expect(result.accruals[0]?.amount).toBe('100.00000000');
  });
});
