import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { ConfigService } from '@nestjs/config';
import { TransactionsService } from '../src/modules/payments/transactions.service';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { CurrenciesService } from '../src/modules/currencies/currencies.service';
import { PaymentMethodsService } from '../src/modules/payments/payment-methods.service';
import { FieldValidationError } from '../src/common/errors/domain-errors';
import type { Actor } from '../src/common/security/actor';
import { auditStubAs } from './audit-stub';
import { emailStubAs } from './email-stub';
import { notificationsStubAs } from './notifications-stub';
import { transferExecutorStubAs, transfersStubAs } from './transfer-chain-stub';
import { gatewayStubAs } from './gateway-stub';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * MONEY LIMITS BELONG TO THE CURRENCY (0162, owner, 29 Sep 2026).
 *
 * The report: an operator could not let a client withdraw more than 50,000
 * Lebanese pounds — about fifty cents — because the limits were one config
 * number for every currency. What this file pins, against real Postgres:
 *
 *  - every currency that existed is backfilled with the numbers it had, so
 *    nothing moves the day this ships;
 *  - a withdrawal is held to ITS currency's minimum and maximum (no daily cap);
 *  - a deposit method's range is its currency's, narrowed by the method's own
 *    optional range and never widened, and the deposit path enforces it;
 *  - a nonsensical set of limits is refused field by field, merged on update,
 *    and the database refuses it too if a writer skips the service.
 */
let ctx: MoneyTestContext;
let transactions: TransactionsService;
let wallets: WalletService;
let currencies: CurrenciesService;
let methods: PaymentMethodsService;

const ADMIN = { id: '00000000-0000-4000-8000-000000000001', kind: 'admin' } as unknown as Actor;

/** LBP as an operator would set it: millions, not tens. */
const LBP_LIMITS = {
  minDeposit: '1000000',
  maxDeposit: '5000000000',
  minWithdrawal: '1000000',
  maxWithdrawal: '500000000',
};

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  wallets = new WalletService(ctx.db);
  currencies = new CurrenciesService(ctx.db, auditStubAs());
  methods = new PaymentMethodsService(ctx.db, currencies, auditStubAs(), gatewayStubAs());
  transactions = new TransactionsService(
    wallets,
    ctx.db,
    methods,
    currencies,
    gatewayStubAs(),
    new ConfigService(),
    emailStubAs(),
    notificationsStubAs(),
    transfersStubAs(),
    transferExecutorStubAs(),
  );
  // Captured BEFORE LBP is created: what 0162 left on the seeded rows.
  seededUsd = await currencies.findOne('USD');
  await currencies.create(
    { code: 'LBP', name: 'Lebanese Pound', symbol: 'LL', decimals: 0, ...LBP_LIMITS },
    ADMIN,
  );
}, 120_000);

let seededUsd: Awaited<ReturnType<CurrenciesService['findOne']>>;

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

beforeEach(async () => {
  await ctx.db.execute(sql`DELETE FROM transfers`);
  await ctx.db.execute(sql`DELETE FROM transactions`);
  await ctx.db.execute(
    sql`TRUNCATE ledger_entries, ib_accruals CASCADE` /* the ledger is append-only by trigger; TRUNCATE resets a fixture without firing row triggers */,
  );
  await ctx.db.execute(sql`DELETE FROM wallets`);
  await ctx.db.execute(sql`UPDATE users SET referred_by_ib_user_id = NULL`);
  await ctx.db.execute(sql`DELETE FROM ib_accounts`);
  await ctx.db.execute(sql`DELETE FROM users`);
  await ctx.db.execute(sql`DELETE FROM payment_methods WHERE key <> 'whish'`);
  await currencies.update('LBP', LBP_LIMITS, ADMIN);
});

