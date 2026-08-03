import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { sql } from 'drizzle-orm';
import { MoneyTestContext, startMoneyTestDb, stopMoneyTestDb } from './money-setup';
import { closeDb, getDb, resetDb } from '../src/database/db';
import { ledgerEntries, users, wallets } from '../src/database/schema';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { money } from '../src/modules/wallet/money';

// ARCHITECTURE §11 — the acceptance gate for the money path. These are not
// ordinary unit tests: each one encodes a rule from §6 that, if broken,
// silently pays the wrong party the wrong amount.
//
// Still to come with the commission engine: the fourth §11 test (two-level
// accrual), which needs ib_profiles/programs and the MT5 deal pipeline.

let ctx: MoneyTestContext;
let walletService: WalletService;

async function makeUser(email: string): Promise<string> {
  const [row] = await ctx.db
    .insert(users)
    .values({ email, passwordHash: 'x', firstName: 'Test', lastName: 'User' })
    .returning();
  return row.id;
}

beforeAll(async () => {
  resetDb();
  ctx = await startMoneyTestDb();
  resetDb(); // pick up the container's DATABASE_URL
  walletService = new WalletService(getDb());
});

afterAll(async () => {
  // Close the service's own pool before the container goes away, or pg logs
  // a wall of "terminating connection due to administrator command".
  await closeDb();
  if (ctx) await stopMoneyTestDb(ctx);
});

describe('§6.1 decimals, never floats', () => {
  it('holds precision at the eighth decimal place where a float would drift', async () => {
    const userId = await makeUser('precision@test.local');
    // 0.1 + 0.2 !== 0.3 in binary floating point. It must here.
    await walletService.post({
      userId,
      currency: 'USD',
      amount: '0.1',
      entryType: 'deposit',
      referenceType: 'test',
      referenceId: 'p1',
    });
    await walletService.post({
      userId,
      currency: 'USD',
      amount: '0.2',
      entryType: 'deposit',
      referenceType: 'test',
      referenceId: 'p2',
    });
    const [wallet] = await walletService.listWallets(userId);
    expect(wallet.balance).toBe('0.30000000');

    // And at the far end of NUMERIC(28,8)'s scale.
    await walletService.post({
      userId,
      currency: 'USD',
      amount: '0.00000001',
      entryType: 'deposit',
      referenceType: 'test',
      referenceId: 'p3',
    });
    const [after] = await walletService.listWallets(userId);
    expect(after.balance).toBe('0.30000001');
  });

  it('serializes every monetary value as a string across the boundary', async () => {
    const userId = await makeUser('strings@test.local');
    const { entry } = await walletService.post({
      userId,
      currency: 'USD',
      amount: '12.5',
      entryType: 'deposit',
      referenceType: 'test',
      referenceId: 's1',
    });
    expect(typeof entry.amount).toBe('string');
    expect(typeof entry.balanceAfter).toBe('string');
    const [wallet] = await walletService.listWallets(userId);
    expect(typeof wallet.balance).toBe('string');
    expect(typeof wallet.available).toBe('string');
  });
});

describe('§11 reconciliation — ledger sum equals balance, to the cent', () => {
  it('balances after a mixed fixture of credits and debits', async () => {
    const userId = await makeUser('reconcile@test.local');
    const movements = [
      '100.00000000',
      '250.55000000',
      '-75.25000000',
      '0.00000001',
      '-0.00000001',
      '999.99999999',
    ];
    for (const [i, amount] of movements.entries()) {
      await walletService.post({
        userId,
        currency: 'USD',
        amount,
        entryType: new Decimal(amount).isNegative() ? 'withdrawal' : 'deposit',
        referenceType: 'fixture',
        referenceId: `r${i}`,
      });
    }

    const [wallet] = await walletService.listWallets(userId);
    const result = await walletService.reconcile(wallet.id);

    const expected = movements.reduce((acc, m) => acc.plus(m), new Decimal(0));
    expect(result.balance).toBe(money(expected));
    expect(result.ledgerSum).toBe(result.balance);
    expect(result.balanced).toBe(true);
  });

  it('every wallet in the database reconciles (the CI invariant)', async () => {
    const allWallets = await ctx.db.select().from(wallets);
    expect(allWallets.length).toBeGreaterThan(0);
    for (const w of allWallets) {
      const result = await walletService.reconcile(w.id);
      expect(
        result.balanced,
        `wallet ${w.id} drifted: balance ${result.balance} vs ledger ${result.ledgerSum}`,
      ).toBe(true);
    }
  });
});

