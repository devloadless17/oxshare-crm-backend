import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { ConfigService } from '@nestjs/config';
import { PaymentMethodsService } from '../src/modules/payments/payment-methods.service';
import { TransactionsService } from '../src/modules/payments/transactions.service';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { CurrenciesService } from '../src/modules/currencies/currencies.service';
import { MoneyLimits } from '../src/config/money-limits';
import { toDecimal } from '../src/modules/wallet/money';
import type { Actor } from '../src/common/security/actor';
import { auditStubAs } from './audit-stub';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * Deposit methods as operator DATA.
 *
 * The rule doing the most work here is that an unconfigured method is not
 * offered. The Whish row ships enabled=false with no `payTo`, because the
 * deleted deposit page recorded what the alternative costs: "Inventing an IBAN
 * is the same failure as the fake $0.00 balances, with a worse outcome: the
 * money leaves and does not arrive."
 */
let ctx: MoneyTestContext;
let methods: PaymentMethodsService;
let transactions: TransactionsService;
let wallets: WalletService;

/**
 * The configuring administrator.
 *
 * An `Actor` rather than a bare id — every write here is audited, and the
 * writer needs who did it. `updated_by` still receives `ADMIN.id`.
 */
const ADMIN: Actor = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'payments-admin@oxshare.internal',
  permissions: ['*'],
};

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  const currencies = new CurrenciesService(ctx.db, auditStubAs());
  wallets = new WalletService(ctx.db);
  methods = new PaymentMethodsService(ctx.db, currencies, auditStubAs());
  transactions = new TransactionsService(
    wallets,
    ctx.db,
    new MoneyLimits(new ConfigService()),
    methods,
    currencies,
  );
}, 120_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