/** A verified client holding `balance` in `currency`. */
async function fundedClient(email: string, currency: string, balance: string): Promise<number> {
  const { rows } = await ctx.db.execute<{ id: number }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name, verification_level, email_verified)
    VALUES (${email}, 'x', 'Test', 'Client', 1, true)
    RETURNING id
  `);
  const userId = rows[0].id;
  await wallets.post({
    userId,
    currency,
    amount: balance,
    entryType: 'deposit',
    referenceType: 'transaction',
    referenceId: `seed-${userId}-${currency}`,
  });
  return userId;
}

const withdraw = (userId: number, currency: string, amount: string) =>
  transactions.requestWithdrawal({
    userId,
    currency,
    amount,
    destination: '+961 3 123 456',
    methodKey: 'whish',
  });

describe('the day it ships', () => {
  it('backfills every existing currency with the limits it already had', () => {
    expect(seededUsd).toMatchObject({
      minDeposit: '10.00000000',
      maxDeposit: '250000.00000000',
      minWithdrawal: '10.00000000',
      maxWithdrawal: '50000.00000000',
    });
  });
});

describe('a withdrawal is held to its CURRENCY', () => {
  it('lets an LBP client withdraw millions — past the old 50,000 cap', async () => {
    const userId = await fundedClient('lbp-big@test.local', 'LBP', '900000000');
    const tx = await withdraw(userId, 'LBP', '5000000');
    expect(tx.amount).toBe('5000000.00000000');
    expect(tx.currency).toBe('LBP');
  });

  it("refuses above the currency's maximum, naming it in that currency", async () => {
    const userId = await fundedClient('lbp-over@test.local', 'LBP', '900000000');
    await expect(withdraw(userId, 'LBP', '500000001')).rejects.toThrow(
      'The maximum single withdrawal is 500000000 LBP.',
    );
  });

  it("refuses below the currency's minimum — 10 LBP is not a withdrawal", async () => {
    const userId = await fundedClient('lbp-under@test.local', 'LBP', '900000000');
    await expect(withdraw(userId, 'LBP', '999999')).rejects.toThrow(
      'The minimum withdrawal is 1000000 LBP.',
    );
  });

  it('keeps USD where it was', async () => {
    const userId = await fundedClient('usd@test.local', 'USD', '90000');
    await expect(withdraw(userId, 'USD', '50001')).rejects.toThrow(
      'The maximum single withdrawal is 50000 USD.',
    );
    await expect(withdraw(userId, 'USD', '9')).rejects.toThrow('The minimum withdrawal is 10 USD.');
  });

  it('has no rolling-day cap any more (owner, 29 Sep 2026) — only the per-request range', async () => {
    const userId = await fundedClient('lbp-day@test.local', 'LBP', '2000000000');
    await withdraw(userId, 'LBP', '500000000');
    await withdraw(userId, 'LBP', '500000000');
    await withdraw(userId, 'LBP', '500000000');
  });

  it('follows a change to the limits at once — no restart, no deploy', async () => {
    const userId = await fundedClient('lbp-raise@test.local', 'LBP', '2000000000');
    await expect(withdraw(userId, 'LBP', '700000000')).rejects.toThrow(/maximum single/);
    await currencies.update('LBP', { maxWithdrawal: '800000000' }, ADMIN);
    await withdraw(userId, 'LBP', '700000000');
  });
});

describe("a deposit method's range", () => {
  it("is the currency's when the method sets none", async () => {
    await methods.create({ name: 'OMT', currency: 'LBP' }, ADMIN);
    const [omt] = (await methods.listAvailable(null)).filter((m) => m.currency === 'LBP');
    expect(omt.minAmount).toBe('1000000.00000000');
    expect(omt.maxAmount).toBe('5000000000.00000000');
  });

  it('narrows to the method’s own, and the deposit path enforces it', async () => {
    const created = await methods.create(
      { name: 'Wish Money', currency: 'LBP', ownMinAmount: '2000000', ownMaxAmount: '90000000' },
      ADMIN,
    );
    const usable = await methods.assertUsable(created.key, null);
    expect(usable.minAmount).toBe('2000000.00000000');
    expect(usable.maxAmount).toBe('90000000.00000000');

    const userId = await fundedClient('lbp-deposit@test.local', 'LBP', '1');
    await expect(
      transactions.requestDeposit({
        userId,
        amount: '1500000',
        currency: 'LBP',
        method: created.key,
      }),
    ).rejects.toThrow('The minimum Wish Money deposit is 2000000 LBP.');
    await expect(
      transactions.requestDeposit({
        userId,
        amount: '90000001',
        currency: 'LBP',
        method: created.key,
      }),
    ).rejects.toThrow('The maximum Wish Money deposit is 90000000 LBP.');
    const ok = await transactions.requestDeposit({
      userId,
      amount: '50000000',
      currency: 'LBP',
      method: created.key,
    });
    expect(ok.amount).toBe('50000000.00000000');
  });

  it("refuses an own range that would WIDEN the currency's, under its field", async () => {
    const attempt = methods.create(
      { name: 'Too wide', currency: 'LBP', ownMaxAmount: '9000000000' },
      ADMIN,
    );
    await expect(attempt).rejects.toBeInstanceOf(FieldValidationError);
    await expect(attempt).rejects.toMatchObject({
      fields: { ownMaxAmount: expect.stringMatching(/only narrow .* 1000000–5000000000 LBP/) },
    });
  });

  it('refuses a maximum below the minimum', async () => {
    await expect(
      methods.create(
        { name: 'Upside down', currency: 'LBP', ownMinAmount: '5000000', ownMaxAmount: '2000000' },
        ADMIN,
      ),
    ).rejects.toMatchObject({
      fields: { ownMaxAmount: expect.stringMatching(/below the minimum/) },
    });
  });

  it('re-judges the range when the method moves currency', async () => {
    const usd = await methods.create(
      { name: 'Card', currency: 'USD', ownMinAmount: '20', ownMaxAmount: '5000' },
      ADMIN,
    );
    // 20–5000 is fine in USD and would be below LBP's 1,000,000 floor.
    await expect(methods.update(usd.key, { currency: 'LBP' }, ADMIN)).rejects.toMatchObject({
      fields: { ownMinAmount: expect.stringMatching(/only narrow/) },
    });
    // Clearing the override moves it cleanly.
    const moved = await methods.update(
      usd.key,
      { currency: 'LBP', ownMinAmount: null, ownMaxAmount: null },
      ADMIN,
    );
    expect(moved.minAmount).toBe('1000000.00000000');
  });

  it('never widens even after the currency tightens under a saved override', async () => {
    const created = await methods.create(
      { name: 'Branch', currency: 'LBP', ownMaxAmount: '4000000000' },
      ADMIN,
    );
    await currencies.update('LBP', { maxDeposit: '3000000000' }, ADMIN);
    const usable = await methods.assertUsable(created.key, null);
    expect(usable.maxAmount).toBe('3000000000.00000000');
  });
});

describe('the limits themselves', () => {
  it('are required on create — no currency inherits another’s numbers', async () => {
    await expect(
      currencies.create(
        { code: 'EUR', name: 'Euro', symbol: '€', ...LBP_LIMITS, maxDeposit: '1' },
        ADMIN,
      ),
    ).rejects.toMatchObject({
      fields: {
        maxDeposit: expect.stringMatching(/cannot be below the minimum deposit \(1000000\)/),
      },
    });
    expect(await currencies.findOne('EUR')).toBeNull();
  });

  it('are judged MERGED on update — a new minimum above the stored maximum is refused', async () => {
    await expect(
      currencies.update('LBP', { minWithdrawal: '600000000' }, ADMIN),
    ).rejects.toMatchObject({
      fields: { maxWithdrawal: expect.stringMatching(/cannot be below the minimum withdrawal/) },
    });
    expect((await currencies.findOne('LBP'))?.minWithdrawal).toBe('1000000.00000000');
  });

  it('refuse a zero', async () => {
    await expect(currencies.update('LBP', { minDeposit: '0' }, ADMIN)).rejects.toMatchObject({
      fields: { minDeposit: 'The minimum deposit must be above zero.' },
    });
  });

  it('are refused by the database too, for a writer that skips the service', async () => {
    await expect(
      ctx.db.execute(sql`UPDATE currencies SET max_deposit = 1 WHERE code = 'LBP'`),
    ).rejects.toMatchObject({ cause: { constraint: 'currencies_money_limits_ck' } });
    await expect(
      ctx.db.execute(
        sql`UPDATE payment_methods SET min_amount = 5, max_amount = 1 WHERE key = 'whish'`,
      ),
    ).rejects.toMatchObject({ cause: { constraint: 'payment_methods_amount_bounds_ck' } });
  });
});

/* Arabic (0179): the currency's name in Arabic, optional, served to clients. */
describe('the Arabic name', () => {
  it('stores it trimmed, serves it on the client list, keeps it on an omitting edit, clears blank', async () => {
    await currencies.create(
      {
        code: 'AED',
        name: 'UAE Dirham',
        nameAr: ' درهم إماراتي ',
        symbol: 'د.إ',
        decimals: 2,
        ...LBP_LIMITS,
      },
      ADMIN,
    );
    expect((await currencies.findOne('AED'))?.nameAr).toBe('درهم إماراتي');
    const listed = (await currencies.listEnabled()).find((row) => row.code === 'AED');
    expect(listed?.nameAr).toBe('درهم إماراتي');
    expect((await currencies.listEnabled()).find((row) => row.code === 'LBP')?.nameAr).toBeNull();

    await currencies.update('AED', { name: 'Dirham' }, ADMIN);
    expect((await currencies.findOne('AED'))?.nameAr).toBe('درهم إماراتي');
    await currencies.update('AED', { nameAr: '   ' }, ADMIN);
    expect((await currencies.findOne('AED'))?.nameAr).toBeNull();
  });
});
