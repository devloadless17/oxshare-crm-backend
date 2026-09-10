import { WalletsStore } from '../src/store/wallets.store';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { WalletProvisioningService } from '../src/modules/wallet/wallet-provisioning.service';
import { CurrenciesService } from '../src/modules/currencies/currencies.service';
import { auditStubAs } from './audit-stub';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * The ledger write — ARCHITECTURE §6.2, which calls the bug it prevents "the
 * single most likely money bug in the system".
 *
 * Every test here runs against a real Postgres because every property being
 * checked is a property of the DATABASE: the row lock, the ON CONFLICT replay,
 * the running `balance_after`. A stubbed database would let all three pass
 * while none of them worked.
 */
let ctx: MoneyTestContext;
let wallets: WalletService;
let provisioning: WalletProvisioningService;

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  wallets = new WalletService(ctx.db);
  provisioning = new WalletProvisioningService(
    wallets,
    new CurrenciesService(ctx.db, auditStubAs()),
    new WalletsStore(ctx.db),
  );
}, 120_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

async function makeUser(email: string): Promise<string> {
  const { rows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name)
    VALUES (${email}, 'x', 'Test', 'Client')
    RETURNING id
  `);
  return rows[0].id;
}

async function balanceOf(userId: string, currency = 'USD'): Promise<string> {
  const { rows } = await ctx.db.execute<{ balance: string }>(
    sql`SELECT balance FROM wallets WHERE user_id = ${userId} AND currency = ${currency}`,
  );
  return rows[0].balance;
}

beforeEach(async () => {
  await ctx.db.execute(
    sql`TRUNCATE ledger_entries, ib_accruals CASCADE` /* not DELETE: the ledger is append-only by trigger (§6.4). TRUNCATE resets a fixture table without firing row triggers, and no production path truncates. */,
  );
  await ctx.db.execute(sql`DELETE FROM wallets`);
  await ctx.db.execute(sql`UPDATE users SET referred_by_ib_user_id = NULL`);
  await ctx.db.execute(sql`DELETE FROM ib_accounts`);
  await ctx.db.execute(sql`DELETE FROM users`);
  // Back to the two the platform ships with, in case a test disabled one.
  await ctx.db.execute(sql`UPDATE currencies SET enabled = true`);
});

describe('posting to the ledger', () => {
  it('credits a wallet and records the running balance', async () => {
    const userId = await makeUser('credit@test.local');

    const { entry, replayed } = await wallets.post({
      userId,
      currency: 'USD',
      amount: '100.50',
      entryType: 'deposit',
      referenceType: 'transaction',
      referenceId: 'txn-1',
    });

    expect(replayed).toBe(false);
    // §6.1: a string at every boundary, at NUMERIC(28,8) scale.
    expect(entry.amount).toBe('100.50000000');
    expect(entry.balanceAfter).toBe('100.50000000');
    expect(await balanceOf(userId)).toBe('100.50000000');
  });

  it('accumulates across entries', async () => {
    const userId = await makeUser('accumulate@test.local');

    for (const [i, amount] of ['10', '20', '30'].entries()) {
      await wallets.post({
        userId,
        currency: 'USD',
        amount,
        entryType: 'deposit',
        referenceType: 'transaction',
        referenceId: `txn-${i}`,
      });
    }

    expect(await balanceOf(userId)).toBe('60.00000000');
  });

  it('refuses to overdraw', async () => {
    const userId = await makeUser('overdraw@test.local');
    await wallets.post({
      userId,
      currency: 'USD',
      amount: '50',
      entryType: 'deposit',
      referenceType: 'transaction',
      referenceId: 'in',
    });

    await expect(
      wallets.post({
        userId,
        currency: 'USD',
        amount: '-60',
        entryType: 'withdrawal',
        referenceType: 'transaction',
        referenceId: 'out',
      }),
    ).rejects.toThrow(/insufficient balance/i);

    // And left the balance alone.
    expect(await balanceOf(userId)).toBe('50.00000000');
  });

  it('refuses a zero-amount entry', async () => {
    const userId = await makeUser('zero@test.local');

    await expect(
      wallets.post({
        userId,
        currency: 'USD',
        amount: '0',
        entryType: 'adjustment',
        referenceType: 'transaction',
        referenceId: 'nothing',
      }),
    ).rejects.toThrow(/non-zero/i);
  });

  it('keeps eight decimal places through arithmetic', async () => {
    const userId = await makeUser('precision@test.local');

    /*
     * §6.1, end to end. These two summed as floats give 0.30000000000000004;
     * decimal.js gives 0.3. The assertion is on the STRING because that is what
     * crosses every boundary — a test comparing numbers would be asserting the
     * bug.
     */
    await wallets.post({
      userId,
      currency: 'USD',
      amount: '0.1',
      entryType: 'deposit',
      referenceType: 'transaction',
      referenceId: 'a',
    });
    await wallets.post({
      userId,
      currency: 'USD',
      amount: '0.2',
      entryType: 'deposit',
      referenceType: 'transaction',
      referenceId: 'b',
    });

    expect(await balanceOf(userId)).toBe('0.30000000');
  });

  it('survives a value beyond what a float can hold exactly', async () => {
    const userId = await makeUser('big@test.local');

    // Seventeen significant digits: `Number()` on this is already wrong before
    // any formatting, which is the whole reason for the rule.
    await wallets.post({
      userId,
      currency: 'USD',
      amount: '12345678901.23456789',
      entryType: 'deposit',
      referenceType: 'transaction',
      referenceId: 'big',
    });

    expect(await balanceOf(userId)).toBe('12345678901.23456789');
  });
});

describe('idempotency — the guarantee the teardown removed', () => {
  it('makes a replayed cause a no-op that returns the original entry', async () => {
    const userId = await makeUser('replay@test.local');
    const params = {
      userId,
      currency: 'USD',
      amount: '100',
      entryType: 'deposit' as const,
      referenceType: 'transaction',
      referenceId: 'txn-replay',
    };

    const first = await wallets.post(params);
    const second = await wallets.post(params);

    /*
     * THE POINT. A retried provider webhook or a double-submitted form posts
     * the same (wallet, reference) twice; the second is absorbed by
     * `ledger_entries_wallet_reference_uq` and the balance does not move.
     */
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.entry.id).toBe(first.entry.id);
    expect(await balanceOf(userId)).toBe('100.00000000');
  });

  it('absorbs a replay even when the amount differs', async () => {
    const userId = await makeUser('replay-diff@test.local');
    const base = {
      userId,
      currency: 'USD',
      entryType: 'deposit' as const,
      referenceType: 'transaction',
      referenceId: 'txn-x',
    };

    await wallets.post({ ...base, amount: '100' });
    const second = await wallets.post({ ...base, amount: '999' });

    /*
     * The reference identifies the CAUSE, so a second post naming it is the
     * same event however it is described. Crediting 999 here would be worse
     * than either outcome: the caller believes a new operation succeeded.
     */
    expect(second.replayed).toBe(true);
    expect(await balanceOf(userId)).toBe('100.00000000');
  });

  it('treats the same reference against different wallets as different causes', async () => {
    const userId = await makeUser('two-currencies@test.local');

    for (const currency of ['USD', 'USDT']) {
      await wallets.post({
        userId,
        currency,
        amount: '5',
        entryType: 'transfer',
        referenceType: 'transfer',
        referenceId: 'tr-1',
      });
    }

    // A transfer's two legs share a reference by design.
    expect(await balanceOf(userId, 'USD')).toBe('5.00000000');
    expect(await balanceOf(userId, 'USDT')).toBe('5.00000000');
  });
});

describe('concurrency — §6.2, the lost update', () => {
  it('does not lose a credit when two post at once', async () => {
    const userId = await makeUser('concurrent@test.local');
    await wallets.getOrCreateWallet(userId, 'USD');

    /*
     * The bug §6.2 exists to prevent, stated there as "the single most likely
     * money bug in the system": two concurrent credits both read the same prior
     * balance, both compute the same `balance_after`, and one write is lost.
     *
     * `lockWallet` takes `FOR UPDATE` inside each transaction, so the second
     * blocks until the first commits and reads the balance the first wrote.
     * Fired together with distinct references so nothing is absorbed as a
     * replay — every one of these is a real, separate credit.
     */
    const posts = Array.from({ length: 10 }, (_, i) =>
      wallets.post({
        userId,
        currency: 'USD',
        amount: '10',
        entryType: 'deposit',
        referenceType: 'transaction',
        referenceId: `concurrent-${i}`,
      }),
    );
    await Promise.all(posts);

    expect(await balanceOf(userId)).toBe('100.00000000');
  });

  it('leaves the ledger summing to the balance after concurrent writes', async () => {
    const userId = await makeUser('sum@test.local');
    await wallets.getOrCreateWallet(userId, 'USD');

    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        wallets.post({
          userId,
          currency: 'USD',
          amount: '12.5',
          entryType: 'deposit',
          referenceType: 'transaction',
          referenceId: `sum-${i}`,
        }),
      ),
    );

    /*
     * The reconciliation invariant, checked directly: sum(ledger) == balance.
     * A lost update breaks this even when the final balance happens to look
     * plausible, which is why the hourly job compares them rather than trusting
     * either alone.
     */
    const { rows } = await ctx.db.execute<{ balance: string; ledger_sum: string }>(sql`
      SELECT w.balance::text AS balance, COALESCE(SUM(le.amount), 0)::text AS ledger_sum
        FROM wallets w LEFT JOIN ledger_entries le ON le.wallet_id = w.id
       WHERE w.user_id = ${userId}
       GROUP BY w.balance
    `);
    expect(rows[0].ledger_sum).toBe(rows[0].balance);
  });

  it('opens exactly one wallet when two callers race to create it', async () => {
    const userId = await makeUser('race-create@test.local');

    await Promise.all(Array.from({ length: 5 }, () => wallets.getOrCreateWallet(userId, 'USD')));

    const { rows } = await ctx.db.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM wallets WHERE user_id = ${userId}`,
    );
    // `wallets_user_currency_uq` plus onConflictDoNothing. A read-then-insert
    // would leave several here, with a balance split across them.
    expect(rows[0].count).toBe(1);
  });

  it('carries a well-formed wallet number, stable across the idempotent re-call', async () => {
    const userId = await makeUser('numbered-svc@test.local');

    const first = await wallets.getOrCreateWallet(userId, 'USD');
    // Minted by the column DEFAULT — the service names no number.
    expect(first.walletNumber).toMatch(/^[0-9a-hjkmnp-tv-z]{12}$/);

    /*
     * The second call hits ON CONFLICT DO NOTHING and returns the EXISTING
     * row. Asserted because a re-mint here would hand a client a new "wallet
     * number" on every retried request — an identifier is only one if it
     * holds still.
     */
    const again = await wallets.getOrCreateWallet(userId, 'USD');
    expect(again.walletNumber).toBe(first.walletNumber);
  });
});

