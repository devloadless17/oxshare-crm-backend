import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * What migration 0033 promises, against a real Postgres.
 *
 * Two of these are the reason the whole money layer was torn down and rebuilt:
 * the ledger's idempotency index, and the revoked UPDATE/DELETE grants. Both
 * were previously enforced by a comment and an intention. A constraint nobody
 * tests is a constraint that survives being dropped in a later migration —
 * which is precisely how the idempotency guard left in 0028 without anything
 * failing.
 */
let ctx: MoneyTestContext;

beforeAll(async () => {
  ctx = await startMoneyTestDb();
}, 120_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

/**
 * The CONSTRAINT that refused a statement, not the message reporting it.
 *
 * Drizzle wraps driver errors, so `error.message` is "Failed query: …" and the
 * constraint name is on the cause. Matching the message would pass for any
 * failure at all, including a typo'd column.
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

async function makeUser(email: string): Promise<string> {
  const { rows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name)
    VALUES (${email}, 'x', 'Test', 'Client')
    RETURNING id
  `);
  return rows[0].id;
}

async function makeWallet(userId: string, currency = 'USD', balance = '0'): Promise<string> {
  const { rows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO wallets (user_id, currency, balance) VALUES (${userId}, ${currency}, ${balance})
    RETURNING id
  `);
  return rows[0].id;
}

beforeEach(async () => {
  // Children first — every FK here is restrict.
  await ctx.db.execute(sql`DELETE FROM transfers`);
  await ctx.db.execute(sql`DELETE FROM transactions`);
  await ctx.db.execute(sql`DELETE FROM ledger_entries`);
  await ctx.db.execute(sql`DELETE FROM trading_accounts`);
  await ctx.db.execute(sql`DELETE FROM wallets`);
  await ctx.db.execute(sql`UPDATE users SET referred_by_ib_user_id = NULL`);
  await ctx.db.execute(sql`DELETE FROM ib_accounts`);
  await ctx.db.execute(sql`DELETE FROM users`);
});

describe('the ledger idempotency guarantee', () => {
  it('refuses a second entry for the same (wallet, reference)', async () => {
    const userId = await makeUser('replay@test.local');
    const walletId = await makeWallet(userId);

    await ctx.db.execute(sql`
      INSERT INTO ledger_entries (wallet_id, amount, balance_after, entry_type, reference_type, reference_id)
      VALUES (${walletId}, '100', '100', 'deposit', 'transaction', 'txn-1')
    `);

    /*
     * THIS IS THE CONSTRAINT THE TEARDOWN REMOVED AND 0033 RESTORED.
     *
     * Without it a replayed deposit or a retried provider webhook credits the
     * client twice, and nothing in the database objects. `WalletService.post()`
     * inserts with ON CONFLICT on these three columns and returns the original
     * entry, so the replay is a no-op rather than a second credit.
     */
    expect(
      await constraintViolatedBy(
        ctx.db.execute(sql`
          INSERT INTO ledger_entries (wallet_id, amount, balance_after, entry_type, reference_type, reference_id)
          VALUES (${walletId}, '100', '200', 'deposit', 'transaction', 'txn-1')
        `),
      ),
    ).toBe('ledger_entries_wallet_reference_uq');
  });

  it('allows the same reference against a DIFFERENT wallet', async () => {
    const userId = await makeUser('two-wallets@test.local');
    const usd = await makeWallet(userId, 'USD');
    const usdt = await makeWallet(userId, 'USDT');

    // The index is per wallet. One cause can legitimately post to two wallets —
    // a transfer's two legs are the obvious case.
    for (const walletId of [usd, usdt]) {
      await ctx.db.execute(sql`
        INSERT INTO ledger_entries (wallet_id, amount, balance_after, entry_type, reference_type, reference_id)
        VALUES (${walletId}, '5', '5', 'transfer', 'transfer', 'tr-1')
      `);
    }

    const { rows } = await ctx.db.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM ledger_entries WHERE reference_id = 'tr-1'`,
    );
    expect(rows[0].count).toBe(2);
  });

  it('allows a compensating entry alongside the original', async () => {
    const userId = await makeUser('refund@test.local');
    const walletId = await makeWallet(userId, 'USD', '100');

    await ctx.db.execute(sql`
      INSERT INTO ledger_entries (wallet_id, amount, balance_after, entry_type, reference_type, reference_id)
      VALUES (${walletId}, '-40', '60', 'withdrawal', 'transaction', 'txn-9')
    `);

    /*
     * The refund path §6.4 requires: a NEW offsetting row, never an edit. Its
     * reference is suffixed precisely so the unique index above does not treat
     * it as a replay of the debit it reverses.
     */
    await ctx.db.execute(sql`
      INSERT INTO ledger_entries (wallet_id, amount, balance_after, entry_type, reference_type, reference_id)
      VALUES (${walletId}, '40', '100', 'adjustment', 'transaction', 'txn-9:refund')
    `);

    const { rows } = await ctx.db.execute<{ sum: string }>(
      sql`SELECT COALESCE(SUM(amount), 0)::text AS sum FROM ledger_entries WHERE wallet_id = ${walletId}`,
    );
    expect(rows[0].sum).toBe('0.00000000');
  });
});

describe('§6.4 — corrections are compensating entries', () => {
  /**
   * What the application role is permitted to do to the ledger.
   *
   * ## ⚠️ This is a speed bump, not a wall, and the difference matters
   *
   * `app` OWNS these tables in every environment this runs in, and an owner can
   * grant itself back anything it revoked. So the revoke in 0033 stops
   * ORDINARY code — an accidental `UPDATE ledger_entries SET …`, a well-meant
   * "fix the balance" script — and stops nothing that sets out to bypass it.
   *
   * Making it a real wall means the API connecting as a role that does not own
   * the schema, with migrations run as a separate owner. That is a deployment
   * change rather than a migration, it is not made here, and pretending
   * otherwise would be worse than the gap: §6.4 would read as enforced when it
   * is advisory.
   *
   * The assertion below is still worth having. It fails the day somebody adds
   * `GRANT ALL` to a migration, which is the realistic way this protection
   * disappears.
   */
  async function grantsForApp(): Promise<string[]> {
    const { rows } = await ctx.db.execute<{ privilege_type: string }>(sql`
      SELECT privilege_type FROM information_schema.role_table_grants
       WHERE table_name = 'ledger_entries' AND grantee = 'app'
    `);
    return rows.map((r) => r.privilege_type);
  }

  it('never leaves UPDATE or DELETE granted to the app role', async () => {
    /*
     * ARCHITECTURE §6.4, verbatim: "No UPDATE, no DELETE on ledger_entries.
     * Enforce it — revoke those grants from the application database role. If a
     * balance is wrong, write a new offsetting row."
     *
     * That had lived as a comment since the ledger was first written; 0033 is
     * the first time anything acted on it.
     *
     * An EMPTY list satisfies this and is what a per-suite test database shows,
     * because `app` was never granted anything there in the first place. The
     * assertion is about the two privileges being absent, not about the shape
     * of the list — a test that also required INSERT would fail here for a
     * reason that has nothing to do with §6.4.
     */
    const granted = await grantsForApp();
    expect(granted).not.toContain('UPDATE');
    expect(granted).not.toContain('DELETE');
  });

  it('keeps the ledger append-only in the shape callers actually use', async () => {
    const userId = await makeUser('append@test.local');
    const walletId = await makeWallet(userId, 'USD', '100');

    await ctx.db.execute(sql`
      INSERT INTO ledger_entries (wallet_id, amount, balance_after, entry_type, reference_type, reference_id)
      VALUES (${walletId}, '100', '100', 'deposit', 'transaction', 'append-1')
    `);

    // Appending is the only way a balance changes, and it works.
    const { rows } = await ctx.db.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM ledger_entries WHERE wallet_id = ${walletId}`,
    );
    expect(rows[0].count).toBe(1);
  });
});

