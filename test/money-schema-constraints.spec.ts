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

/**
 * The DATABASE's own message for a statement that failed, not the driver's.
 *
 * `constraintViolatedBy` above answers with a constraint NAME, which is the
 * right handle for a check or a foreign key. A missing COLUMN violates no
 * constraint — it never reaches one — so it needs the message instead.
 *
 * Reading `.cause` is the whole point. Drizzle wraps a failure in a
 * `DrizzleQueryError` whose own `message` is the SQL it tried to run, so
 * `rejects.toThrow(/column "kind"/)` matches the text of the query rather than
 * the reason it failed — and passes for entirely the wrong reason on any
 * statement that happens to mention the column. That is how the first version
 * of this assertion was written, and it failed loudly rather than silently only
 * because the query and the error disagreed.
 */
async function failureMessage(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (error) {
    const cause: unknown = (error as { cause?: unknown }).cause ?? error;
    return (cause as Error).message;
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
  await ctx.db.execute(
    sql`TRUNCATE ledger_entries, ib_accruals CASCADE` /* not DELETE: the ledger is append-only by trigger (§6.4). TRUNCATE resets a fixture table without firing row triggers, and no production path truncates. */,
  );
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

  it('mints a wallet number on every INSERT, in the promised format', async () => {
    const userId = await makeUser('numbered@test.local');
    const walletId = await makeWallet(userId, 'USD');

    /*
     * `makeWallet` names no wallet_number, exactly like every real creation
     * site — the DEFAULT is what covers them all, including the set-based
     * `openForAllClients` INSERT…SELECT no app-side generator could reach.
     * 12 lowercase Crockford chars: no i, l, o or u to misread.
     */
    const { rows } = await ctx.db.execute<{ wallet_number: string }>(
      sql`SELECT wallet_number FROM wallets WHERE id = ${walletId}`,
    );
    expect(rows[0].wallet_number).toMatch(/^[0-9a-hjkmnp-tv-z]{12}$/);
  });

  it('refuses two wallets sharing a number', async () => {
    const userId = await makeUser('collision@test.local');
    // USDT, not an invented currency — `wallets.currency` FKs `currencies.code`
    // and the platform seeds exactly USD and USDT.
    const first = await makeWallet(userId, 'USD');
    const second = await makeWallet(userId, 'USDT');

    const { rows } = await ctx.db.execute<{ wallet_number: string }>(
      sql`SELECT wallet_number FROM wallets WHERE id = ${first}`,
    );
    // The unique index is the guarantee; the generator's retry loop is only
    // what makes hitting it astronomically rare.
    expect(
      await constraintViolatedBy(
        ctx.db.execute(
          sql`UPDATE wallets SET wallet_number = ${rows[0].wallet_number} WHERE id = ${second}`,
        ),
      ),
    ).toBe('wallets_wallet_number_uq');
  });

  it('refuses a malformed wallet number — wrong length, uppercase, lookalikes', async () => {
    const userId = await makeUser('malformed@test.local');
    const walletId = await makeWallet(userId, 'USD');

    for (const bad of ['short', '4F7KQ2NM8XCB', 'il0u56789abc']) {
      expect(
        await constraintViolatedBy(
          ctx.db.execute(sql`UPDATE wallets SET wallet_number = ${bad} WHERE id = ${walletId}`),
        ),
      ).toBe('wallets_wallet_number_format');
    }
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

  /**
   * A trading account MAY hold a negative balance. A wallet may not.
   *
   * This asserted the opposite until 0082, and the reversal is deliberate rather
   * than a relaxation. `balance` became a MIRROR of what MT5 holds, and MT5
   * balances go negative for ordinary reasons: an account stopped out through a
   * weekend gap, or one whose overnight swap exceeded its remaining cash,
   * carries a real debit until the broker settles it.
   *
   * The CHECK could not prevent that balance — only prevent us from recording
   * it. The sync's UPDATE raised a violation, the webhook answered 500, the
   * bridge dropped the snapshot, and the console kept showing the last
   * non-negative figure indefinitely with nothing reporting a fault. The one
   * account an operator most needs to see became the one the mirror silently
   * refused to update.
   *
   * The rule the CHECK was also enforcing — that the CRM must never CREATE a
   * negative balance by paying out money the account does not have — did not go
   * away with it. It moved into `TransfersService.settle`, into the WHERE clause
   * of the debit, where it produces an actionable error instead of a constraint
   * violation the filter can only render as a 500. `wallets_balance_non_negative`
   * is untouched: a wallet is a ledger the CRM owns outright.
   */
  it('ACCEPTS a negative balance on a trading account, because MT5 can report one', async () => {
    const userId = await makeUser('negacct@test.local');
    await ctx.db.execute(sql`
      INSERT INTO trading_accounts (user_id, environment, currency, balance)
      VALUES (${userId}, 'live', 'USD', '10')
    `);

    // Executed directly rather than through `constraintViolatedBy`, which exists
    // to assert that a statement IS refused and throws when one succeeds.
    await ctx.db.execute(sql`UPDATE trading_accounts SET balance = '-1' WHERE user_id = ${userId}`);

    const { rows } = await ctx.db.execute<{ balance: string }>(
      sql`SELECT balance FROM trading_accounts WHERE user_id = ${userId}`,
    );
    expect(rows[0].balance).toBe('-1.00000000');
  });
});

describe('payment methods', () => {
  /**
   * What a freshly migrated database actually holds — Whish, disabled, alone.
   *
   * This asserts the SEED, which is why it lives here rather than in
   * `payment-methods.spec.ts`: that suite resets the table before every test, so
   * an assertion there would pass on its own cleanup.
   *
   * `pay_to`, `instructions` and the per-method bounds are absent from the query
   * because the COLUMNS are gone (migration 0042). `kind` is absent for the same
   * reason (0043).
   */
  it('ships Whish, disabled, and no other method', async () => {
    const { rows } = await ctx.db.execute<{
      key: string;
      name: string;
      currency: string;
      enabled: boolean;
      logo_url: string | null;
    }>(sql`SELECT key, name, currency, enabled, logo_url
             FROM payment_methods ORDER BY key`);

    const whish = rows.find((r) => r.key === 'whish');
    expect(whish?.name).toBe('Whish Money');
    expect(whish?.currency).toBe('USD');
    // Null since migration 0065: the 0033 seed pointed at a marketing CDN both
    // frontends' CSP refuses, so it could never render — a real logo arrives
    // when an operator uploads one. Same fix as payment-methods.spec.ts.
    expect(whish?.logo_url).toBeNull();
    // Disabled: `enabled` is the operator's whole decision about whether clients
    // see a method, and nobody has switched this one on.
    expect(whish?.enabled).toBe(false);

    /*
     * ⚠️ `usdt_trc20` must be GONE, and this is the assertion that says so.
     *
     * Migration 0042 seeded it ENABLED to exercise a `crypto` deposit branch.
     * There is no such branch and no crypto provider, so what shipped was a
     * method every client could pick and none could complete: the deposit filed
     * pending and waited on a credit nothing was going to issue. 0043 deletes
     * it.
     */
    expect(rows.map((r) => r.key)).toEqual(['whish']);
  });

  /**
   * ⚠️ `kind` is DROPPED, and inserting it must fail at the DATABASE.
   *
   * The column was a second copy of an answer the code already held — whether a
   * gateway implementation exists for the key — and every reader had started
   * overriding it. This pins that it cannot come back by accident: a restored
   * dump, a stale migration or a hand-written INSERT carrying `kind` is an error
   * here rather than a silently ignored column.
   */
  it('has no kind column — 0043 dropped it', async () => {
    const message = await failureMessage(
      ctx.db.execute(sql`
        INSERT INTO payment_methods (key, name, kind, currency)
        VALUES ('with_kind', 'With kind', 'manual', 'USD')
      `),
    );
    expect(message).toMatch(/column "kind" of relation "payment_methods" does not exist/i);
  });

  it('refuses a method in a currency the platform does not have', async () => {
    expect(
      await constraintViolatedBy(
        ctx.db.execute(sql`
          INSERT INTO payment_methods (key, name, currency)
          VALUES ('bogus', 'Bogus', 'XXX')
        `),
      ),
    ).toBe('payment_methods_currency_currencies_code_fk');
  });
});