describe('holds', () => {
  it('reserves without changing the balance or writing a ledger row', async () => {
    const userId = await makeUser('hold@test.local');
    await wallets.post({
      userId,
      currency: 'USD',
      amount: '100',
      entryType: 'deposit',
      referenceType: 'transaction',
      referenceId: 'funded',
    });

    await wallets.hold(userId, 'USD', '30');

    // A hold is not a balance change, so it posts nothing.
    const { rows } = await ctx.db.execute<{ count: number; balance: string; on_hold: string }>(sql`
      SELECT (SELECT count(*)::int FROM ledger_entries) AS count,
             w.balance, w.on_hold
        FROM wallets w WHERE w.user_id = ${userId}
    `);
    expect(rows[0].count).toBe(1);
    expect(rows[0].balance).toBe('100.00000000');
    expect(rows[0].on_hold).toBe('30.00000000');
  });

  it('refuses a hold beyond what is available', async () => {
    const userId = await makeUser('overhold@test.local');
    await wallets.post({
      userId,
      currency: 'USD',
      amount: '50',
      entryType: 'deposit',
      referenceType: 'transaction',
      referenceId: 'funded',
    });

    await expect(wallets.hold(userId, 'USD', '60')).rejects.toThrow(/insufficient available/i);
  });

  it('counts existing holds against a second one', async () => {
    const userId = await makeUser('twoholds@test.local');
    await wallets.post({
      userId,
      currency: 'USD',
      amount: '100',
      entryType: 'deposit',
      referenceType: 'transaction',
      referenceId: 'funded',
    });

    await wallets.hold(userId, 'USD', '70');
    // available = 100 - 70 = 30, so 40 must be refused.
    await expect(wallets.hold(userId, 'USD', '40')).rejects.toThrow(/insufficient available/i);
  });

  it('releases a hold', async () => {
    const userId = await makeUser('release@test.local');
    await wallets.post({
      userId,
      currency: 'USD',
      amount: '100',
      entryType: 'deposit',
      referenceType: 'transaction',
      referenceId: 'funded',
    });
    await wallets.hold(userId, 'USD', '40');

    await wallets.release(userId, 'USD', '40');

    const { rows } = await ctx.db.execute<{ on_hold: string }>(
      sql`SELECT on_hold FROM wallets WHERE user_id = ${userId}`,
    );
    expect(rows[0].on_hold).toBe('0.00000000');
  });
});

