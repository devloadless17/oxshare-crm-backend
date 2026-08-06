import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { IbLevelsService } from '../src/modules/ib/ib-levels.service';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * The payout ladder's rules.
 *
 * Against a real database rather than a stub, because every rule here is a
 * statement about the OTHER ROWS — "these levels total more than 100%" cannot
 * be exercised by a service holding a fake that returns whatever the test says.
 *
 * §6.1 runs through all of it: `rateValue` is a decimal string end to end, and
 * the assertions compare strings for that reason. A test that expected a number
 * would be asserting the bug.
 */
let ctx: MoneyTestContext;
let levels: IbLevelsService;

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  levels = new IbLevelsService(ctx.db);
}, 120_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

beforeEach(async () => {
  // Back to the two the migration seeds, so each test starts from the shipped
  // ladder rather than from whatever the previous one left.
  await ctx.db.execute(sql`DELETE FROM ib_levels`);
  await ctx.db.execute(sql`
    INSERT INTO ib_levels (level, name, payout_model, rate_value, max_direct_partners, enabled)
    VALUES (1, 'Master Partner', 'revenue_share', 70.0000, NULL, true),
           (2, 'Sub Partner', 'revenue_share', 30.0000, NULL, true)
  `);
});

describe('the shipped ladder', () => {
  it('is two levels deep and totals exactly 100%', async () => {
    const all = await levels.listAll();
    expect(all.map((l) => l.level)).toEqual([1, 2]);

    const total = all.reduce((sum, l) => sum + Number(l.rateValue), 0);
    expect(total).toBe(100);
  });

  it('reports a depth of 2 — the number of ENABLED levels', async () => {
    expect(await levels.depth()).toBe(2);

    await levels.update(2, { enabled: false });
    // Disabling a level shortens the payout chain. It does not renumber
    // anything, which is why depth is a count rather than a max(level).
    expect(await levels.depth()).toBe(1);
  });
});

describe('the revenue-share ceiling', () => {
  it('refuses a third level that would push the total past 100%', async () => {
    await expect(levels.create({ level: 3, name: 'Third', rateValue: '10.0000' })).rejects.toThrow(
      /would total 110/,
    );
  });

  it('names the room actually left, so the operator need not do the arithmetic', async () => {
    await levels.update(2, { rateValue: '20.0000' });
    await expect(levels.create({ level: 3, name: 'Third', rateValue: '15.0000' })).rejects.toThrow(
      /at most 10 .*available|at most 10% is available/,
    );
  });

  it('accepts a third level that fits exactly', async () => {
    await levels.update(1, { rateValue: '60.0000' });
    const created = await levels.create({ level: 3, name: 'Third', rateValue: '10.0000' });
    expect(created.rateValue).toBe('10.0000');
  });

  it('excludes the level being edited from its own ceiling check', async () => {
    // Raising L1 from 70 to 70 must not read the existing 70 as "already used".
    await expect(levels.update(1, { rateValue: '70.0000' })).resolves.toBeDefined();
  });

  it('ignores DISABLED levels when summing', async () => {
    await levels.update(2, { enabled: false });
    // 70 enabled + 30 disabled. A third at 30 fits, because the disabled one
    // takes nothing.
    await expect(
      levels.create({ level: 3, name: 'Third', rateValue: '30.0000' }),
    ).resolves.toBeDefined();
  });

  it('refuses a single share above 100 with a different message', async () => {
    // "150 is not a percentage" and "these add up to 130" are different
    // mistakes; one message covering both explains neither.
    await expect(levels.create({ level: 3, name: 'X', rateValue: '150.0000' })).rejects.toThrow(
      /cannot exceed 100%/,
    );
  });
});

describe('per_lot levels', () => {
  it('are not bound by the percentage ceiling', async () => {
    // A per-lot rate is an amount, not a share. Adding $5 to a 100% ladder is
    // not a contradiction — summing them would be the bug.
    await expect(
      levels.create({ level: 3, name: 'Rebate', payoutModel: 'per_lot', rateValue: '5.0000' }),
    ).resolves.toBeDefined();
  });

  it('do not count toward the percentage total of other levels', async () => {
    await levels.create({
      level: 3,
      name: 'Rebate',
      payoutModel: 'per_lot',
      rateValue: '5000.0000',
    });
    // The percentage half is still bounded: 70 + 30 is full.
    await expect(levels.create({ level: 4, name: 'Fourth', rateValue: '1.0000' })).rejects.toThrow(
      /would total 101/,
    );
  });
});

describe('removing a level', () => {
  it('refuses to empty the ladder', async () => {
    await levels.remove(2);
    await expect(levels.remove(1)).rejects.toThrow(/last level cannot be removed/);
  });

  it('refuses a level that does not exist', async () => {
    await expect(levels.remove(9)).rejects.toThrow(/does not exist/);
  });
});

describe('creating a level', () => {
  it('refuses a duplicate level number', async () => {
    await expect(levels.create({ level: 1, name: 'Dup', rateValue: '0.0000' })).rejects.toThrow(
      /already exists/,
    );
  });

  it('keeps the rate a string all the way to the row (§6.1)', async () => {
    await levels.update(1, { rateValue: '66.6600' });
    const one = await levels.findOne(1);
    expect(one?.rateValue).toBe('66.6600');
    expect(typeof one?.rateValue).toBe('string');
  });
});