describe('§11 idempotency — the same cause delivered twice', () => {
  it('credits once when a payment callback is replayed', async () => {
    const userId = await makeUser('idem-callback@test.local');
    const callback = {
      userId,
      currency: 'USD' as const,
      amount: '500.00',
      entryType: 'deposit' as const,
      referenceType: 'provider_callback',
      referenceId: 'whish-ref-123',
    };

    const first = await walletService.post(callback);
    const second = await walletService.post(callback);

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.entry.id).toBe(first.entry.id);

    const [wallet] = await walletService.listWallets(userId);
    expect(wallet.balance).toBe('500.00000000');

    const entries = await ctx.db
      .select()
      .from(ledgerEntries)
      .where(sql`${ledgerEntries.walletId} = ${wallet.id}`);
    expect(entries).toHaveLength(1);
  });

  it('stays balanced when a payout confirmation is replayed', async () => {
    const userId = await makeUser('idem-payout@test.local');
    await walletService.post({
      userId,
      currency: 'USD',
      amount: '1000',
      entryType: 'deposit',
      referenceType: 'seed',
      referenceId: 'i2-seed',
    });
    const payout = {
      userId,
      currency: 'USD' as const,
      amount: '-250',
      entryType: 'payout' as const,
      referenceType: 'payout',
      referenceId: 'payout-abc',
    };

    await walletService.post(payout);
    const balanceAfterFirst = (await walletService.listWallets(userId))[0].balance;
    await walletService.post(payout);
    const balanceAfterSecond = (await walletService.listWallets(userId))[0].balance;

    expect(balanceAfterFirst).toBe('750.00000000');
    expect(balanceAfterSecond).toBe(balanceAfterFirst);
  });
});

describe('§11 concurrency — no lost update under simultaneous credits', () => {
  it('applies all 50 concurrent credits exactly once against real Postgres', async () => {
    const userId = await makeUser('concurrency@test.local');
    const CREDITS = 50;
    const EACH = '10.00000000';

    // Fired together: without SELECT ... FOR UPDATE these read the same prior
    // balance and writes are lost — the bug §6.2 exists to prevent.
    await Promise.all(
      Array.from({ length: CREDITS }, (_, i) =>
        walletService.post({
          userId,
          currency: 'USD',
          amount: EACH,
          entryType: 'commission',
          referenceType: 'concurrent',
          referenceId: `c${i}`,
        }),
      ),
    );

    const [wallet] = await walletService.listWallets(userId);
    expect(wallet.balance).toBe(money(new Decimal(EACH).times(CREDITS)));

    const result = await walletService.reconcile(wallet.id);
    expect(result.balanced).toBe(true);

    // Every entry recorded a distinct running balance — proof the lock held.
    const entries = await ctx.db
      .select()
      .from(ledgerEntries)
      .where(sql`${ledgerEntries.walletId} = ${wallet.id}`);
    expect(entries).toHaveLength(CREDITS);
    expect(new Set(entries.map((e) => e.balanceAfter)).size).toBe(CREDITS);
  });
});

describe('§6.4 the ledger is append-only', () => {
  it('refuses UPDATE and DELETE at the database level', async () => {
    const userId = await makeUser('append-only@test.local');
    await walletService.post({
      userId,
      currency: 'USD',
      amount: '42',
      entryType: 'deposit',
      referenceType: 'test',
      referenceId: 'ao1',
    });

    await expect(ctx.db.execute(sql`UPDATE ledger_entries SET amount = '999'`)).rejects.toThrow(
      /append-only/,
    );
    await expect(ctx.db.execute(sql`DELETE FROM ledger_entries`)).rejects.toThrow(/append-only/);
  });
});

describe('§8.4 holds gate withdrawable funds', () => {
  it('reserves against available balance and never overdraws', async () => {
    const userId = await makeUser('holds@test.local');
    await walletService.post({
      userId,
      currency: 'USD',
      amount: '300',
      entryType: 'deposit',
      referenceType: 'seed',
      referenceId: 'h-seed',
    });

    await walletService.hold(userId, 'USD', '120');
    const [held] = await walletService.listWallets(userId);
    expect(held.balance).toBe('300.00000000'); // a hold is not a balance change
    expect(held.onHold).toBe('120.00000000');
    expect(held.available).toBe('180.00000000');

    await expect(walletService.hold(userId, 'USD', '200')).rejects.toThrow(
      /Insufficient available balance/,
    );

    await walletService.release(userId, 'USD', '120');
    const [released] = await walletService.listWallets(userId);
    expect(released.onHold).toBe('0.00000000');
    expect(released.available).toBe('300.00000000');
  });

  it('rejects a debit that would overdraw the wallet', async () => {
    const userId = await makeUser('overdraft@test.local');
    await walletService.post({
      userId,
      currency: 'USD',
      amount: '50',
      entryType: 'deposit',
      referenceType: 'seed',
      referenceId: 'o-seed',
    });
    await expect(
      walletService.post({
        userId,
        currency: 'USD',
        amount: '-51',
        entryType: 'withdrawal',
        referenceType: 'test',
        referenceId: 'o1',
      }),
    ).rejects.toThrow(/Insufficient balance/);
  });
});
