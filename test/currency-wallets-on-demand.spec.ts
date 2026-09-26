import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { CurrenciesService } from '../src/modules/currencies/currencies.service';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { IbWalletService } from '../src/modules/ib/ib-wallet.service';
import {
  AuthorizationError,
  ConflictError,
  ValidationError,
} from '../src/common/errors/domain-errors';
import { auditStubAs, TEST_ACTOR } from './audit-stub';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * Wallets in a new currency are opened ON DEMAND (owner, 26 Sep 2026).
 *
 * Adding a currency opens nothing: a write per client for every currency an
 * operator adds does not scale to a million clients. The portal shows each
 * enabled currency a client does not hold as a card they open themselves
 * (`POST /wallet`), and each one a partner does not hold as a commission wallet
 * they open (`POST /ib/wallet/commission`) — one row, for the one who asked.
 *
 * Deleting a currency that never held money takes its empty wallets with it;
 * one that has seen money is refused and nothing is deleted. A disabled
 * currency's empty wallets drop off the client's screens; funded ones stay.
 */
let ctx: MoneyTestContext;
let currencies: CurrenciesService;
let wallets: WalletService;
let ibWallets: IbWalletService;
let client: string;
let partner: string;
let suspended: string;

async function user(email: string): Promise<string> {
  const { rows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name)
    VALUES (${email}, 'x', 'Wallet', 'Holder') RETURNING id
  `);
  return rows[0].id;
}

async function makePartner(userId: string, code: string, active = true): Promise<void> {
  await ctx.db.execute(sql`
    INSERT INTO ib_accounts (user_id, referral_code, program_id, active)
    VALUES (${userId}, ${code},
            (SELECT id FROM ib_programs ORDER BY sort_order, name LIMIT 1), ${active})
  `);
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

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  currencies = new CurrenciesService(ctx.db, auditStubAs());
  wallets = new WalletService(ctx.db);
  ibWallets = new IbWalletService(ctx.db, wallets);
  client = await user('on-demand-client@oxshare-e2e.test');
  partner = await user('on-demand-partner@oxshare-e2e.test');
  suspended = await user('on-demand-suspended@oxshare-e2e.test');
  await makePartner(partner, 'ONDEMAND1');
  await makePartner(suspended, 'ONDEMAND2', false);
}, 180_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

describe('adding a currency', () => {
  it('opens no wallet for anybody', async () => {
    await add('TOA');
    // Nothing runs in the background either — give it the chance anyway.
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(await walletCount('TOA')).toBe(0);
  });
});

describe('a client opens a wallet in a new currency', () => {
  it('opens exactly theirs, empty, in the shape the wallet list uses', async () => {
    await add('TOB');

    const opened = await wallets.openOwnWallet(client, 'tob');

    expect(opened).toMatchObject({
      userId: client,
      currency: 'TOB',
      kind: 'main',
      balance: '0.00000000',
      available: '0.00000000',
    });
    expect(await walletCount('TOB')).toBe(1);
    expect((await wallets.listWallets(client)).map((w) => w.currency)).toContain('TOB');
  });

  it('returns the same wallet on a second click, balance untouched', async () => {
    await add('TOC');
    const first = await wallets.openOwnWallet(client, 'TOC');
    await ctx.db.execute(sql`UPDATE wallets SET balance = 7 WHERE id = ${first.id}`);

    const again = await wallets.openOwnWallet(client, 'TOC');

    expect(again.id).toBe(first.id);
    expect(again.balance).toBe('7.00000000');
    expect(await walletCount('TOC')).toBe(1);
  });

  it('is refused for a disabled or unknown currency', async () => {
    await add('TOD', false);

    await expect(wallets.openOwnWallet(client, 'TOD')).rejects.toBeInstanceOf(ValidationError);
    await expect(wallets.openOwnWallet(client, 'NOPE')).rejects.toThrow(/not a currency/);
    expect(await walletCount('TOD')).toBe(0);
  });
});

describe('a partner opens a commission wallet in a new currency', () => {
  it('opens a COMMISSION wallet for an active partner, beside no main one', async () => {
    await add('TOE');

    const opened = await ibWallets.openCommissionWallet(partner, 'TOE');

    expect(opened).toMatchObject({ currency: 'TOE', kind: 'commission', balance: '0.00000000' });
    expect((await wallets.listWallets(partner, 'commission')).map((w) => w.currency)).toContain(
      'TOE',
    );
    expect((await wallets.listWallets(partner)).map((w) => w.currency)).not.toContain('TOE');
  });

  it('is refused for a client who is not a partner, and for a suspended partner', async () => {
    await add('TOF');

    await expect(ibWallets.openCommissionWallet(client, 'TOF')).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await expect(ibWallets.openCommissionWallet(suspended, 'TOF')).rejects.toThrow(/suspended/);
    expect(await walletCount('TOF')).toBe(0);
  });
});

describe('deleting a currency', () => {
  it('takes its empty, unused wallets with it', async () => {
    await add('TOX');
    await wallets.openOwnWallet(client, 'TOX');
    await ibWallets.openCommissionWallet(partner, 'TOX');

    await currencies.remove('TOX', TEST_ACTOR);

    expect(await walletCount('TOX')).toBe(0);
    expect(await currencyExists('TOX')).toBe(false);
  });

  it('is refused while a wallet in it holds money, and deletes nothing', async () => {
    await add('TOM');
    const funded = await wallets.openOwnWallet(client, 'TOM');
    await ibWallets.openCommissionWallet(partner, 'TOM');
    await ctx.db.execute(sql`UPDATE wallets SET balance = 1 WHERE id = ${funded.id}`);

    await expect(currencies.remove('TOM', TEST_ACTOR)).rejects.toThrow(/hold money/);

    expect(await walletCount('TOM')).toBe(2);
    expect(await currencyExists('TOM')).toBe(true);
  });

  it('is refused once a wallet in it has any history, even at a zero balance', async () => {
    await add('TOH');
    const used = await wallets.openOwnWallet(client, 'TOH');
    // A real ledger entry, then the balance moved out: history, and nothing held.
    await wallets.post({
      userId: client,
      currency: 'TOH',
      amount: '10',
      entryType: 'deposit',
      referenceType: 'test',
      referenceId: 'on-demand-history',
    });
    await ctx.db.execute(sql`UPDATE wallets SET balance = 0 WHERE id = ${used.id}`);

    const attempt = currencies.remove('TOH', TEST_ACTOR);

    await expect(attempt).rejects.toBeInstanceOf(ConflictError);
    await expect(currencies.remove('TOH', TEST_ACTOR)).rejects.toThrow(/history/);
    expect(await currencyExists('TOH')).toBe(true);
    expect(await walletCount('TOH')).toBe(1);
  });
});

describe('a disabled currency on the client’s screens', () => {
  it('hides its empty wallets and keeps a wallet that holds money', async () => {
    await add('TOS');
    const opened = await wallets.openOwnWallet(client, 'TOS');
    await currencies.update('TOS', { enabled: false }, TEST_ACTOR);

    expect((await wallets.listWallets(client)).map((w) => w.currency)).not.toContain('TOS');

    await ctx.db.execute(sql`UPDATE wallets SET balance = 2 WHERE id = ${opened.id}`);
    expect((await wallets.listWallets(client)).map((w) => w.currency)).toContain('TOS');
  });
});
