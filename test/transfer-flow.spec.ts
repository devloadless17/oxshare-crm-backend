import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { TransfersService } from '../src/modules/payments/transfers.service';
import { TransferExecutor } from '../src/modules/payments/transfer-executor.service';
import type { Mt5BridgeClient } from '../src/modules/trading/mt5/mt5-bridge.client';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { CurrenciesService } from '../src/modules/currencies/currencies.service';
import { auditStubAs } from './audit-stub';
import { notificationsStubAs } from './notifications-stub';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * Moving money between a wallet and a trading account.
 *
 * The CRM owns the WALLET balance. `trading_accounts.balance` is a mirror of
 * MT5 (0081) and the CRM never computes it — settle writes the figure MT5
 * reported, or leaves the column alone. So the account-leg tests here pass an
 * MT5 balance the way the executor does, and the one that passes none asserts
 * the mirror is left untouched rather than guessed at.
 *
 * The account leg is still the leg with no ON CONFLICT behind it, protected
 * only by the row lock and the state check.
 */
let ctx: MoneyTestContext;
let transfers: TransfersService;
let wallets: WalletService;

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  wallets = new WalletService(ctx.db);
  // (wallets, currencies, db, notifications) — the order the constructor
  // declares. The notification port is stubbed: `settle` rings the client's
  // bell, and whether that row actually lands is asserted against real data in
  // `notifications-hooks.spec.ts` rather than here.
  transfers = new TransfersService(
    wallets,
    new CurrenciesService(ctx.db, auditStubAs()),
    ctx.db,
    notificationsStubAs(),
  );
}, 120_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

async function makeClient(email: string, balance = '1000'): Promise<string> {
  const { rows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name, verification_level, email_verified)
    VALUES (${email}, 'x', 'Test', 'Client', 1, true)
    RETURNING id
  `);
  const userId = rows[0].id;
  await wallets.post({
    userId,
    currency: 'USD',
    amount: balance,
    entryType: 'deposit',
    referenceType: 'transaction',
    referenceId: `seed-${userId}`,
  });
  return userId;
}

async function makeAccount(
  userId: string,
  options: { environment?: string; currency?: string; balance?: string; status?: string } = {},
): Promise<string> {
  const { environment = 'live', currency = 'USD', balance = '0', status = 'active' } = options;
  const { rows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO trading_accounts (user_id, environment, currency, balance, status)
    VALUES (${userId}, ${environment}::trading_environment, ${currency}, ${balance},
            ${status}::trading_account_status)
    RETURNING id
  `);
  return rows[0].id;
}

async function walletOf(userId: string): Promise<{ balance: string; onHold: string }> {
  const { rows } = await ctx.db.execute<{ balance: string; on_hold: string }>(
    sql`SELECT balance, on_hold FROM wallets WHERE user_id = ${userId} AND currency = 'USD'`,
  );
  return { balance: rows[0].balance, onHold: rows[0].on_hold };
}

async function accountBalance(accountId: string): Promise<string> {
  const { rows } = await ctx.db.execute<{ balance: string }>(
    sql`SELECT balance FROM trading_accounts WHERE id = ${accountId}`,
  );
  return rows[0].balance;
}

