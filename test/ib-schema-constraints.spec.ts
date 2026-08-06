import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * What migration 0030 promises, asserted against a real Postgres.
 *
 * Every rule here is a DATABASE guarantee, and each one exists because the
 * service-level equivalent loses a race. "At most one pending application" and
 * "one wallet per user per currency" are both read-then-insert if a constraint
 * is not doing the work, and a double-clicked submit beats both. So the tests
 * do not go through a service — they write the concurrent-ish case directly and
 * expect Postgres to refuse it.
 *
 * A constraint that is not tested is a constraint that survives being dropped
 * in a later migration, which is how the idempotency guard on `ledger_entries`
 * left without anything failing.
 */
let ctx: MoneyTestContext;

beforeAll(async () => {
  ctx = await startMoneyTestDb();
}, 120_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

/**
 * The CONSTRAINT that refused a statement, not the message that reported it.
 *
 * Drizzle wraps driver errors, so `error.message` is "Failed query: INSERT …"
 * and the constraint name lives on the cause. Matching the message would pass
 * for any failure at all — including a typo'd column — which is precisely the
 * kind of test that reports green while proving nothing.
 */
async function constraintViolatedBy(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    const cause: unknown = (error as { cause?: unknown }).cause ?? error;
    const name = (cause as { constraint?: string }).constraint;
    if (name) return name;
    throw new Error(`Statement failed, but not on a constraint: ${(cause as Error).message}`);
  }
  throw new Error('Expected the statement to be refused, but it succeeded.');
}