async function makeClient(email: string): Promise<string> {
  const { rows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name, verification_level, email_verified)
    VALUES (${email}, 'x', 'Test', 'Client', 1, true)
    RETURNING id
  `);
  return rows[0].id;
}

/** Whish, as an operator would leave it once they had filled in the details. */
async function configureWhish(): Promise<void> {
  await methods.update(
    'whish',
    { payTo: '+961 70 123 456', instructions: 'Send via the Whish app.', enabled: true },
    ADMIN,
  );
}

beforeEach(async () => {
  await ctx.db.execute(sql`DELETE FROM transfers`);
  await ctx.db.execute(sql`DELETE FROM transactions`);
  await ctx.db.execute(sql`DELETE FROM ledger_entries`);
  await ctx.db.execute(sql`DELETE FROM wallets`);
  await ctx.db.execute(sql`UPDATE users SET referred_by_ib_user_id = NULL`);
  await ctx.db.execute(sql`DELETE FROM ib_accounts`);
  await ctx.db.execute(sql`DELETE FROM users`);
  // Back to what the migration seeds: Whish, disabled, unconfigured.
  await ctx.db.execute(sql`DELETE FROM payment_methods WHERE key <> 'whish'`);
  await ctx.db.execute(sql`
    UPDATE payment_methods
       SET enabled = false, pay_to = NULL, instructions = NULL,
           min_amount = NULL, max_amount = NULL
     WHERE key = 'whish'
  `);
});

describe('what the platform ships with', () => {
  it('has Whish, with its logo, disabled and unconfigured', async () => {
    const whish = await methods.findOne('whish');

    expect(whish?.name).toBe('Whish Money');
    expect(whish?.currency).toBe('USD');
    // `manual`, not `gateway`: the sandbox credentials are ARCHITECTURE open
    // decision #5 and nobody has them. A gateway wired to credentials that do
    // not exist is a deposit button that fails for every client.
    expect(whish?.kind).toBe('manual');
    expect(whish?.logoUrl).toContain('Whish');
    expect(whish?.enabled).toBe(false);
    expect(whish?.payTo).toBeNull();
  });

  it('offers it to nobody until an operator fills in the details', async () => {
    expect(await methods.listAvailable()).toEqual([]);
  });
});

describe('what a client is offered', () => {
  it('shows a method once it is enabled AND configured', async () => {
    await configureWhish();

    const available = await methods.listAvailable();
    expect(available).toHaveLength(1);
    expect(available[0].key).toBe('whish');
    expect(available[0].payTo).toBe('+961 70 123 456');
  });

  it('hides an ENABLED method that still has no pay-to', async () => {
    // The dangerous half-state: an operator flipped the switch and never came
    // back to the account number.
    await ctx.db.execute(sql`UPDATE payment_methods SET enabled = true WHERE key = 'whish'`);

    expect(await methods.listAvailable()).toEqual([]);
  });

  it('hides a CONFIGURED method that has been disabled', async () => {
    await configureWhish();
    await methods.update('whish', { enabled: false }, ADMIN);

    // What an operator does when a provider goes down. No deploy.
    expect(await methods.listAvailable()).toEqual([]);
  });

  it('honours the operator’s ordering', async () => {
    await configureWhish();
    await methods.create(
      {
        key: 'usdt_trc20',
        name: 'USDT (TRC20)',
        kind: 'crypto',
        currency: 'USDT',
        payTo: 'TXhtQ...',
        sortOrder: 0,
      },
      ADMIN,
    );

    // Presentation order is the operator's, not the alphabet's.
    expect((await methods.listAvailable()).map((m) => m.key)).toEqual(['usdt_trc20', 'whish']);
  });
});

describe('depositing through a method', () => {
  it('takes the currency from the METHOD, not the request', async () => {
    await configureWhish();
    const userId = await makeClient('deposit@test.local');

    const deposit = await transactions.requestDeposit({
      userId,
      amount: '100',
      // Deliberately wrong. A Whish deposit is a USD deposit — that is a
      // property of the method, not a choice — and honouring this would land
      // the money in a wallet the operator never agreed to receive into.
      currency: 'USDT',
      method: 'whish',
    });

    expect(deposit.currency).toBe('USD');
    expect(deposit.method).toBe('whish');
    // Declared, not credited. Nothing has arrived yet.
    expect(deposit.state).toBe('pending');
    expect(deposit.reference).toMatch(/^OX-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{6}$/);
  });

  it('credits nothing — a declaration is not money', async () => {
    await configureWhish();
    const userId = await makeClient('nocredit@test.local');

    await transactions.requestDeposit({ userId, amount: '100', currency: 'USD', method: 'whish' });

    const { rows } = await ctx.db.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM ledger_entries`,
    );
    expect(rows[0].count).toBe(0);
  });

  it('refuses a method nobody has configured', async () => {
    const userId = await makeClient('unconfigured@test.local');

    // Whish is seeded disabled. The client should never have been shown it,
    // and the write path refuses it independently of what the list returned.
    await expect(
      transactions.requestDeposit({ userId, amount: '100', currency: 'USD', method: 'whish' }),
    ).rejects.toThrow(/not currently available/i);
  });

  it('refuses a method that does not exist', async () => {
    const userId = await makeClient('unknown-method@test.local');

    await expect(
      transactions.requestDeposit({ userId, amount: '100', currency: 'USD', method: 'wish' }),
    ).rejects.toThrow(/unknown payment method/i);
  });

  it('refuses a method disabled between the page render and the submit', async () => {
    await configureWhish();
    const userId = await makeClient('raced@test.local');

    await methods.update('whish', { enabled: false }, ADMIN);

    // R-4.3: the list is what the client was shown a moment ago; the decision
    // belongs where the write happens.
    await expect(
      transactions.requestDeposit({ userId, amount: '100', currency: 'USD', method: 'whish' }),
    ).rejects.toThrow(/not currently available/i);
  });
});

