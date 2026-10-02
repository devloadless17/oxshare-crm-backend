import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { TransfersService } from '../src/modules/payments/transfers.service';
import { TransferExecutor } from '../src/modules/payments/transfer-executor.service';
import type { Mt5BridgeClient } from '../src/modules/trading/mt5/mt5-bridge.client';
import { ExternalServiceError } from '../src/common/errors/domain-errors';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { CurrenciesService } from '../src/modules/currencies/currencies.service';
import { auditStubAs } from './audit-stub';
import { notificationsStub } from './notifications-stub';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * Three ways a transfer could move or release money twice (audit, 2 Oct 2026):
 *
 * 1. `fail` after `settle` — it neither locked the row nor conditioned its
 *    UPDATE, so an abandon racing a settling retry overwrote 'settled' and
 *    released the hold AGAIN, freeing another hold the client had.
 * 2. A bridge 5xx whose BODY echoed "400" was classed a refusal and released
 *    the hold while MT5 may have moved the money.
 * 3. A replayed admin deposit-to-account requested a second transfer; the
 *    `request_ref` key (0182) converges it on one.
 */
let ctx: MoneyTestContext;
let transfers: TransfersService;
let wallets: WalletService;

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  wallets = new WalletService(ctx.db);
  transfers = new TransfersService(
    wallets,
    new CurrenciesService(ctx.db, auditStubAs()),
    ctx.db,
    notificationsStub(),
  );
}, 120_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

beforeEach(async () => {
  await ctx.db.execute(sql`DELETE FROM transfers`);
  await ctx.db.execute(sql`TRUNCATE ledger_entries CASCADE`);
  await ctx.db.execute(sql`DELETE FROM trading_accounts`);
  await ctx.db.execute(sql`DELETE FROM wallets`);
  await ctx.db.execute(sql`DELETE FROM users`);
});

async function setup(email: string) {
  const { rows } = await ctx.db.execute<{ id: number }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name, verification_level, email_verified)
    VALUES (${email}, 'x', 'Test', 'Client', 1, true) RETURNING id
  `);
  const userId = rows[0].id;
  await wallets.post({
    userId,
    currency: 'USD',
    amount: '1000',
    entryType: 'deposit',
    referenceType: 'transaction',
    referenceId: `seed-${userId}`,
  });
  const acct = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO trading_accounts (user_id, environment, currency, balance, status, login)
    VALUES (${userId}, 'live', 'USD', '0', 'active', ${String(6_000_000 + userId)}) RETURNING id
  `);
  return { userId, accountId: acct.rows[0].id };
}

async function walletOf(userId: number) {
  const { rows } = await ctx.db.execute<{ balance: string; on_hold: string }>(
    sql`SELECT balance, on_hold FROM wallets WHERE user_id = ${userId} AND currency = 'USD'`,
  );
  return { balance: rows[0].balance, onHold: rows[0].on_hold };
}

const toAccount = (userId: number, accountId: string, amount: string, requestRef?: string) =>
  transfers.request({
    userId,
    tradingAccountId: accountId,
    direction: 'wallet_to_account',
    amount,
    currency: 'USD',
    requestRef,
  });

describe('fail cannot undo a settle', () => {
  it('refuses a settled transfer and leaves every other hold intact', async () => {
    const { userId, accountId } = await setup('race@test.local');
    const settled = await toAccount(userId, accountId, '250');
    const other = await toAccount(userId, accountId, '100'); // e.g. a pending withdrawal's hold
    await transfers.settle(settled.id, '250.00000000', new Date());

    await expect(transfers.fail(settled.id, 'abandoned')).rejects.toThrow(/settled/);

    expect((await transfers.findById(settled.id)).state).toBe('settled');
    const wallet = await walletOf(userId);
    expect(wallet.balance).toBe('750.00000000');
    expect(wallet.onHold, "the other transfer's hold was freed").toBe('100.00000000');
    expect((await transfers.findById(other.id)).state).toBe('pending');
  });

  it('concurrent settle and fail end in exactly one outcome', async () => {
    const { userId, accountId } = await setup('race2@test.local');
    const t = await toAccount(userId, accountId, '250');
    await Promise.allSettled([
      transfers.settle(t.id, '250.00000000', new Date()),
      transfers.fail(t.id, 'abandoned'),
    ]);
    const state = (await transfers.findById(t.id)).state;
    const wallet = await walletOf(userId);
    expect(wallet.onHold).toBe('0.00000000');
    expect(wallet.balance).toBe(state === 'settled' ? '750.00000000' : '1000.00000000');
  });
});

describe('a bridge refusal is its STATUS, not its text', () => {
  it('HOLDS on a 500 whose body echoes an amount of 400.00', async () => {
    const { userId, accountId } = await setup('body400@test.local');
    const t = await toAccount(userId, accountId, '400');
    const bridge = {
      isConfigured: true,
      getAccount: () => Promise.resolve({ balance: '0.00000000' }),
      balance: () =>
        Promise.reject(
          new ExternalServiceError(
            'MT5 bridge returned 500 for POST /balance: {"amount":400.00,"error":"boom"}',
            undefined,
            500,
          ),
        ),
    } as unknown as Mt5BridgeClient;
    await new TransferExecutor(ctx.db, transfers, bridge).execute(t.id);
    expect((await transfers.findById(t.id)).state).toBe('pending');
    expect((await walletOf(userId)).onHold).toBe('400.00000000');
  });
});

describe('a keyed transfer is made once', () => {
  it('a replay of the same request_ref returns the same transfer and holds once', async () => {
    const { userId, accountId } = await setup('replay@test.local');
    const [a, b] = await Promise.all([
      toAccount(userId, accountId, '250', 'admin-fund:key-1'),
      toAccount(userId, accountId, '250', 'admin-fund:key-1'),
    ]);
    const again = await toAccount(userId, accountId, '250', 'admin-fund:key-1');
    expect(b.id).toBe(a.id);
    expect(again.id).toBe(a.id);
    expect((await walletOf(userId)).onHold).toBe('250.00000000');
  });

  it('refuses the same key for a different amount', async () => {
    const { userId, accountId } = await setup('replay2@test.local');
    await toAccount(userId, accountId, '250', 'admin-fund:key-2');
    await expect(toAccount(userId, accountId, '300', 'admin-fund:key-2')).rejects.toThrow(
      /different transfer/,
    );
  });
});