/** A client, since almost everything here hangs off a real user row. */
async function makeUser(email: string): Promise<string> {
  const rows = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name)
    VALUES (${email}, 'x', 'Test', 'Client')
    RETURNING id
  `);
  return rows.rows[0].id;
}

beforeEach(async () => {
  // Children first: every FK here is `restrict`, so the order is not cosmetic.
  await ctx.db.execute(sql`DELETE FROM wallets`);
  await ctx.db.execute(sql`DELETE FROM ib_accounts`);
  await ctx.db.execute(sql`DELETE FROM ib_applications`);
  await ctx.db.execute(sql`DELETE FROM users`);
});

describe('ib_applications', () => {
  it('refuses a second PENDING application for the same user', async () => {
    const userId = await makeUser('one-pending@test.local');

    await ctx.db.execute(sql`INSERT INTO ib_applications (user_id) VALUES (${userId})`);

    expect(
      await constraintViolatedBy(
        ctx.db.execute(sql`INSERT INTO ib_applications (user_id) VALUES (${userId})`),
      ),
    ).toBe('ib_applications_one_pending_uq');
  });

  it('allows re-applying after a rejection — the index is PARTIAL', async () => {
    const userId = await makeUser('reapply@test.local');

    await ctx.db.execute(sql`
      INSERT INTO ib_applications (user_id, status, rejection_reason)
      VALUES (${userId}, 'rejected', 'Application is incomplete or unclear')
    `);
    // The whole reason the index carries a WHERE clause. A plain unique index on
    // user_id would trap a rejected applicant permanently.
    await ctx.db.execute(sql`INSERT INTO ib_applications (user_id) VALUES (${userId})`);

    const { rows } = await ctx.db.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM ib_applications WHERE user_id = ${userId}`,
    );
    expect(rows[0].count).toBe(2);
  });

  it('allows many rejected applications for one user', async () => {
    const userId = await makeUser('many-rejected@test.local');

    for (const reason of ['first refusal', 'second refusal', 'third refusal']) {
      await ctx.db.execute(sql`
        INSERT INTO ib_applications (user_id, status, rejection_reason)
        VALUES (${userId}, 'rejected', ${reason})
      `);
    }

    const { rows } = await ctx.db.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM ib_applications WHERE status = 'rejected'`,
    );
    expect(rows[0].count).toBe(3);
  });
});

describe('ib_accounts', () => {
  it('refuses a referral code that another partner already holds', async () => {
    const first = await makeUser('code-a@test.local');
    const second = await makeUser('code-b@test.local');

    await ctx.db.execute(
      sql`INSERT INTO ib_accounts (user_id, level, referral_code) VALUES (${first}, 1, 'SHARED')`,
    );

    // Attribution is permanent per client, so a reissued code would credit one
    // partner's introductions to whoever holds it now.
    expect(
      await constraintViolatedBy(
        ctx.db.execute(
          sql`INSERT INTO ib_accounts (user_id, level, referral_code) VALUES (${second}, 1, 'SHARED')`,
        ),
      ),
    ).toBe('ib_accounts_referral_code_unique');
  });

  it('refuses a parent that is not itself a partner', async () => {
    const partner = await makeUser('child@test.local');
    const stranger = await makeUser('not-a-partner@test.local');

    // The constraint the deleted `ib_profiles.parent_ib_id` did not have. A
    // dangling parent is a payout chain that stops halfway up, silently.
    expect(
      await constraintViolatedBy(
        ctx.db.execute(sql`
          INSERT INTO ib_accounts (user_id, level, parent_ib_user_id, referral_code)
          VALUES (${partner}, 2, ${stranger}, 'CHILD1')
        `),
      ),
    ).toBe('ib_accounts_parent_fk');
  });

  it('accepts a parent that IS a partner', async () => {
    const parent = await makeUser('parent@test.local');
    const child = await makeUser('sub@test.local');

    await ctx.db.execute(
      sql`INSERT INTO ib_accounts (user_id, level, referral_code) VALUES (${parent}, 1, 'PARENT1')`,
    );
    await ctx.db.execute(sql`
      INSERT INTO ib_accounts (user_id, level, parent_ib_user_id, referral_code)
      VALUES (${child}, 2, ${parent}, 'CHILD1')
    `);

    const { rows } = await ctx.db.execute<{ parent_ib_user_id: string }>(
      sql`SELECT parent_ib_user_id FROM ib_accounts WHERE user_id = ${child}`,
    );
    expect(rows[0].parent_ib_user_id).toBe(parent);
  });

  it('does NOT stop a cycle — which is why wouldCreateCycle has to exist', async () => {
    const a = await makeUser('cycle-a@test.local');
    const b = await makeUser('cycle-b@test.local');

    await ctx.db.execute(
      sql`INSERT INTO ib_accounts (user_id, level, referral_code) VALUES (${a}, 1, 'CYCA')`,
    );
    await ctx.db.execute(sql`
      INSERT INTO ib_accounts (user_id, level, parent_ib_user_id, referral_code)
      VALUES (${b}, 2, ${a}, 'CYCB')
    `);

    // A → B → A. Postgres accepts it: a self-FK checks only that the target
    // row EXISTS. This test asserts the gap deliberately, so that the service
    // guard is understood as load-bearing rather than belt-and-braces.
    await ctx.db.execute(sql`UPDATE ib_accounts SET parent_ib_user_id = ${b} WHERE user_id = ${a}`);

    const { rows } = await ctx.db.execute<{ parent_ib_user_id: string }>(
      sql`SELECT parent_ib_user_id FROM ib_accounts WHERE user_id = ${a}`,
    );
    expect(rows[0].parent_ib_user_id).toBe(b);
  });

  it('refuses a level that is not on the ladder', async () => {
    const userId = await makeUser('bad-level@test.local');

    expect(
      await constraintViolatedBy(
        ctx.db.execute(
          sql`INSERT INTO ib_accounts (user_id, level, referral_code) VALUES (${userId}, 99, 'NOPE')`,
        ),
      ),
    ).toBe('ib_accounts_level_ib_levels_level_fk');
  });

  it('refuses to delete a level that a partner is placed at', async () => {
    const userId = await makeUser('placed@test.local');
    await ctx.db.execute(
      sql`INSERT INTO ib_accounts (user_id, level, referral_code) VALUES (${userId}, 2, 'PLACED')`,
    );

    // `restrict`, so removing a rung out from under somebody standing on it
    // fails loudly rather than orphaning them.
    expect(
      await constraintViolatedBy(ctx.db.execute(sql`DELETE FROM ib_levels WHERE level = 2`)),
    ).toBe('ib_accounts_level_ib_levels_level_fk');
  });
});

describe('wallets', () => {
  it('refuses a second wallet in the same currency', async () => {
    const userId = await makeUser('two-usd@test.local');

    await ctx.db.execute(sql`INSERT INTO wallets (user_id, currency) VALUES (${userId}, 'USD')`);

    // Otherwise a retried registration leaves a client with two USD wallets and
    // a balance split across them — which reads on screen as money going missing.
    expect(
      await constraintViolatedBy(
        ctx.db.execute(sql`INSERT INTO wallets (user_id, currency) VALUES (${userId}, 'USD')`),
      ),
    ).toBe('wallets_user_currency_uq');
  });

  it('allows one wallet per currency', async () => {
    const userId = await makeUser('multi-currency@test.local');

    await ctx.db.execute(sql`
      INSERT INTO currencies (code, name, symbol) VALUES ('EUR', 'Euro', '€')
      ON CONFLICT (code) DO NOTHING
    `);
    await ctx.db.execute(sql`INSERT INTO wallets (user_id, currency) VALUES (${userId}, 'USD')`);
    await ctx.db.execute(sql`INSERT INTO wallets (user_id, currency) VALUES (${userId}, 'EUR')`);

    const { rows } = await ctx.db.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM wallets WHERE user_id = ${userId}`,
    );
    expect(rows[0].count).toBe(2);
  });

  it('refuses a currency the platform does not have', async () => {
    const userId = await makeUser('unknown-currency@test.local');

    expect(
      await constraintViolatedBy(
        ctx.db.execute(sql`INSERT INTO wallets (user_id, currency) VALUES (${userId}, 'XXX')`),
      ),
    ).toBe('wallets_currency_currencies_code_fk');
  });

  it('refuses a negative balance', async () => {
    const userId = await makeUser('negative@test.local');
    await ctx.db.execute(sql`INSERT INTO wallets (user_id, currency) VALUES (${userId}, 'USD')`);

    // The last line between a bug in a debit path and a client silently owing
    // the broker money.
    expect(
      await constraintViolatedBy(
        ctx.db.execute(sql`UPDATE wallets SET balance = '-0.00000001' WHERE user_id = ${userId}`),
      ),
    ).toBe('wallets_balance_non_negative');
  });

  it('opens at zero and keeps eight decimal places', async () => {
    const userId = await makeUser('precision@test.local');
    await ctx.db.execute(sql`INSERT INTO wallets (user_id, currency) VALUES (${userId}, 'USD')`);

    const opened = await ctx.db.execute<{ balance: string }>(
      sql`SELECT balance FROM wallets WHERE user_id = ${userId}`,
    );
    expect(opened.rows[0].balance).toBe('0.00000000');

    /*
     * §6.1, end to end: the driver returns NUMERIC as a STRING and this asserts
     * the string. A value with seventeen significant digits is chosen because it
     * is beyond what a float can hold exactly — `Number()` on it is already
     * wrong before any formatting, which is the whole reason for the rule.
     */
    await ctx.db.execute(
      sql`UPDATE wallets SET balance = '12345678901.23456789' WHERE user_id = ${userId}`,
    );
    const after = await ctx.db.execute<{ balance: string }>(
      sql`SELECT balance FROM wallets WHERE user_id = ${userId}`,
    );
    expect(after.rows[0].balance).toBe('12345678901.23456789');
  });
});

describe('rejection reasons', () => {
  it("accepts the 'partner' context added in 0030", async () => {
    // Legal only because migration has COMMITTED by the time a test runs — the
    // same reason the partner reasons are seeded in seed.ts and not in SQL.
    await ctx.db.execute(sql`
      INSERT INTO rejection_reasons (context, label)
      VALUES ('partner', 'Application is incomplete or unclear')
      ON CONFLICT (context, label) DO NOTHING
    `);

    const { rows } = await ctx.db.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM rejection_reasons WHERE context = 'partner'`,
    );
    expect(rows[0].count).toBeGreaterThan(0);
  });
});
