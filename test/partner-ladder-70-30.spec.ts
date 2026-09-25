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
 * MIGRATION 0145 — level 1 takes 70% of the commission and of the rebate,
 * level 2 takes 30% of each (owner, 26 Sep 2026).
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
 */
const NODES = new Map<string, ChainNode>([
  ['MAIN', { userId: 'MAIN', parentIbUserId: null, active: true, level: 1 }],
  ['SUB', { userId: 'SUB', parentIbUserId: 'MAIN', active: true, level: 2 }],
]);

/** What one lot pays, by who introduced the trading client. */
function closeOneLot(introducedBy: 'MAIN' | 'SUB') {
  const chain = resolveChain(introducedBy, (id) => NODES.get(id));
  const result = calculate(TRADE, chain, ladder);
  const commissions = Object.fromEntries(
    result.accruals.map((accrual) => [accrual.ibUserId, accrual.amount]),
  );
  return { commissions, rebate: result.rebate?.amount ?? null, result };
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
  it('pays level 1 70% and level 2 30%, of the commission and of the rebate', () => {
    expect(ladder.get(1)).toMatchObject({
      enabled: true,
      commissionShare: '70.0000',
      rebateShare: '70.0000',
    });
    expect(ladder.get(2)).toMatchObject({
      enabled: true,
      commissionShare: '30.0000',
      rebateShare: '30.0000',
    });
  });
});

describe('one lot closed, on a $10 commission / $3 rebate product', () => {
  it("a main partner's own client: the partner earns $7.00, the client gets $2.10", () => {
    const { commissions, rebate } = closeOneLot('MAIN');

    expect(commissions).toEqual({ MAIN: '7.00000000' });
    expect(rebate).toBe('2.10000000');
  });

  /* SUB trades like any client MAIN introduced. SUB earns nothing on SUB's own trade. */
  it("the sub-partner's own trade: the main partner earns $7.00, the sub-partner gets $2.10", () => {
    const { commissions, rebate } = closeOneLot('MAIN');

    expect(commissions).not.toHaveProperty('SUB');
    expect(commissions).toEqual({ MAIN: '7.00000000' });
    expect(rebate).toBe('2.10000000');
  });

  it("a sub-partner's client: the sub earns $3.00, the main partner $7.00, the client $0.90", () => {
    const { commissions, rebate } = closeOneLot('SUB');

    expect(commissions).toEqual({ SUB: '3.00000000', MAIN: '7.00000000' });
    // The rebate share is the INTRODUCER's — the sub-partner's 30%.
    expect(rebate).toBe('0.90000000');
  });

  it('never pays more than the broker ceiling on any of them', () => {
    for (const introducer of ['MAIN', 'SUB'] as const) {
      const { result } = closeOneLot(introducer);
      expect(checkPlausible(TRADE, result.accruals, result.rebate)).toEqual({ ok: true });
    }
  });
});
