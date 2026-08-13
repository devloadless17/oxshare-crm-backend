import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { TransfersService } from '../src/modules/payments/transfers.service';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { CurrenciesService } from '../src/modules/currencies/currencies.service';
import { auditStubAs } from './audit-stub';
import { notificationsStubAs } from './notifications-stub';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * Moving money between a wallet and a trading account.
 *
 * The CRM owns both balances today, because there is no MT5 bridge — see the
 * `trading_accounts.balance` schema comment, which records that this reverses a
 * deliberate decision. So a transfer has to move both sides, and several tests
 * here check the account leg specifically: it is the leg with no ON CONFLICT
 * behind it, protected only by the row lock and the state check.
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
  await ctx.db.execute(sql`DELETE FROM ledger_entries`);
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

    await transfers.settle(transfer.id);

    /*
     * The account leg is what the restored version did not do, because MT5
     * owned that number. Without it a transfer takes money out of a client's
     * wallet and puts it nowhere.
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

    await transfers.settle(transfer.id);

    expect((await walletOf(userId)).balance).toBe('1200.00000000');
    expect(await accountBalance(accountId)).toBe('300.00000000');
  });

  it('refuses to overdraw the trading account', async () => {
    const userId = await makeClient('acct-overdraw@test.local');
    const accountId = await makeAccount(userId, { balance: '50' });
    const transfer = await transfers.request({
      userId,
      tradingAccountId: accountId,
      direction: 'account_to_wallet',
      amount: '200',
      currency: 'USD',
    });

    /*
     * `trading_accounts_balance_non_negative` is what refuses this, not a
     * read-modify-write in the service — the balance is decremented in SQL, so
     * a stale read cannot slip past.
     */
    await expect(transfers.settle(transfer.id)).rejects.toThrow();
    expect(await accountBalance(accountId)).toBe('50.00000000');
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

    await transfers.settle(transfer.id);
    // The second is refused on state — the wallet leg would be absorbed as a
    // replay anyway, but the ACCOUNT leg has no such guard, which is why the
    // state check and the row lock matter here.
    await expect(transfers.settle(transfer.id)).rejects.toThrow(/pending/i);

    expect((await walletOf(userId)).balance).toBe('900.00000000');
    expect(await accountBalance(accountId)).toBe('100.00000000');
  });
});