describe('provisioning', () => {
  it('opens a wallet in every enabled currency', async () => {
    const userId = await makeUser('provision@test.local');

    await provisioning.openAllEnabledWallets(userId);

    const { rows } = await ctx.db.execute<{ currency: string }>(
      sql`SELECT currency FROM wallets WHERE user_id = ${userId} ORDER BY currency`,
    );
    // The two the platform ships with. An operator adding a third changes this
    // for clients who register afterwards; existing ones are caught up by
    // `openWalletForAllClients` when the currency is enabled — see below.
    expect(rows.map((r) => r.currency)).toEqual(['USD', 'USDT']);
  });

  it('is idempotent — running it twice adds nothing', async () => {
    const userId = await makeUser('provision-twice@test.local');

    await provisioning.openAllEnabledWallets(userId);
    await provisioning.openAllEnabledWallets(userId);

    const { rows } = await ctx.db.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM wallets WHERE user_id = ${userId}`,
    );
    expect(rows[0].count).toBe(2);
  });

  it('skips a DISABLED currency', async () => {
    await ctx.db.execute(sql`UPDATE currencies SET enabled = false WHERE code = 'USDT'`);
    const userId = await makeUser('provision-disabled@test.local');

    await provisioning.openAllEnabledWallets(userId);

    const { rows } = await ctx.db.execute<{ currency: string }>(
      sql`SELECT currency FROM wallets WHERE user_id = ${userId}`,
    );
    expect(rows.map((r) => r.currency)).toEqual(['USD']);
  });

  it('NEVER throws, even with no currencies at all', async () => {
    await ctx.db.execute(sql`UPDATE currencies SET enabled = false`);
    const userId = await makeUser('provision-none@test.local');

    /*
     * The rule the service exists to hold: a registration that fails after the
     * user row is committed leaves an account nobody can sign into and nobody
     * can re-create, because the address is taken. A misconfigured platform
     * costs the client their wallets, not their account.
     */
    await expect(provisioning.openAllEnabledWallets(userId)).resolves.toBeUndefined();
  });
});

/*
 * The bulk backfill — `scripts/backfill-wallets.mjs` and nothing else.
 *
 * It closes the gap that produced clients holding USD and USDT long after four
 * more currencies were live: registration opens what is enabled AT THAT MOMENT
 * and nothing revisits the decision. It briefly ran automatically when a
 * currency was enabled; that trigger was removed, because adding one currency
 * should not write a row per client inside the request that saved the form.
 *
 * The operation is still worth holding to its guarantees — it is run by hand
 * against real balances, which makes "never touches an existing one" the
 * assertion that matters most here.
 */
describe('the bulk wallet backfill', () => {
  /*
   * Back to the two the platform ships with.
   *
   * The outer `beforeEach` resets `enabled` but does not REMOVE a currency a
   * test added, so without this the AED row below survives into the next test
   * and `openAllEnabledWallets` quietly opens three wallets where the assertion
   * expects two. Inner hooks run after outer ones, so the wallets referencing
   * these rows are already gone by the time this deletes them.
   */
  beforeEach(async () => {
    await ctx.db.execute(sql`DELETE FROM currencies WHERE code NOT IN ('USD', 'USDT')`);
  });

  it('opens the new currency on clients who registered before it existed', async () => {
    const before = await makeUser('backfill-existing@test.local');
    await provisioning.openAllEnabledWallets(before);
    expect(await currenciesOf(before)).toEqual(['USD', 'USDT']);

    await ctx.db.execute(sql`
      INSERT INTO currencies (code, name, symbol, decimals, enabled, is_default, sort_order)
      VALUES ('AED', 'UAE Dirham', 'د.إ', 2, true, false, 9)
      ON CONFLICT (code) DO UPDATE SET enabled = true`);

    const opened = await provisioning.openWalletForAllClients('AED');

    expect(opened).toBe(1);
    expect(await currenciesOf(before)).toEqual(['AED', 'USD', 'USDT']);
  });

  it('is idempotent — a second run adds nothing and reports nothing', async () => {
    const userId = await makeUser('backfill-twice@test.local');
    await provisioning.openAllEnabledWallets(userId);

    expect(await provisioning.openWalletForAllClients('USD')).toBe(0);
    expect(await currenciesOf(userId)).toEqual(['USD', 'USDT']);
  });

  it('leaves an existing balance untouched', async () => {
    const userId = await makeUser('backfill-funded@test.local');
    await wallets.post({
      userId,
      currency: 'USD',
      amount: '250.00000000',
      entryType: 'deposit',
      referenceType: 'test',
      referenceId: 'backfill-funded',
    });

    await provisioning.openWalletForAllClients('USD');

    // ON CONFLICT DO NOTHING, not an upsert that resets the row — a backfill
    // that zeroed a funded wallet would be the worst possible bug in this file.
    expect(await balanceOf(userId)).toBe('250.00000000');
  });

  it('numbers every wallet the set-based backfill creates, all distinct', async () => {
    /*
     * `openForAllClients` is one INSERT…SELECT over every user — the creation
     * site no application-side generator could reach, and the reason the
     * wallet number is a column DEFAULT. Several users at once, so a
     * generator that produced one value per STATEMENT rather than per ROW
     * would collide here and nowhere else.
     */
    for (const n of [1, 2, 3]) await makeUser(`bulk-number-${n}@test.local`);

    await provisioning.openWalletForAllClients('USD');

    const { rows } = await ctx.db.execute<{ wallet_number: string }>(
      sql`SELECT wallet_number FROM wallets WHERE currency = 'USD'`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) expect(row.wallet_number).toMatch(/^[0-9a-hjkmnp-tv-z]{12}$/);
    expect(new Set(rows.map((r) => r.wallet_number)).size).toBe(rows.length);
  });

  it('NEVER throws, even for a currency that does not exist', async () => {
    /*
     * `wallets.currency` is a foreign key onto `currencies.code`, so this is a
     * constraint violation rather than an empty result. The currency update that
     * triggers a backfill has already committed, so reporting it as failed would
     * invite an operator to re-enable something that is already enabled.
     */
    await expect(provisioning.openWalletForAllClients('ZZZ')).resolves.toBe(0);
  });
});

async function currenciesOf(userId: string): Promise<string[]> {
  const { rows } = await ctx.db.execute<{ currency: string }>(
    sql`SELECT currency FROM wallets WHERE user_id = ${userId} ORDER BY currency`,
  );
  return rows.map((r) => r.currency);
}
