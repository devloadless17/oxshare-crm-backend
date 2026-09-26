import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { CurrenciesService } from '../src/modules/currencies/currencies.service';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { WalletProvisioningService } from '../src/modules/wallet/wallet-provisioning.service';
import { WalletsStore } from '../src/store/wallets.store';
import { ConflictError } from '../src/common/errors/domain-errors';
import { auditStubAs, TEST_ACTOR } from './audit-stub';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * A currency that goes live opens its wallets (owner, 26 Sep 2026).
 *
 * Adding an enabled currency — or enabling one — gives every client a wallet in
 * it and every partner a commission wallet, after the save and without holding
 * the request. Deleting a currency that never held money takes those empty
 * wallets with it; one that has seen money is refused and nothing is deleted.
 * A disabled currency's empty wallets drop off the client's screens; funded ones
 * stay, because the money is the client's.
 */
let ctx: MoneyTestContext;
let currencies: CurrenciesService;
let walletService: WalletService;
let clientA: string;
let clientB: string;
let partner: string;

async function user(email: string): Promise<string> {
  const { rows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name)
    VALUES (${email}, 'x', 'Wallet', 'Holder') RETURNING id
  `);
  return rows[0].id;
}

async function makePartner(userId: string, code: string): Promise<void> {
  await ctx.db.execute(sql`
    INSERT INTO ib_accounts (user_id, referral_code, program_id)
    VALUES (${userId}, ${code}, (SELECT id FROM ib_programs ORDER BY sort_order, name LIMIT 1))
  `);
}

/** The kinds of wallet one user holds in one currency. */
async function kindsOf(userId: string, currency: string): Promise<string[]> {
  const { rows } = await ctx.db.execute<{ kind: string }>(sql`
    SELECT kind::text AS kind FROM wallets
     WHERE user_id = ${userId} AND currency = ${currency} ORDER BY kind
  `);
  return rows.map((row) => row.kind);
}

async function walletCount(currency: string): Promise<number> {
  const { rows } = await ctx.db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM wallets WHERE currency = ${currency}`,
  );
  return rows[0].n;
}

