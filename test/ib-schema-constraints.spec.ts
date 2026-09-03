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
      sql`INSERT INTO ib_accounts (user_id, referral_code, program_id)
      VALUES (${first}, 'SHARED', (SELECT id FROM ib_programs ORDER BY sort_order, name LIMIT 1))`,
    );

    // Attribution is permanent per client, so a reissued code would credit one
    // partner's introductions to whoever holds it now.
    expect(
      await constraintViolatedBy(
        ctx.db.execute(
          sql`INSERT INTO ib_accounts (user_id, referral_code, program_id)
      VALUES (${second}, 'SHARED', (SELECT id FROM ib_programs ORDER BY sort_order, name LIMIT 1))`,
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
          INSERT INTO ib_accounts (user_id, parent_ib_user_id, referral_code, program_id)
      VALUES (${partner}, ${stranger}, 'CHILD1', (SELECT id FROM ib_programs ORDER BY sort_order, name LIMIT 1))
        `),
      ),
    ).toBe('ib_accounts_parent_fk');
  });

  it('accepts a parent that IS a partner', async () => {
    const parent = await makeUser('parent@test.local');
    const child = await makeUser('sub@test.local');

    await ctx.db.execute(
      sql`INSERT INTO ib_accounts (user_id, referral_code, program_id)
      VALUES (${parent}, 'PARENT1', (SELECT id FROM ib_programs ORDER BY sort_order, name LIMIT 1))`,
    );
    await ctx.db.execute(sql`
      INSERT INTO ib_accounts (user_id, parent_ib_user_id, referral_code, program_id)
      VALUES (${child}, ${parent}, 'CHILD1', (SELECT id FROM ib_programs ORDER BY sort_order, name LIMIT 1))
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
      sql`INSERT INTO ib_accounts (user_id, referral_code, program_id)
      VALUES (${a}, 'CYCA', (SELECT id FROM ib_programs ORDER BY sort_order, name LIMIT 1))`,
    );
    await ctx.db.execute(sql`
      INSERT INTO ib_accounts (user_id, parent_ib_user_id, referral_code, program_id)
      VALUES (${b}, ${a}, 'CYCB', (SELECT id FROM ib_programs ORDER BY sort_order, name LIMIT 1))
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

  /*
   * The two ladder-FK cases that stood here went with `ib_levels` (0102). The
   * guarantee they described — a partner cannot stand on terms that do not
   * exist, and terms somebody stands on cannot be deleted — moved intact to
   * `program_id`, so it is asserted against the constraint that now carries it.
   */
  it('refuses a partner on a programme that does not exist', async () => {
    const userId = await makeUser('bad-program@test.local');

    expect(
      await constraintViolatedBy(
        ctx.db.execute(
          sql`INSERT INTO ib_accounts (user_id, referral_code, program_id)
              VALUES (${userId}, 'NOPE', '00000000-0000-4000-8000-000000000000')`,
        ),
      ),
    ).toBe('ib_accounts_program_id_ib_programs_id_fk');
  });

  it('refuses to delete a programme that a partner is paid on', async () => {
    const userId = await makeUser('placed@test.local');
    await ctx.db.execute(
      sql`INSERT INTO ib_accounts (user_id, referral_code, program_id)
          VALUES (${userId}, 'PLACED', (SELECT id FROM ib_programs ORDER BY sort_order, name LIMIT 1))`,
    );

    // `restrict`, so removing terms out from under somebody being paid by them
    // fails loudly rather than orphaning them.
    expect(
      await constraintViolatedBy(
        ctx.db.execute(
          sql`DELETE FROM ib_programs
               WHERE id = (SELECT id FROM ib_programs ORDER BY sort_order, name LIMIT 1)`,
        ),
      ),
    ).toBe('ib_accounts_program_id_ib_programs_id_fk');
  });

  /*
   * The TIERS cascade, which is the one cascade in this schema and therefore
   * worth pinning. A tier is a line of a rate card, meaningless without the
   * card — and a programme nobody stands on is the only one that can be deleted
   * at all, per the test above.
   */
  it('takes a programme’s ladder with it when the programme is deleted', async () => {
    const { rows } = await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO ib_programs (name, mode) VALUES ('Cascade Test', 'commission_only') RETURNING id
    `);
    const programId = rows[0].id;
    await ctx.db.execute(
      sql`INSERT INTO ib_program_tiers (program_id, depth, rate) VALUES (${programId}, 1, 10)`,
    );

    await ctx.db.execute(sql`DELETE FROM ib_programs WHERE id = ${programId}`);

    const { rows: left } = await ctx.db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM ib_program_tiers WHERE program_id = ${programId}`,
    );
    expect(left[0].n).toBe('0');
  });

  /*
   * A tier that pays nothing is not a configured zero — it is a row that should
   * not exist. The ROW COUNT is a programme's reach, so a zero at depth 3 claims
   * a reach the programme does not have and strands depth 4 beneath it.
   */
  /*
   * The guarantee is unchanged; the constraint that enforces it was renamed in
   * 0111. `ib_program_tiers_rate_positive` demanded a positive rate on EVERY
   * row, which a per-lot tier legitimately does not carry — so it became
   * `ib_program_tiers_payout_shape`, which requires exactly the column the row's
   * mode reads and forbids the other. A zero-rate percentage tier is still
   * refused, by the branch of that check covering `percent`.
   */
  it('refuses a percentage tier that pays nothing', async () => {
    const { rows } = await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO ib_programs (name, mode) VALUES ('Zero Tier', 'commission_only') RETURNING id
    `);

    expect(
      await constraintViolatedBy(
        ctx.db.execute(
          sql`INSERT INTO ib_program_tiers (program_id, depth, rate) VALUES (${rows[0].id}, 1, 0)`,
        ),
      ),
    ).toBe('ib_program_tiers_payout_shape');
  });

  /*
   * A row can never be ambiguous about WHICH number pays it.
   *
   * Both halves matter. A per-lot tier with no amount would accrue nothing while
   * looking configured; a percentage tier carrying an amount is two live-looking
   * figures on one row, and the next reader has no way to tell which the engine
   * uses. The database refuses both rather than leaving it to the service.
   */
  it('refuses a per-lot tier with no amount to pay', async () => {
    const { rows } = await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO ib_programs (name, mode) VALUES ('Amountless', 'commission_only') RETURNING id
    `);

    expect(
      await constraintViolatedBy(
        ctx.db.execute(sql`
          INSERT INTO ib_program_tiers (program_id, depth, rate, payout_mode)
          VALUES (${rows[0].id}, 1, 0, 'per_lot')
        `),
      ),
    ).toBe('ib_program_tiers_payout_shape');
  });

  it('refuses a percentage tier that also carries a per-lot amount', async () => {
    const { rows } = await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO ib_programs (name, mode) VALUES ('Both Numbers', 'commission_only') RETURNING id
    `);

    expect(
      await constraintViolatedBy(
        ctx.db.execute(sql`
          INSERT INTO ib_program_tiers (program_id, depth, rate, payout_mode, amount_per_lot)
          VALUES (${rows[0].id}, 1, 30, 'percent', 10)
        `),
      ),
    ).toBe('ib_program_tiers_payout_shape');
  });

  /*
   * The positive case, asserted directly rather than through
   * `constraintViolatedBy` — that helper throws when a statement SUCCEEDS, so it
   * can only ever express a refusal. Without this the three refusals above would
   * all pass against a constraint that refused everything.
   */
  it('accepts a per-lot tier carrying only its amount', async () => {
    const { rows } = await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO ib_programs (name, mode) VALUES ('Ten A Lot', 'commission_only') RETURNING id
    `);

    await ctx.db.execute(sql`
      INSERT INTO ib_program_tiers (program_id, depth, rate, payout_mode, amount_per_lot)
      VALUES (${rows[0].id}, 1, 0, 'per_lot', 10)
    `);

    const { rows: stored } = await ctx.db.execute<{ amount_per_lot: string }>(sql`
      SELECT amount_per_lot FROM ib_program_tiers WHERE program_id = ${rows[0].id}
    `);
    expect(stored[0]?.amount_per_lot).toBe('10.00000000');
  });

  /*
   * THE CONFIGURATION-TIME FLOOR (0102), and it is DEFERRED on purpose.
   *
   * Every tier and the rebate are shares of the SAME revenue, so they add up: a
   * programme paying 70 + 30 + a 10 rebate hands out 110% of what the house
   * earned. The trigger fires at COMMIT rather than per statement, so a ladder
   * being rewritten row by row is judged on what it ends as — which is why this
   * has to be asserted through a committed transaction rather than a bare
   * INSERT.
   *
   * It bounds ONE programme. What one TRADE pays out is `checkPlausible` plus
   * `ibMaxRevenueSharePct`, because the earners on a trade may hold different
   * programmes.
   */
  it('refuses a programme whose tiers and rebate exceed the revenue', async () => {
    const { rows } = await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO ib_programs (name, mode, rebate_rate)
      VALUES ('Over Hundred', 'hybrid', 10) RETURNING id
    `);
    const programId = rows[0].id;

    expect(
      await constraintViolatedBy(
        ctx.db.transaction(async (tx) => {
          await tx.execute(
            sql`INSERT INTO ib_program_tiers (program_id, depth, rate) VALUES (${programId}, 1, 70)`,
          );
          await tx.execute(
            sql`INSERT INTO ib_program_tiers (program_id, depth, rate) VALUES (${programId}, 2, 30)`,
          );
        }),
      ),
    ).toBe('ib_program_tiers_share_fits');
  });

  /*
   * The other half of DEFERRED: a ladder swapped 60/40 → 40/60 in one
   * transaction is valid at both ends and must not be refused for the moment in
   * between. Checked per statement, the delete leaves an empty ladder and the
   * first insert is judged against a half-written one.
   */
  it('allows a ladder to be rewritten wholesale inside one transaction', async () => {
    const { rows } = await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO ib_programs (name, mode) VALUES ('Rewritable', 'commission_only') RETURNING id
    `);
    const programId = rows[0].id;
    await ctx.db.execute(sql`
      INSERT INTO ib_program_tiers (program_id, depth, rate)
      VALUES (${programId}, 1, 60), (${programId}, 2, 40)
    `);

    await ctx.db.transaction(async (tx) => {
      await tx.execute(sql`DELETE FROM ib_program_tiers WHERE program_id = ${programId}`);
      await tx.execute(sql`
        INSERT INTO ib_program_tiers (program_id, depth, rate)
        VALUES (${programId}, 1, 40), (${programId}, 2, 60)
      `);
    });

    const { rows: after } = await ctx.db.execute<{ depth: number; rate: string }>(
      sql`SELECT depth, rate FROM ib_program_tiers WHERE program_id = ${programId} ORDER BY depth`,
    );
    expect(after.map((r) => r.rate)).toEqual(['40.0000', '60.0000']);
  });
});

describe('wallets', () => {
  it('refuses a second wallet of the same KIND in the same currency', async () => {
    const userId = await makeUser('two-usd@test.local');

    await ctx.db.execute(sql`INSERT INTO wallets (user_id, currency) VALUES (${userId}, 'USD')`);

    // Otherwise a retried registration leaves a client with two USD main wallets
    // and a balance split across them — which reads on screen as money going
    // missing. The index gained `kind` (migration 0077) and did not lose this:
    // a repeated insert with the same kind is still refused.
    expect(
      await constraintViolatedBy(
        ctx.db.execute(sql`INSERT INTO wallets (user_id, currency) VALUES (${userId}, 'USD')`),
      ),
    ).toBe('wallets_user_currency_kind_uq');
  });

  it('allows a main AND a commission wallet in one currency', async () => {
    /*
     * The other half of the same index, and the reason it gained a column.
     *
     * A partner holds their earnings in a `commission` USD wallet beside their
     * ordinary `main` one. Under the old two-column key the second insert was a
     * UNIQUE violation — and the symptom would not have looked like a constraint
     * error to anyone reading a bug report, it would have looked like commission
     * silently never being paid.
     */
    const userId = await makeUser('main-and-commission@test.local');

    await ctx.db.execute(
      sql`INSERT INTO wallets (user_id, currency, kind) VALUES (${userId}, 'USD', 'main')`,
    );
    await ctx.db.execute(
      sql`INSERT INTO wallets (user_id, currency, kind) VALUES (${userId}, 'USD', 'commission')`,
    );

    const { rows } = await ctx.db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM wallets WHERE user_id = ${userId} AND currency = 'USD'`,
    );
    expect(rows[0].n).toBe('2');
  });

  it('defaults a wallet to `main`, so nothing reaches a commission wallet by omission', async () => {
    /*
     * Every money rail — deposit, withdrawal, hold, trading transfer — inserts
     * without naming a kind. If the column defaulted the other way, or had no
     * default, a client's deposit could land in the wallet the wallet screen
     * deliberately cannot see.
     */
    const userId = await makeUser('default-kind@test.local');
    await ctx.db.execute(sql`INSERT INTO wallets (user_id, currency) VALUES (${userId}, 'USD')`);

    const { rows } = await ctx.db.execute<{ kind: string }>(
      sql`SELECT kind FROM wallets WHERE user_id = ${userId}`,
    );
    expect(rows[0].kind).toBe('main');
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