describe('per-method bounds', () => {
  it('refuses below the method minimum', async () => {
    await configureWhish();
    await methods.update('whish', { minAmount: '50.00' }, ADMIN);
    const userId = await makeClient('below@test.local');

    await expect(
      transactions.requestDeposit({ userId, amount: '20', currency: 'USD', method: 'whish' }),
    ).rejects.toThrow(/minimum Whish Money deposit is 50/i);
  });

  it('refuses above the method maximum', async () => {
    await configureWhish();
    await methods.update('whish', { maxAmount: '500.00' }, ADMIN);
    const userId = await makeClient('above@test.local');

    await expect(
      transactions.requestDeposit({ userId, amount: '900', currency: 'USD', method: 'whish' }),
    ).rejects.toThrow(/maximum Whish Money deposit is 500/i);
  });

  it('applies the method bound AND the platform bound', async () => {
    await configureWhish();
    const userId = await makeClient('both-bounds@test.local');

    /*
     * Neither is derivable from the other: a provider may refuse under $20
     * while the platform's own floor is $10. The tighter of the two is what
     * the client experiences, and here that is the platform's.
     */
    await expect(
      transactions.requestDeposit({ userId, amount: '1', currency: 'USD', method: 'whish' }),
    ).rejects.toThrow(/minimum deposit/i);
  });

  it('accepts an amount inside both', async () => {
    await configureWhish();
    await methods.update('whish', { minAmount: '20.00', maxAmount: '5000.00' }, ADMIN);
    const userId = await makeClient('within@test.local');

    const deposit = await transactions.requestDeposit({
      userId,
      amount: '100',
      currency: 'USD',
      method: 'whish',
    });
    expect(deposit.amount).toBe('100.00000000');
  });
});

describe('managing methods', () => {
  it('refuses a minimum above the maximum', async () => {
    // Accepts nothing, and says so at neither end — the client would see
    // "minimum is 500" on one attempt and "maximum is 100" on the next.
    await expect(
      methods.update('whish', { minAmount: '500.00', maxAmount: '100.00' }, ADMIN),
    ).rejects.toThrow(/no amount would be accepted/i);
  });

  it('refuses a currency the platform does not hold', async () => {
    await expect(
      methods.create({ key: 'bogus', name: 'Bogus', kind: 'manual', currency: 'XXX' }, ADMIN),
    ).rejects.toThrow(/unknown currency/i);
  });

  it('refuses a duplicate key, case-insensitively', async () => {
    // Keys are normalised, so 'Whish' and 'whish' are one method rather than
    // two rows a client could be offered side by side.
    await expect(
      methods.create({ key: 'WHISH', name: 'Whish again', kind: 'manual', currency: 'USD' }, ADMIN),
    ).rejects.toThrow(/already exists/i);
  });

  it('refuses to delete a method deposits reference', async () => {
    await configureWhish();
    const userId = await makeClient('history@test.local');
    await transactions.requestDeposit({ userId, amount: '100', currency: 'USD', method: 'whish' });

    /*
     * `transactions.method_key` is a RESTRICT foreign key, so the database
     * would refuse this anyway. The service turns that into a sentence naming
     * what to do instead.
     */
    await expect(methods.remove('whish', ADMIN)).rejects.toThrow(/disable it instead/i);
  });

  it('deletes one nothing references', async () => {
    await methods.create(
      { key: 'temp', name: 'Temporary', kind: 'manual', currency: 'USD' },
      ADMIN,
    );

    await expect(methods.remove('temp', ADMIN)).resolves.toEqual({ key: 'temp', deleted: true });
  });

  it('keeps bounds as strings — §6.1', async () => {
    await methods.update('whish', { minAmount: '0.00000001' }, ADMIN);

    const whish = await methods.findOne('whish');
    // Eight decimal places survive. A bound that round-tripped through a float
    // would compare wrongly against an amount that did not.
    expect(toDecimal(whish?.minAmount ?? '0').toFixed(8)).toBe('0.00000001');
  });
});