async function currencyExists(code: string): Promise<boolean> {
  const { rows } = await ctx.db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM currencies WHERE code = ${code}`,
  );
  return rows[0].n === 1;
}

const add = (code: string, enabled = true) =>
  currencies.create({ code, name: `Test ${code}`, symbol: code, decimals: 2, enabled }, TEST_ACTOR);

/** Provisioning runs after the save and is not awaited by it — wait for it here. */
const opened = (userId: string, currency: string) =>
  vi.waitFor(async () => expect(await kindsOf(userId, currency)).toContain('main'), {
    timeout: 5_000,
  });

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  currencies = new CurrenciesService(ctx.db, auditStubAs(), new WalletsStore(ctx.db));
  walletService = new WalletService(ctx.db);
  clientA = await user('currency-wallets-a@oxshare-e2e.test');
  clientB = await user('currency-wallets-b@oxshare-e2e.test');
  partner = await user('currency-wallets-partner@oxshare-e2e.test');
  await makePartner(partner, 'CURWAL1');
}, 180_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

describe('a currency that goes live', () => {
  it('opens a wallet for every client and a commission wallet for every partner', async () => {
    await add('TWA');
    await opened(clientA, 'TWA');

    expect(await kindsOf(clientA, 'TWA')).toEqual(['main']);
    expect(await kindsOf(clientB, 'TWA')).toEqual(['main']);
    expect(await kindsOf(partner, 'TWA')).toEqual(['commission', 'main']);
  });

  it('opens nothing for a currency added disabled, and everything once it is enabled', async () => {
    await add('TWD', false);
    // Give a background run the chance it must not take.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await walletCount('TWD')).toBe(0);

    await currencies.update('TWD', { enabled: true }, TEST_ACTOR);
    await opened(clientB, 'TWD');

    expect(await kindsOf(partner, 'TWD')).toEqual(['commission', 'main']);
  });

  it('adds nothing when run again, and never touches a balance', async () => {
    await add('TWR');
    await opened(clientA, 'TWR');
    await ctx.db.execute(sql`
      UPDATE wallets SET balance = 5 WHERE user_id = ${clientA} AND currency = 'TWR'
    `);

    const again = await currencies.openWalletsFor('TWR');

    expect(again).toEqual({ clients: 0, partners: 0 });
    const { rows } = await ctx.db.execute<{ balance: string }>(sql`
      SELECT balance::text AS balance FROM wallets WHERE user_id = ${clientA} AND currency = 'TWR'
    `);
    expect(rows[0].balance).toBe('5.00000000');
  });
});

describe('deleting a currency', () => {
  it('takes the wallets it opened with it, while none was ever used', async () => {
    await add('TWX');
    await opened(clientA, 'TWX');
    expect(await walletCount('TWX')).toBeGreaterThan(0);

    await currencies.remove('TWX', TEST_ACTOR);

    expect(await walletCount('TWX')).toBe(0);
    expect(await currencyExists('TWX')).toBe(false);
  });

  it('is refused while a wallet in it holds money, and deletes nothing', async () => {
    await add('TWM');
    await opened(clientA, 'TWM');
    const before = await walletCount('TWM');
    await ctx.db.execute(sql`
      UPDATE wallets SET balance = 1 WHERE user_id = ${clientA} AND currency = 'TWM'
    `);

    await expect(currencies.remove('TWM', TEST_ACTOR)).rejects.toThrow(/hold money/);

    expect(await walletCount('TWM')).toBe(before);
    expect(await currencyExists('TWM')).toBe(true);
  });

  it('is refused once a wallet in it has any history, even at a zero balance', async () => {
    await add('TWH');
    await opened(clientA, 'TWH');
    // A real ledger entry, then the balance moved out: history, and nothing held.
    await walletService.post({
      userId: clientA,
      currency: 'TWH',
      amount: '10',
      entryType: 'deposit',
      referenceType: 'test',
      referenceId: 'currency-history',
    });
    await ctx.db.execute(sql`
      UPDATE wallets SET balance = 0 WHERE user_id = ${clientA} AND currency = 'TWH'
    `);

    const attempt = currencies.remove('TWH', TEST_ACTOR);

    await expect(attempt).rejects.toBeInstanceOf(ConflictError);
    await expect(currencies.remove('TWH', TEST_ACTOR)).rejects.toThrow(/history/);
    expect(await currencyExists('TWH')).toBe(true);
    expect(await kindsOf(clientA, 'TWH')).toEqual(['main']);
  });
});

describe('a disabled currency on the client’s screens', () => {
  it('hides its empty wallets and keeps a wallet that holds money', async () => {
    await add('TWS');
    await opened(clientB, 'TWS');
    await currencies.update('TWS', { enabled: false }, TEST_ACTOR);

    const empty = await walletService.listWallets(clientB);
    expect(empty.map((wallet) => wallet.currency)).not.toContain('TWS');

    await ctx.db.execute(sql`
      UPDATE wallets SET balance = 2 WHERE user_id = ${clientB} AND currency = 'TWS'
    `);
    const funded = await walletService.listWallets(clientB);
    expect(funded.map((wallet) => wallet.currency)).toContain('TWS');
  });
});

describe('a partner approved later', () => {
  it('gets a commission wallet in every enabled currency', async () => {
    const later = await user('currency-wallets-later@oxshare-e2e.test');
    await makePartner(later, 'CURWAL2');
    const provisioning = new WalletProvisioningService(
      walletService,
      currencies,
      new WalletsStore(ctx.db),
    );

    await provisioning.openCommissionWallet(later);

    const enabled = (await currencies.listEnabled()).map((currency) => currency.code).sort();
    const { rows } = await ctx.db.execute<{ currency: string }>(sql`
      SELECT currency FROM wallets WHERE user_id = ${later} AND kind = 'commission' ORDER BY currency
    `);
    expect(rows.map((row) => row.currency)).toEqual(enabled);
  });
});
