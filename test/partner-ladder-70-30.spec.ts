import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  calculate,
  checkPlausible,
  resolveChain,
  type ChainNode,
  type LevelTerms,
  type RevenueEvent,
} from '../src/modules/ib/commission';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * MIGRATION 0145 set the ladder — level 1 at 70% of the commission and of the
 * rebate, level 2 at 30% of each (owner, 26 Sep 2026) — and MIGRATION 0197
 * changed what the commission figures MEAN (owner, 6 Oct 2026).
 *
 * Since 0197 a trade's commission is ONE pool split down a two-level tree:
 *
 *   - a sub-partner (level 2) takes their own override, else level 2's 30%;
 *   - the level 1 partner takes the REST — 100% on their own clients, 70% on a
 *     default sub-partner's (100 − 30). Level 1's own commission share on the
 *     ladder decides nothing any more;
 *   - the client's rebate is still the introducer's rebate share (or their
 *     override) of the product's rebate.
 *
 * The ladder is read from the MIGRATED database, so these prove the shares a
 * deployment actually gets, and then walk the owner's own example through the
 * real engine: a main partner with two clients and one sub-partner, and the
 * sub-partner with three clients of their own, each trading one lot on a
 * product priced at $10 commission and $3 rebate per lot.
 */
let ctx: MoneyTestContext;
let ladder: Map<number, LevelTerms>;

const TRADE: RevenueEvent = {
  currency: 'USD',
  source: 'deal',
  lots: '1',
  terms: {
    id: 'type-default',
    name: 'Default',
    enabled: true,
    commissionPerLot: '10.00000000',
    rebatePerLot: '3.00000000',
  },
};

/*
 * The tree. MAIN is a level 1 partner with no parent. SUB is a level 2 partner
 * whose parent is MAIN — and who registered through MAIN's link, so on SUB's
 * OWN trades MAIN is the introducer, exactly as for MAIN's other clients.
 * SUB_50 is a second sub-partner under MAIN, set to 50% for them alone (0197).
 *
 * Named constants rather than string ids: a chain node's id is a client's
 * Portal ID (0159) — a number — so these stand in for such clients.
 */
const MAIN = 1000001;
const SUB = 1000002;
const SUB_50 = 1000003;

const NODES = new Map<number, ChainNode>([
  [MAIN, { userId: MAIN, parentIbUserId: null, active: true, level: 1 }],
  [SUB, { userId: SUB, parentIbUserId: MAIN, active: true, level: 2 }],
  [
    SUB_50,
    {
      userId: SUB_50,
      parentIbUserId: MAIN,
      active: true,
      level: 2,
      commissionShareOverride: '50',
    },
  ],
]);

/** What one lot pays, by who introduced the trading client. */
function closeOneLot(
  introducedBy: typeof MAIN | typeof SUB | typeof SUB_50,
  onLadder: Map<number, LevelTerms> = ladder,
) {
  const chain = resolveChain(introducedBy, (id) => NODES.get(id));
  const result = calculate(TRADE, chain, onLadder);
  const commissions = Object.fromEntries(
    result.accruals.map((accrual) => [accrual.ibUserId, accrual.amount]),
  );
  const rates = Object.fromEntries(
    result.accruals.map((accrual) => [accrual.ibUserId, accrual.rateValue]),
  );
  return { commissions, rates, rebate: result.rebate?.amount ?? null, result };
}

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  const { rows } = await ctx.db.execute<{
    id: string;
    level: number;
    enabled: boolean;
    commission_share: string;
    rebate_share: string;
  }>(sql`SELECT id, level, enabled, commission_share, rebate_share FROM ib_levels`);
  ladder = new Map(
    rows.map((row) => [
      row.level,
      {
        id: row.id,
        level: row.level,
        enabled: row.enabled,
        commissionShare: row.commission_share,
        rebateShare: row.rebate_share,
      },
    ]),
  );
}, 180_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

describe('the migrated ladder', () => {
  it('gives level 2 30% of the commission and of the rebate, and level 1 a 70% rebate', () => {
    /*
     * Level 1's commission share is still on the row — 0197 did not touch the
     * ladder — but the engine no longer reads it: a level 1 partner takes what
     * the sub-partners beneath them did not. Its rebate share still decides
     * what level 1's own clients get back.
     */
    expect(ladder.get(1)).toMatchObject({ enabled: true, rebateShare: '70.0000' });
    expect(ladder.get(2)).toMatchObject({
      enabled: true,
      commissionShare: '30.0000',
      rebateShare: '30.0000',
    });
  });
});

describe('one lot closed, on a $10 commission / $3 rebate product', () => {
  it("a main partner's own client: the partner earns the whole $10.00, the client gets $2.10", () => {
    const { commissions, rates, rebate } = closeOneLot(MAIN);

    expect(commissions).toEqual({ [MAIN]: '10.00000000' });
    expect(rates).toEqual({ [MAIN]: '100.0000' });
    expect(rebate).toBe('2.10000000');
  });

  /* SUB trades like any client MAIN introduced. SUB earns nothing on SUB's own trade. */
  it("the sub-partner's own trade: the main partner earns $10.00, the sub-partner gets $2.10", () => {
    const { commissions, rebate } = closeOneLot(MAIN);

    expect(commissions).not.toHaveProperty(String(SUB));
    expect(commissions).toEqual({ [MAIN]: '10.00000000' });
    expect(rebate).toBe('2.10000000');
  });

  it("a sub-partner's client: the sub earns $3.00, the main partner the other $7.00, the client $0.90", () => {
    const { commissions, rates, rebate } = closeOneLot(SUB);

    expect(commissions).toEqual({ [SUB]: '3.00000000', [MAIN]: '7.00000000' });
    // The main partner's 70 is what the sub-partner left of 100, not a share of its own.
    expect(rates).toEqual({ [SUB]: '30.0000', [MAIN]: '70.0000' });
    // The rebate share is the INTRODUCER's — the sub-partner's 30%.
    expect(rebate).toBe('0.90000000');
  });

  it('a sub-partner set to 50%: the sub earns $5.00 and the main partner the other $5.00', () => {
    const { commissions, rates, rebate } = closeOneLot(SUB_50);

    expect(commissions).toEqual({ [SUB_50]: '5.00000000', [MAIN]: '5.00000000' });
    expect(rates).toEqual({ [SUB_50]: '50.0000', [MAIN]: '50.0000' });
    // No rebate override, so the client still gets level 2's 30%.
    expect(rebate).toBe('0.90000000');
  });

  it("ignores level 1's own commission share on the ladder", () => {
    /* Whatever level 1's row says, the main partner takes the rest of 100. */
    const level1 = ladder.get(1)!;
    const reshared = new Map(ladder).set(1, { ...level1, commissionShare: '12.5000' });

    expect(closeOneLot(MAIN, reshared).commissions).toEqual({ [MAIN]: '10.00000000' });
    expect(closeOneLot(SUB, reshared).commissions).toEqual({
      [SUB]: '3.00000000',
      [MAIN]: '7.00000000',
    });
  });

  it('never pays out more than the commission pool across the partners', () => {
    for (const introducer of [MAIN, SUB, SUB_50] as const) {
      const { result } = closeOneLot(introducer);
      const total = result.accruals.reduce((sum, leg) => sum + Number(leg.amount), 0);
      expect(total).toBe(10);
    }
  });

  it('never pays more than the broker ceiling on any of them', () => {
    for (const introducer of [MAIN, SUB, SUB_50] as const) {
      const { result } = closeOneLot(introducer);
      expect(checkPlausible(TRADE, result.accruals, result.rebate)).toEqual({ ok: true });
    }
  });
});
