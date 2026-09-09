import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * Migration 0118, exercised as SQL against the exact rows the console bug
 * wrote — every partner approved through it was rooted on level 1 with no
 * parent edge, whoever introduced them.
 *
 * The statements are read from the MIGRATION FILE and executed, not restated
 * here: the point is that the shipped repair does this, and a copy would keep
 * passing after somebody edits the real one. The migration has already run
 * once by the time this suite boots (the test database applies the committed
 * set), which also proves the re-run is harmless before these cases build the
 * damaged shape and run it again.
 */
let ctx: MoneyTestContext;
let statements: string[];

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  statements = readFileSync(
    join(__dirname, '../src/database/migrations/0118_adopt_orphaned_sub_partners.sql'),
    'utf8',
  )
    .split('--> statement-breakpoint')
    .map((s) => s.trim())
    .filter(Boolean);
}, 120_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

async function makeUser(email: string, referredBy: string | null = null): Promise<string> {
  const { rows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name, referred_by_ib_user_id)
    VALUES (${email}, 'x', 'Repair', 'Case', ${referredBy})
    RETURNING id
  `);
  return rows[0].id;
}

async function makeAccount(
  userId: string,
  code: string,
  level: number,
  parent: string | null = null,
): Promise<void> {
  await ctx.db.execute(sql`
    INSERT INTO ib_accounts (user_id, referral_code, active, level, parent_ib_user_id)
    VALUES (${userId}, ${code}, true, ${level}, ${parent})
  `);
}

async function account(userId: string): Promise<{ level: number; parent: string | null }> {
  const { rows } = await ctx.db.execute<{ level: number; parent: string | null }>(sql`
    SELECT level, parent_ib_user_id AS parent FROM ib_accounts WHERE user_id = ${userId}
  `);
  return rows[0];
}

async function runRepair(): Promise<void> {
  for (const statement of statements) {
    await ctx.db.execute(sql.raw(statement));
  }
}

beforeEach(async () => {
  await ctx.db.execute(sql`UPDATE users SET referred_by_ib_user_id = NULL`);
  await ctx.db.execute(sql`DELETE FROM ib_accounts`);
  await ctx.db.execute(sql`DELETE FROM users`);
});

describe('adopting the orphaned sub-partners', () => {
  it('restores the chain the console bug flattened — edges AND rungs', async () => {
    // The reported shape: three partners "under each other" by attribution,
    // every one of them a level-1 root in ib_accounts.
    const a = await makeUser('repair-a@test.local');
    await makeAccount(a, 'REPAIRA1', 1);
    const b = await makeUser('repair-b@test.local', a);
    await makeAccount(b, 'REPAIRB1', 1);
    const c = await makeUser('repair-c@test.local', b);
    await makeAccount(c, 'REPAIRC1', 1);

    await runRepair();

    expect(await account(a)).toEqual({ level: 1, parent: null });
    expect(await account(b)).toEqual({ level: 2, parent: a });
    // Past the two-rung ladder ON PURPOSE: the rung records where the tree
    // says they stand, they earn nothing there, and the console names it —
    // a decision for an operator, not a number quietly clamped.
    expect(await account(c)).toEqual({ level: 3, parent: b });
  });

  it('leaves a reviewer-chosen parent exactly as chosen', async () => {
    const a = await makeUser('repair-chosen-a@test.local');
    await makeAccount(a, 'REPAIRA2', 1);
    const elsewhere = await makeUser('repair-chosen-x@test.local');
    await makeAccount(elsewhere, 'REPAIRX2', 1);
    // Introduced by `a`, but a reviewer deliberately placed them elsewhere.
    const b = await makeUser('repair-chosen-b@test.local', a);
    await makeAccount(b, 'REPAIRB2', 2, elsewhere);

    await runRepair();

    expect(await account(b)).toEqual({ level: 2, parent: elsewhere });
  });

  it('leaves an operator-set level alone — only the bug signature is rewritten', async () => {
    const a = await makeUser('repair-level-a@test.local');
    await makeAccount(a, 'REPAIRA3', 1);
    // Nested, but changeLevel moved them to 4. Not the bug's shape (level 1
    // beneath a parent), so the repair must not restate a decided number.
    const b = await makeUser('repair-level-b@test.local', a);
    await makeAccount(b, 'REPAIRB3', 4, a);

    await runRepair();

    expect(await account(b)).toEqual({ level: 4, parent: a });
  });

  it('leaves a genuinely direct partner rooted', async () => {
    const alone = await makeUser('repair-alone@test.local');
    await makeAccount(alone, 'REPAIRA4', 1);

    await runRepair();

    expect(await account(alone)).toEqual({ level: 1, parent: null });
  });

  it('changes nothing on a second run', async () => {
    const a = await makeUser('repair-again-a@test.local');
    await makeAccount(a, 'REPAIRA5', 1);
    const b = await makeUser('repair-again-b@test.local', a);
    await makeAccount(b, 'REPAIRB5', 1);

    await runRepair();
    await runRepair();

    expect(await account(b)).toEqual({ level: 2, parent: a });
  });
});