beforeEach(async () => {
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

describe('wallet → account', () => {
  it('holds on request without changing either balance', async () => {
    const userId = await makeClient('hold@test.local');
    const accountId = await makeAccount(userId);

    await transfers.request({
      userId,
      tradingAccountId: accountId,
      direction: 'wallet_to_account',
      amount: '250',
      currency: 'USD',
    });

    /*
     * A hold is not a balance change. The money is committed but not yet moved,
     * because the counterparty — a bridge, eventually — can still refuse.
     */
    const wallet = await walletOf(userId);
    expect(wallet.balance).toBe('1000.00000000');
    expect(wallet.onHold).toBe('250.00000000');
    expect(await accountBalance(accountId)).toBe('0.00000000');
  });

  it('moves BOTH legs on settle', async () => {
    const userId = await makeClient('both-legs@test.local');
    const accountId = await makeAccount(userId);
    const transfer = await transfers.request({
      userId,
      tradingAccountId: accountId,
      direction: 'wallet_to_account',
      amount: '250',
      currency: 'USD',
    });

    // What the executor passes: MT5's own reading, taken after it moved the
    // money, and the moment it was asked.
    await transfers.settle(transfer.id, '250.00000000', new Date());

    /*
     * The hold becomes a debit, and the mirror carries MT5's figure — not the
     * CRM's arithmetic, which happens to agree here and would not on any account
     * that also pays swap or commission between the two reads.
     */
    const wallet = await walletOf(userId);
    expect(wallet.balance).toBe('750.00000000');
    expect(wallet.onHold).toBe('0.00000000');
    expect(await accountBalance(accountId)).toBe('250.00000000');
  });

  it('refuses more than the wallet holds', async () => {
    const userId = await makeClient('too-much@test.local', '100');
    const accountId = await makeAccount(userId);

    await expect(
      transfers.request({
        userId,
        tradingAccountId: accountId,
        direction: 'wallet_to_account',
        amount: '200',
        currency: 'USD',
      }),
    ).rejects.toThrow(/insufficient available/i);
  });

  it('returns everything on failure', async () => {
    const userId = await makeClient('failed@test.local');
    const accountId = await makeAccount(userId);
    const transfer = await transfers.request({
      userId,
      tradingAccountId: accountId,
      direction: 'wallet_to_account',
      amount: '250',
      currency: 'USD',
    });

    await transfers.fail(transfer.id, 'Bridge refused');

    // Exactly the position before the request, which is what makes a failed
    // transfer safe for the client to simply retry.
    const wallet = await walletOf(userId);
    expect(wallet.balance).toBe('1000.00000000');
    expect(wallet.onHold).toBe('0.00000000');
    expect(await accountBalance(accountId)).toBe('0.00000000');
  });
});

describe('account → wallet', () => {
  it('credits nothing on request', async () => {
    const userId = await makeClient('inbound@test.local');
    const accountId = await makeAccount(userId, { balance: '500' });

    await transfers.request({
      userId,
      tradingAccountId: accountId,
      direction: 'account_to_wallet',
      amount: '200',
      currency: 'USD',
    });

    /*
     * Money the CRM has not received is money the CRM must not show. The wallet
     * moves only when the other side confirms its own debit.
     */
    expect((await walletOf(userId)).balance).toBe('1000.00000000');
    expect(await accountBalance(accountId)).toBe('500.00000000');
  });

  it('moves both legs on settle', async () => {
    const userId = await makeClient('inbound-settle@test.local');
    const accountId = await makeAccount(userId, { balance: '500' });
    const transfer = await transfers.request({
      userId,
      tradingAccountId: accountId,
      direction: 'account_to_wallet',
      amount: '200',
      currency: 'USD',
    });

    await transfers.settle(transfer.id, '300.00000000', new Date());

    expect((await walletOf(userId)).balance).toBe('1200.00000000');
    expect(await accountBalance(accountId)).toBe('300.00000000');
  });

  it('refuses to overdraw the trading account AT REQUEST, before anything moves', async () => {
    const userId = await makeClient('acct-overdraw@test.local');
    const accountId = await makeAccount(userId, { balance: '50' });

    /*
     * ── WHERE THIS REFUSAL LIVES IS THE WHOLE POINT ────────────────────────
     *
     * It used to live in `settle`, as a `>= 0` guard on a computed mirror. That
     * guard could only ever fire AFTER MT5 had moved the money — `settle` is
     * reachable only through a bridge call that already succeeded — so it never
     * caught an overdraw at all. MT5 checks the real balance first and refuses
     * its own; what the guard actually caught was a MIRROR gone stale, and it
     * charged the client for it by rolling back their wallet credit and leaving
     * the money in neither place.
     *
     * Here it costs nothing: no money has moved, and the client gets a sentence
     * naming their balance instead of a transfer stuck `pending`.
     */
    await expect(
      transfers.request({
        userId,
        tradingAccountId: accountId,
        direction: 'account_to_wallet',
        amount: '200',
        currency: 'USD',
      }),
    ).rejects.toThrow(/holds 50\.00000000 USD/i);

    // Nothing was created, so there is nothing to settle or clean up later.
    const { rows } = await ctx.db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM transfers WHERE trading_account_id = ${accountId}`,
    );
    expect(rows[0].count).toBe('0');
    expect(await accountBalance(accountId)).toBe('50.00000000');
  });

  it('counts transfers already in flight against the balance', async () => {
    /*
     * A check that reads only the column is defeated by clicking twice: two
     * pending withdrawals of 40 against an account holding 60 would both pass,
     * and MT5 would refuse the second with a message the client cannot act on.
     */
    const userId = await makeClient('acct-inflight@test.local');
    const accountId = await makeAccount(userId, { balance: '60' });

    await transfers.request({
      userId,
      tradingAccountId: accountId,
      direction: 'account_to_wallet',
      amount: '40',
      currency: 'USD',
    });

    await expect(
      transfers.request({
        userId,
        tradingAccountId: accountId,
        direction: 'account_to_wallet',
        amount: '40',
        currency: 'USD',
      }),
    ).rejects.toThrow(/already committed to a transfer in progress/i);
  });

  it('SETTLES even when MT5 cannot be read back, and pages nobody', async () => {
    /*
     * ── THE CASE THAT USED TO STRAND A CLIENT'S MONEY ──────────────────────
     *
     * MT5 moved the money and the follow-up balance read failed. The old code
     * computed `balance - amount` against a stale-low mirror, hit the `>= 0`
     * guard, threw, and rolled back the wallet credit — so the money had left
     * the trading account and arrived nowhere, with the transfer sitting in the
     * one state nothing distinguishes from normal.
     *
     * Now the settlement stands. The mirror is simply not written, because 0081
     * says nothing here computes this column and there is no honest figure to
     * put in it; the next snapshot repairs it. A stale mirror is a mirror doing
     * what mirrors do, and it is not worth a phone call.
     */
    const userId = await makeClient('acct-unreadable@test.local');
    const accountId = await makeAccount(userId, { balance: '50' });
    const transfer = await transfers.request({
      userId,
      tradingAccountId: accountId,
      direction: 'account_to_wallet',
      amount: '40',
      currency: 'USD',
    });

    const raised: Record<string, unknown>[] = [];
    const spy = vi.spyOn(Logger.prototype, 'error').mockImplementation((arg: unknown) => {
      if (typeof arg === 'object' && arg !== null && 'alert' in arg) {
        raised.push(arg);
      }
    });

    try {
      // No figure and no read time — exactly what the executor passes when the
      // bridge moved the money but could not read the account back.
      await transfers.settle(transfer.id);
    } finally {
      spy.mockRestore();
    }

    // The client is paid.
    expect((await walletOf(userId)).balance).toBe('1040.00000000');

    // The mirror keeps its previous figure AND its real age — it does not claim
    // to have been confirmed by this settlement.
    expect(await accountBalance(accountId)).toBe('50.00000000');
    const { rows } = await ctx.db.execute<{ balance_synced_at: string | null }>(
      sql`SELECT balance_synced_at FROM trading_accounts WHERE id = ${accountId}`,
    );
    expect(rows[0].balance_synced_at).toBeNull();

    // Nothing stuck, so nothing to wake anybody for.
    expect(raised).toHaveLength(0);
  });
});

describe('what a transfer refuses', () => {
  it('refuses a DEMO account', async () => {
    const userId = await makeClient('demo@test.local');
    const accountId = await makeAccount(userId, { environment: 'demo' });

    // Funding a demo account destroys real client funds in exchange for
    // practice money. There is no meaningful "are you sure".
    await expect(
      transfers.request({
        userId,
        tradingAccountId: accountId,
        direction: 'wallet_to_account',
        amount: '10',
        currency: 'USD',
      }),
    ).rejects.toThrow(/demo/i);
  });

  it('refuses a SUSPENDED account', async () => {
    const userId = await makeClient('suspended@test.local');
    const accountId = await makeAccount(userId, { status: 'suspended' });

    await expect(
      transfers.request({
        userId,
        tradingAccountId: accountId,
        direction: 'wallet_to_account',
        amount: '10',
        currency: 'USD',
      }),
    ).rejects.toThrow(/suspended/i);
  });

  it('refuses a currency mismatch rather than inventing a rate', async () => {
    const userId = await makeClient('fx@test.local');
    const accountId = await makeAccount(userId, { currency: 'USDT' });

    /*
     * There is no FX rate source anywhere in this system, so the alternatives
     * are inventing one or moving the number across unchanged and calling 100
     * USD "100 USDT". Both are wrong in a way that only shows on a statement.
     */
    await expect(
      transfers.request({
        userId,
        tradingAccountId: accountId,
        direction: 'wallet_to_account',
        amount: '10',
        currency: 'USD',
      }),
    ).rejects.toThrow(/do not convert/i);
  });

  it("refuses somebody else's trading account", async () => {
    const owner = await makeClient('owner@test.local');
    const stranger = await makeClient('stranger@test.local');
    const accountId = await makeAccount(owner);

    /*
     * `userId` is in the WHERE clause, so not-found and not-yours are the same
     * answer — an equality check after the fetch is one refactor away from
     * being dropped, and the consequence is funding a stranger's account.
     */
    await expect(
      transfers.request({
        userId: stranger,
        tradingAccountId: accountId,
        direction: 'wallet_to_account',
        amount: '10',
        currency: 'USD',
      }),
    ).rejects.toThrow(/not found/i);
  });

  it('refuses an unverified client', async () => {
    const { rows } = await ctx.db.execute<{ id: string }>(sql`
      INSERT INTO users (email, password_hash, first_name, last_name, verification_level)
      VALUES ('unverified-tx@test.local', 'x', 'Test', 'Client', 0)
      RETURNING id
    `);
    const userId = rows[0].id;
    const accountId = await makeAccount(userId);

    await expect(
      transfers.request({
        userId,
        tradingAccountId: accountId,
        direction: 'wallet_to_account',
        amount: '10',
        currency: 'USD',
      }),
    ).rejects.toThrow(/verified/i);
  });
});

describe('settling twice', () => {
  it('moves the money once', async () => {
    const userId = await makeClient('replay-settle@test.local');
    const accountId = await makeAccount(userId);
    const transfer = await transfers.request({
      userId,
      tradingAccountId: accountId,
      direction: 'wallet_to_account',
      amount: '100',
      currency: 'USD',
    });

    await transfers.settle(transfer.id, '100.00000000', new Date());
    // The second is refused on state — the wallet leg would be absorbed as a
    // replay anyway, but the ACCOUNT leg has no such guard, which is why the
    // state check and the row lock matter here.
    await expect(transfers.settle(transfer.id, '100.00000000', new Date())).rejects.toThrow(
      /pending/i,
    );

    expect((await walletOf(userId)).balance).toBe('900.00000000');
    expect(await accountBalance(accountId)).toBe('100.00000000');
  });
});

/**
 * ── THE MIRROR IS STAMPED WITH MT5'S READ TIME, NOT THE SETTLEMENT'S ──────
 *
 * `trading_accounts.balance` mirrors MT5 (0081) and has three writers: the
 * bridge's sweep, the balance-operation path, and this one. The other two stamp
 * `balance_synced_at` with the moment MT5 was ASKED, and refuse to move a
 * figure that was read more recently than their own.
 *
 * This path stamped "now" and compared nothing, so it could overwrite a fresher
 * reading with an older figure AND mark it as the newest — which is worse than
 * being stale, because every other writer then trusts a timestamp that is not a
 * read time. The window is narrow and the sweep repairs it within the hour,
 * which is exactly why it would never be spotted from a balance alone.
 */
describe('the transfer mirror respects read times', () => {
  it('does not overwrite a balance MT5 reported more recently', async () => {
    const userId = await makeClient('mirror-stale@test.local');
    const accountId = await makeAccount(userId, { balance: '500' });
    const transfer = await transfers.request({
      userId,
      tradingAccountId: accountId,
      direction: 'wallet_to_account',
      amount: '100',
      currency: 'USD',
    });

    // The sweep already wrote a NEWER reading than the one this settle carries.
    const sweepReadAt = new Date();
    await ctx.db.execute(sql`
      UPDATE trading_accounts
         SET balance = '999.00000000', balance_synced_at = ${sweepReadAt.toISOString()}
       WHERE id = ${accountId}
    `);

    // The executor's read happened a minute BEFORE that sweep.
    const staleReadAt = new Date(sweepReadAt.getTime() - 60_000);
    await transfers.settle(transfer.id, '600.00000000', staleReadAt);

    // The newer figure stands. The wallet leg still settled — a skipped mirror
    // write is success, not a reason to undo money that has already moved.
    expect(await accountBalance(accountId)).toBe('999.00000000');
    const wallet = await walletOf(userId);
    expect(wallet.balance).toBe('900.00000000');
    expect(wallet.onHold).toBe('0.00000000');
  });

  it('writes MT5s figure when its read is the freshest thing we hold', async () => {
    const userId = await makeClient('mirror-fresh@test.local');
    const accountId = await makeAccount(userId, { balance: '500' });
    const transfer = await transfers.request({
      userId,
      tradingAccountId: accountId,
      direction: 'wallet_to_account',
      amount: '100',
      currency: 'USD',
    });

    const olderSweep = new Date(Date.now() - 120_000);
    await ctx.db.execute(sql`
      UPDATE trading_accounts
         SET balance = '500.00000000', balance_synced_at = ${olderSweep.toISOString()}
       WHERE id = ${accountId}
    `);

    await transfers.settle(transfer.id, '600.00000000', new Date());

    expect(await accountBalance(accountId)).toBe('600.00000000');
  });

  it('stamps the READ time, so a later sweep of an earlier read cannot win', async () => {
    /*
     * The half that makes the guard mean anything. If this stamped the
     * settlement time instead, a sweep whose read predates the transfer would
     * compare against a timestamp from the future and lose — correctly, by
     * accident — while a sweep read AFTER the transfer would also lose, which
     * is the data loss.
     */
    const userId = await makeClient('mirror-stamp@test.local');
    const accountId = await makeAccount(userId, { balance: '500' });
    const transfer = await transfers.request({
      userId,
      tradingAccountId: accountId,
      direction: 'wallet_to_account',
      amount: '100',
      currency: 'USD',
    });

    const readAt = new Date(Date.now() - 90_000);
    await transfers.settle(transfer.id, '600.00000000', readAt);

    const { rows } = await ctx.db.execute<{ balance_synced_at: string }>(
      sql`SELECT balance_synced_at FROM trading_accounts WHERE id = ${accountId}`,
    );
    // Within a second of the READ, not of the settlement a minute and a half later.
    expect(Math.abs(new Date(rows[0].balance_synced_at).getTime() - readAt.getTime())).toBeLessThan(
      1000,
    );
  });
});

/**
 * THE PRECONDITION THE RESUME PATH RESTS ON, AND NOTHING TESTED IT.
 *
 * `transfer-resume.scheduler.ts` re-runs `TransferExecutor.execute` on
 * transfers left PENDING — a bridge restart, a lost response — every minute,
 * for ever, until one succeeds. Its class note states the precondition in terms
 * that leave no doubt:
 *
 *   "The idempotency key is the TRANSFER ID, not a fresh UUID per attempt. That
 *    is the whole reason a retry is allowed … Retrying without that stable key
 *    would be the single worst thing this file could do. It is not a detail of
 *    the implementation; it is the precondition."
 *
 * It is correct today — `idempotencyKey: transfer.id`, one line, with a comment
 * pointing at that note. **And no test attempted it.** The resume scheduler has
 * NO spec at all, and `execute` was reached by nothing here: this file covered
 * `TransfersService.request`/`settle` and never the executor that drives them.
 *
 * So a refactor to `uuidv4()` — which reads like an improvement, since a fresh
 * key per call is what idempotency keys usually are — would pass every test in
 * this repository while making the retry loop move a client's money on MT5
 * once per minute until somebody noticed. The CRM leg would stay correct
 * (`settle` refuses a non-pending transfer), which is what makes it so quiet:
 * the wallet reads right and the trading account drifts.
 *
 * This is the same shape as the append-only trigger that was absent for a month
 * behind a test that only INSERTed and counted, and as `@Audited` decorators
 * with no interceptor: a guarantee written down, believed, and unattempted.
 */
describe('a zero transfer is refused by the AMOUNT, not by the ledger', () => {
  /*
   * `!amount.isPositive()` never fired for zero: decimal.js reads the SIGN and
   * gives zero a sign of 1, so `new Decimal(0).isPositive()` is TRUE. The guard
   * read perfectly and was a no-op for the one input it exists to reject.
   *
   * The end state was never wrong — `WalletService.post` refuses a zero
   * movement — so this is a wrong-error-LATE defect rather than a wrong-money
   * one. What it cost is WHERE the refusal comes from: the ledger, naming a
   * concept the client never typed, instead of the amount they did.
   * `ib-wallet.service.ts` records the same thing happening to it.
   */
  it('refuses 0 at the door, naming the amount', async () => {
    const userId = await makeClient('zero-transfer@test.local');
    const accountId = await makeAccount(userId);
    await expect(
      transfers.request({
        userId,
        tradingAccountId: accountId,
        direction: 'wallet_to_account',
        amount: '0',
        currency: 'USD',
      }),
    ).rejects.toThrow(/Transfer amount must be positive/);
  });

  it('refuses a NEGATIVE transfer too, which the same guard did catch', async () => {
    const userId = await makeClient('neg-transfer@test.local');
    const accountId = await makeAccount(userId);
    await expect(
      transfers.request({
        userId,
        tradingAccountId: accountId,
        direction: 'wallet_to_account',
        amount: '-50',
        currency: 'USD',
      }),
    ).rejects.toThrow(/Transfer amount must be positive/);
  });
});

describe('the resume precondition: one transfer, one idempotency key', () => {
  /** Records what the bridge was asked, and replays a key it has already seen. */
  function recordingBridge() {
    const seen = new Map<string, string>();
    const keys: string[] = [];
    let moves = 0;
    const bridge = {
      isConfigured: true,
      // The read-back `execute` does after moving the money, so `settle` can
      // write MT5's own figure rather than the CRM's arithmetic (0081).
      getAccount: () => Promise.resolve({ balance: '250.00000000' }),
      balance: (input: { idempotencyKey: string }) => {
        keys.push(input.idempotencyKey);
        const already = seen.get(input.idempotencyKey);
        if (already) return Promise.resolve({ dealId: already, replayed: true });
        // A key the bridge has not seen is a NEW movement of real money.
        moves += 1;
        const dealId = `deal-${seen.size + 1}`;
        seen.set(input.idempotencyKey, dealId);
        return Promise.resolve({ dealId, replayed: false });
      },
    };
    return { bridge, keys, movesMade: () => moves };
  }

  it('passes the SAME key on a retry, so a resumed transfer moves money once', async () => {
    const { bridge, keys, movesMade } = recordingBridge();
    const executor = new TransferExecutor(ctx.db, transfers, bridge as unknown as Mt5BridgeClient);

    const userId = await makeClient('resume-key@test.local');
    const accountId = await makeAccount(userId);
    /*
     * An MT5 LOGIN, which `makeAccount` does not set — and the executor FAILS a
     * transfer whose account has none, before it ever reaches the bridge. That
     * is correct behaviour (holding a client's funds against an account that
     * cannot receive them is worse than returning them), and it is also why
     * every account in this file has been invisible to the executor: the helper
     * was written for `TransfersService`, which never looks at the login.
     */
    await ctx.db.execute(sql`UPDATE trading_accounts SET login = 5000001 WHERE id = ${accountId}`);
    const transfer = await transfers.request({
      userId,
      tradingAccountId: accountId,
      direction: 'wallet_to_account',
      amount: '250',
      currency: 'USD',
    });

    // Twice, exactly as the scheduler does when the first attempt is left
    // pending — the second is a RESUME, not a new instruction.
    await executor.execute(transfer.id);
    await executor.execute(transfer.id);

    /*
     * THE ASSERTION THE WHOLE BLOCK EXISTS FOR. Not "it was called twice" —
     * that is true either way — but that both calls named the SAME movement.
     */
    expect(keys.length, 'the executor did not reach the bridge').toBeGreaterThanOrEqual(1);
    expect(new Set(keys).size, `two different keys: ${keys.join(', ')}`).toBe(1);
    expect(keys[0], 'the key must be the TRANSFER ID, which is what makes it stable').toBe(
      transfer.id,
    );

    // And the consequence, stated in money rather than in keys: the bridge
    // recognised the second call as the same movement, so MT5 moved once.
    expect(movesMade(), 'MT5 was asked to move money more than once').toBe(1);
  });
});
