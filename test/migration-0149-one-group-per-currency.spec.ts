import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * MIGRATION 0149 — one group per currency on a product, again.
 *
 * 0146 dropped the rule and 0149 puts it back, so a production database may
 * have picked up a product holding two groups in one currency in between.
 * Re-adding the constraint on such a database must STOP with a message that
 * names the product and the groups — never a bare duplicate-key error, and
 * never a silent detach of a group somebody attached on purpose.
 */
const SQL = readFileSync(
  join(__dirname, '..', 'src', 'database', 'migrations', '0149_one_group_per_currency_again.sql'),
  'utf8',
);

let ctx: MoneyTestContext;
let productId: string;

async function hasRule(): Promise<boolean> {
  const { rows } = await ctx.db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM pg_constraint
     WHERE conname = 'trading_product_groups_slot_unique'
  `);
  return rows[0].n === 1;
}

/** The database as 0146 left it: no rule. */
async function withoutRule(): Promise<void> {
  await ctx.db.execute(
    sql`ALTER TABLE trading_product_groups DROP CONSTRAINT IF EXISTS trading_product_groups_slot_unique`,
  );
}

async function attach(mt5Group: string): Promise<void> {
  await ctx.db.execute(sql`
    INSERT INTO trading_product_groups (product_id, environment, mt5_group, currency)
    VALUES (${productId}, 'live', ${mt5Group}, 'USD')
  `);
}

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  const { rows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO trading_products (name, type) VALUES ('Migration Standard', 'real') RETURNING id
  `);
  productId = rows[0].id;
}, 180_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

beforeEach(async () => {
  await withoutRule();
  await ctx.db.execute(sql`DELETE FROM trading_product_groups WHERE product_id = ${productId}`);
});

describe('migration 0149', () => {
  it('runs cleanly where no product holds two groups in one currency', async () => {
    await ctx.db.execute(sql.raw(SQL));
    expect(await hasRule()).toBe(true);
  });

  it('stops, naming the product and its groups, when a product holds two in one currency', async () => {
    await attach('real\\First-USD');
    await attach('real\\Second-USD');

    let message = '';
    try {
      await ctx.db.execute(sql.raw(SQL));
    } catch (error) {
      const cause = (error as { cause?: { message?: string } }).cause;
      message = cause?.message ?? (error as Error).message;
    }

    expect(message).toContain('more than one group in the same currency');
    expect(message).toContain('Migration Standard (live USD): real\\First-USD, real\\Second-USD');
    expect(await hasRule()).toBe(false);
  });

  it('adds the rule once the extra group is detached, and the database refuses a second again', async () => {
    await attach('real\\First-USD');

    await ctx.db.execute(sql.raw(SQL));

    expect(await hasRule()).toBe(true);
    await expect(attach('real\\Second-USD')).rejects.toBeDefined();
  });
});