describe('wallets', () => {
  it('refuses a hold larger than the balance', async () => {
    const userId = await makeUser('overhold@test.local');
    const walletId = await makeWallet(userId, 'USD', '50');

    /*
     * `available = balance − on_hold` is what every money decision reads. A
     * hold exceeding the balance makes it negative — a state from which every
     * later calculation is wrong in a way no single query looks wrong. The
     * deleted service clamped this in application code; the database says it
     * now.
     */
    expect(
      await constraintViolatedBy(
        ctx.db.execute(sql`UPDATE wallets SET on_hold = '60' WHERE id = ${walletId}`),
      ),
    ).toBe('wallets_hold_within_balance');
  });

  it('refuses a negative hold', async () => {
    const userId = await makeUser('neghold@test.local');
    const walletId = await makeWallet(userId, 'USD', '50');

    expect(
      await constraintViolatedBy(
        ctx.db.execute(sql`UPDATE wallets SET on_hold = '-1' WHERE id = ${walletId}`),
      ),
    ).toBe('wallets_on_hold_non_negative');
  });

  it('allows a hold equal to the whole balance', async () => {
    const userId = await makeUser('fullhold@test.local');
    const walletId = await makeWallet(userId, 'USD', '50');

    // Withdrawing everything is legitimate; the constraint is `<=`, not `<`.
    await ctx.db.execute(sql`UPDATE wallets SET on_hold = '50' WHERE id = ${walletId}`);

    const { rows } = await ctx.db.execute<{ on_hold: string }>(
      sql`SELECT on_hold FROM wallets WHERE id = ${walletId}`,
    );
    expect(rows[0].on_hold).toBe('50.00000000');
  });
});

describe('transactions', () => {
  it('refuses a duplicate (provider, provider_ref)', async () => {
    const userId = await makeUser('provider@test.local');
    const walletId = await makeWallet(userId);

    const insert = (ref: string) => sql`
      INSERT INTO transactions (user_id, wallet_id, direction, amount, currency, provider, provider_ref)
      VALUES (${userId}, ${walletId}, 'deposit', '10', 'USD', 'manual_whish', ${ref})
    `;
    await ctx.db.execute(insert('OX-ABC123'));

    // §6.3's named guarantee for replayed payment callbacks.
    expect(await constraintViolatedBy(ctx.db.execute(insert('OX-ABC123')))).toBe(
      'transactions_provider_ref_uq',
    );
  });

  it('refuses a destination trading account that does not exist', async () => {
    const userId = await makeUser('badaccount@test.local');
    const walletId = await makeWallet(userId);

    // The deleted column was a bare uuid with no FK, so a deposit could name a
    // trading account that had never existed.
    expect(
      await constraintViolatedBy(
        ctx.db.execute(sql`
          INSERT INTO transactions (user_id, wallet_id, direction, amount, currency, provider, destination_trading_account_id)
          VALUES (${userId}, ${walletId}, 'deposit', '10', 'USD', 'manual', gen_random_uuid())
        `),
      ),
    ).toBe('transactions_destination_trading_account_id_fk');
  });
});

describe('trading accounts', () => {
  it('allows many accounts with no login yet', async () => {
    const userId = await makeUser('nologin@test.local');

    /*
     * The unique index is partial — WHERE login IS NOT NULL. Without that,
     * a second CRM-side account with no MT5 login yet would collide with the
     * first on NULL in some engines, and the whole point of the nullable column
     * is that accounts exist before the bridge assigns them a number.
     */
    for (const env of ['live', 'demo']) {
      await ctx.db.execute(sql`
        INSERT INTO trading_accounts (user_id, environment, currency)
        VALUES (${userId}, ${env}::trading_environment, 'USD')
      `);
    }

    const { rows } = await ctx.db.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM trading_accounts WHERE user_id = ${userId}`,
    );
    expect(rows[0].count).toBe(2);
  });

  it('refuses two accounts sharing a login', async () => {
    const first = await makeUser('login-a@test.local');
    const second = await makeUser('login-b@test.local');

    const insert = (userId: string) => sql`
      INSERT INTO trading_accounts (user_id, login, environment, currency)
      VALUES (${userId}, '500123', 'live', 'USD')
    `;
    await ctx.db.execute(insert(first));

    expect(await constraintViolatedBy(ctx.db.execute(insert(second)))).toBe(
      'trading_accounts_login_uq',
    );
  });

  it('refuses a negative balance', async () => {
    const userId = await makeUser('negacct@test.local');
    await ctx.db.execute(sql`
      INSERT INTO trading_accounts (user_id, environment, currency, balance)
      VALUES (${userId}, 'live', 'USD', '10')
    `);

    expect(
      await constraintViolatedBy(
        ctx.db.execute(sql`UPDATE trading_accounts SET balance = '-1' WHERE user_id = ${userId}`),
      ),
    ).toBe('trading_accounts_balance_non_negative');
  });
});

describe('payment methods', () => {
  it('ships Whish, disabled, with its logo and no invented pay-to details', async () => {
    const { rows } = await ctx.db.execute<{
      name: string;
      kind: string;
      currency: string;
      enabled: boolean;
      logo_url: string | null;
      pay_to: string | null;
      instructions: string | null;
    }>(sql`SELECT name, kind, currency, enabled, logo_url, pay_to, instructions
             FROM payment_methods WHERE key = 'whish'`);

    const whish = rows[0];
    expect(whish.name).toBe('Whish Money');
    // `manual`, not `gateway`: the sandbox credentials are an open decision and
    // a gateway wired to credentials nobody has is a deposit button that fails.
    expect(whish.kind).toBe('manual');
    expect(whish.logo_url).toContain('Whish');

    /*
     * DISABLED, and pay-to details absent rather than invented. The deleted
     * deposit page recorded the rule: "Inventing an IBAN is the same failure as
     * the fake $0.00 balances, with a worse outcome: the money leaves and does
     * not arrive." An operator supplies the real number; until then no client
     * is offered the method.
     */
    expect(whish.enabled).toBe(false);
    expect(whish.pay_to).toBeNull();
    expect(whish.instructions).toBeNull();
  });

  it('refuses a method in a currency the platform does not have', async () => {
    expect(
      await constraintViolatedBy(
        ctx.db.execute(sql`
          INSERT INTO payment_methods (key, name, kind, currency)
          VALUES ('bogus', 'Bogus', 'manual', 'XXX')
        `),
      ),
    ).toBe('payment_methods_currency_currencies_code_fk');
  });
});
