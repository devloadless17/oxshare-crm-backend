import { ALL_PERMISSIONS } from './support/all-permissions';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { emailStubAs } from './email-stub';
import { notificationsStubAs } from './notifications-stub';
import { transferExecutorStubAs, transfersStubAs } from './transfer-chain-stub';
import { gatewayStub } from './gateway-stub';
import type { PaymentGateways } from '../src/modules/payments/payment-gateways.service';
import { PaymentIndeterminateError, ValidationError } from '../src/common/errors/domain-errors';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * Deposit methods as operator DATA.
 *
 * The rule doing the most work here is that `enabled` decides what a client is
 * offered — with ONE exception a form cannot fix: a GATEWAY also needs its
 * provider credentials on the deployment, which live in the environment rather
 * than the database.
 *
 * The old rules were `pay_to` (gone with the column in 0042) and `kind` (gone in
 * 0043). Nothing an operator can half-complete is left.
 */
let ctx: MoneyTestContext;
let methods: PaymentMethodsService;
let transactions: TransactionsService;
let wallets: WalletService;
/**
 * ONE stub, shared by both services rather than one each.
 *
 * The gateway-refusal tests below drive `startPayment` from the outside and then
 * assert on the row `requestDeposit` left behind. That only works if the object
 * the test configures is the object the service calls — two `gatewayStubAs()`
 * calls produce two independent sets of mocks, and the deposit would keep
 * succeeding against a stub nobody touched.
 */
let gateways: ReturnType<typeof gatewayStub>;

/**
 * The configuring administrator.
 *
 * An `Actor` rather than a bare id — every write here is audited, and the
 * writer needs who did it. `updated_by` still receives `ADMIN.id`.
 */
const ADMIN: Actor = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'payments-admin@oxshare.internal',
  permissions: ALL_PERMISSIONS,
};

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  const currencies = new CurrenciesService(ctx.db, auditStubAs());
  wallets = new WalletService(ctx.db);
  gateways = gatewayStub();
  const asGateways = gateways as unknown as PaymentGateways;
  methods = new PaymentMethodsService(
    ctx.db,
    currencies,
    auditStubAs(),
    asGateways,
    new MoneyLimits(new ConfigService()),
  );
  transactions = new TransactionsService(
    wallets,
    ctx.db,
    new MoneyLimits(new ConfigService()),
    methods,
    currencies,
    asGateways,
    new ConfigService(),
    emailStubAs(),
    notificationsStubAs(),
    transfersStubAs(),
    transferExecutorStubAs(),
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

/**
 * A usable MANUAL deposit method.
 *
 * The deposit tests below are about manual declarations — currency inheritance,
 * bounds, "a declaration is not money" — and none of them is about a gateway.
 * They used Whish, which is now derived as a `gateway` and correctly withheld in
 * any environment without provider credentials, so they would fail for a reason
 * that has nothing to do with what they assert.
 */
const MANUAL = 'bank_transfer';

async function configureManualMethod(): Promise<void> {
  await methods.create(
    { key: MANUAL, name: 'Bank transfer', currency: 'USD', enabled: true },
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
  // Back to the seeded Whish row, disabled. The pay-to, instructions and bound
  // columns were dropped in migration 0042, so there is nothing else to reset.
  await ctx.db.execute(sql`DELETE FROM payment_methods WHERE key <> 'whish'`);
  await ctx.db.execute(sql`UPDATE payment_methods SET enabled = false WHERE key = 'whish'`);
});

describe('what the platform ships with', () => {
  it('has Whish, logoless, disabled', async () => {
    const whish = await methods.findOne('whish');

    expect(whish?.name).toBe('Whish Money');
    expect(whish?.currency).toBe('USD');
    // Null since migration 0065: the 0033 seed pointed at Whish's marketing CDN,
    // which both frontends' CSP (`img-src 'self'`) refuses — so the seeded logo
    // could never render anywhere. A real logo arrives when an operator uploads
    // one through the console, stored same-origin. This asserted toContain('Whish')
    // until then, which failed on every fresh database from 0065 onwards.
    expect(whish?.logoUrl).toBeNull();
    expect(whish?.enabled).toBe(false);
  });

  it('offers it to nobody while it is disabled', async () => {
    // Seeded disabled. `enabled` is now the whole test — see `isConfigured`.
    expect(await methods.listAvailable()).toEqual([]);
  });

  /*
   * That `usdt_trc20` is GONE is asserted in `money-schema-constraints.spec.ts`
   * instead. It has to be: the `beforeEach` above deletes every row but Whish,
   * so an assertion here would pass on its own cleanup rather than on what the
   * migrations produced.
   */
});

describe('what a client is offered', () => {
  it('shows a manual method once it is enabled', async () => {
    await methods.create({ key: 'bank_transfer', name: 'Bank transfer', currency: 'USD' }, ADMIN);

    const available = await methods.listAvailable();
    expect(available).toHaveLength(1);
    expect(available[0].key).toBe('bank_transfer');
  });

  /*
   * The pay-to rule is GONE — that field left the admin surface, so enabling a
   * method is the operator's whole decision and there is no half-configured
   * state left to hide.
   *
   * What replaces it is narrower and not an operator's to fix: a GATEWAY still
   * needs its provider credentials on this deployment. `gatewayStub` reports
   * unconfigured, which is the honest answer for a test environment with no
   * Whish keys — so an enabled Whish is still correctly withheld, for a reason
   * no amount of form-filling would change.
   */
  it('hides an enabled GATEWAY whose provider this deployment cannot reach', async () => {
    await ctx.db.execute(sql`UPDATE payment_methods SET enabled = true WHERE key = 'whish'`);

    expect(await methods.listAvailable()).toEqual([]);
  });

  it('offers an enabled MANUAL method with no pay-to', async () => {
    await methods.create({ key: 'bank_transfer', name: 'Bank transfer', currency: 'USD' }, ADMIN);

    const available = await methods.listAvailable();
    expect(available.map((m) => m.key)).toEqual(['bank_transfer']);
  });

  it('reports the platform deposit bounds on every method', async () => {
    await methods.create({ key: 'bank_transfer', name: 'Bank transfer', currency: 'USD' }, ADMIN);

    const [method] = await methods.listAvailable();
    /*
     * Resolved server-side so the portal cannot show a floor the validator does
     * not enforce. Non-null and positive is the guarantee; the exact figures are
     * env-configurable and asserting them here would pin a default nobody chose.
     */
    expect(toDecimal(method.maxAmount).greaterThan(toDecimal(method.minAmount))).toBe(true);
  });

  it('hides a CONFIGURED method that has been disabled', async () => {
    await configureManualMethod();
    await methods.update(MANUAL, { enabled: false }, ADMIN);

    // What an operator does when a provider goes down. No deploy.
    expect(await methods.listAvailable()).toEqual([]);
  });

  it('honours the operator’s ordering rather than the alphabet', async () => {
    /*
     * The keys are deliberately in the WRONG alphabetical order for the sort
     * orders they carry, so this fails if `listAvailable` ever falls back to
     * ordering by key. The previous version of this test used two keys that
     * happened to be alphabetical AND tied on `sortOrder`, so it passed either
     * way and proved nothing.
     *
     * Whish is absent because its gateway credentials are not configured in a
     * test environment — see the gateway test above.
     */
    await methods.create({ key: 'aaa_last', name: 'Last', currency: 'USD', sortOrder: 9 }, ADMIN);
    await methods.create({ key: 'zzz_first', name: 'First', currency: 'USD', sortOrder: 1 }, ADMIN);

    expect((await methods.listAvailable()).map((m) => m.key)).toEqual(['zzz_first', 'aaa_last']);
  });
});

describe('depositing through a method', () => {
  it('takes the currency from the METHOD, not the request', async () => {
    await configureManualMethod();
    const userId = await makeClient('deposit@test.local');

    const deposit = await transactions.requestDeposit({
      userId,
      amount: '100',
      // Deliberately wrong. A Whish deposit is a USD deposit — that is a
      // property of the method, not a choice — and honouring this would land
      // the money in a wallet the operator never agreed to receive into.
      currency: 'USDT',
      method: MANUAL,
    });

    expect(deposit.currency).toBe('USD');
    expect(deposit.method).toBe(MANUAL);
    // Declared, not credited. Nothing has arrived yet.
    expect(deposit.state).toBe('pending');
    expect(deposit.reference).toMatch(/^OX-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{6}$/);
  });

  it('credits nothing — a declaration is not money', async () => {
    await configureManualMethod();
    const userId = await makeClient('nocredit@test.local');

    await transactions.requestDeposit({ userId, amount: '100', currency: 'USD', method: MANUAL });

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
      transactions.requestDeposit({ userId, amount: '100', currency: 'USD', method: MANUAL }),
    ).rejects.toThrow(/unknown payment method/i);
  });

  it('refuses a method that does not exist', async () => {
    const userId = await makeClient('unknown-method@test.local');

    await expect(
      transactions.requestDeposit({ userId, amount: '100', currency: 'USD', method: 'wish' }),
    ).rejects.toThrow(/unknown payment method/i);
  });

  it('refuses a method disabled between the page render and the submit', async () => {
    await configureManualMethod();
    const userId = await makeClient('raced@test.local');

    await methods.update(MANUAL, { enabled: false }, ADMIN);

    // R-4.3: the list is what the client was shown a moment ago; the decision
    // belongs where the write happens.
    await expect(
      transactions.requestDeposit({ userId, amount: '100', currency: 'USD', method: MANUAL }),
    ).rejects.toThrow(/not currently available/i);
  });
});

/**
 * ⚠️ What the deposit ROW says when the gateway does not start the payment.
 *
 * The row is written before the provider is called, deliberately — the reverse
 * risks a payment existing at Whish that this system has no record of. What was
 * wrong is what the row said afterwards: it stayed `pending`, which the client's
 * own transaction list renders as money on its way. A deposit that never started
 * sat there as "processing" forever.
 *
 * These two tests are the whole rule, and they must disagree with each other.
 */
describe('the amount must be expressible in the currency (D-77)', () => {
  it('a currency configured to 8 places is STILL bounded by the RAIL — whish takes 2', async () => {
    /*
     * The deposit half of the hole the withdrawal path had.
     *
     * `currencies.decimals` is operator data and the admin screen accepts 0 to
     * 8; Rival takes 2 in BOTH directions (`quantiseIn` rounds to
     * RIVAL_MONEY_SCALE just as `quantiseOut` does). Checking the currency alone
     * closed this for USD, which declares 2, and left it inert for any currency
     * configured to more.
     *
     * It bites harder on a deposit than on a withdrawal: the wallet is credited
     * `tx.amount` while the payment LINK is created at the rounded figure, so
     * the client pays one number and is credited another — and because money-in
     * rounds to NEAREST rather than down, the CRM can credit MORE than was
     * collected, with the broker paying the difference on every such deposit.
     */
    gateways.isConfigured.mockReturnValue(true);
    await ctx.db.execute(sql`UPDATE payment_methods SET enabled = true WHERE key = 'whish'`);
    await ctx.db.execute(sql`UPDATE currencies SET decimals = 8 WHERE code = 'USD'`);
    try {
      const userId = await makeClient('deposit-rail-bound@test.local');

      await expect(
        transactions.requestDeposit({
          userId,
          amount: '100.12345678',
          currency: 'USD',
          method: 'whish',
        }),
      ).rejects.toThrow(/2 decimal places/i);

      // Two places still go through — the bound is the rail's, not zero.
      await expect(
        transactions.requestDeposit({
          userId,
          amount: '100.12',
          currency: 'USD',
          method: 'whish',
        }),
      ).resolves.toBeDefined();
    } finally {
      await ctx.db.execute(sql`UPDATE currencies SET decimals = 2 WHERE code = 'USD'`);
      gateways.isConfigured.mockReturnValue(false);
    }
  });

  it('refuses more decimal places than the currency holds', async () => {
    /*
     * The mirror of the withdrawal rule, and it can go the WRONG WAY here.
     *
     * A deposit is credited at `tx.amount`, but the payment link is created at
     * the provider's own scale, and money-in rounds to NEAREST rather than
     * down — so an over-precise amount can ask the client to pay one figure
     * and credit them a larger one.
     */
    await configureManualMethod();
    const userId = await makeClient('deposit-scale@test.local');

    await expect(
      transactions.requestDeposit({
        userId,
        amount: '100.123456789',
        currency: 'USD',
        method: MANUAL,
      }),
    ).rejects.toThrow(/2 decimal places/i);
  });

  it('suggests the SAME figure the pay button shows — half-up, not down', async () => {
    /*
     * The screen used to contradict itself.
     *
     * The portal's pay button renders the amount through `formatMoney`, which
     * rounds HALF-UP for display, so `50.129` produced a button promising
     * "Pay $50.13" beside a server message saying "Try 50.12 USD" — and
     * clicking the button failed. The message rounded down "for consistency
     * with the withdrawal message", which mattered far less than consistency
     * with the number on the same screen.
     *
     * A deposit has no balance to overshoot, so nothing is protected by
     * rounding down. 50.129 means 50.13.
     */
    await configureManualMethod();
    const userId = await makeClient('deposit-suggestion@test.local');

    await expect(
      transactions.requestDeposit({
        userId,
        amount: '50.129',
        currency: 'USD',
        method: MANUAL,
      }),
    ).rejects.toThrow(/50\.13/);

    // And never the floored figure, which is what the button contradicted.
    await expect(
      transactions.requestDeposit({
        userId,
        amount: '50.129',
        currency: 'USD',
        method: MANUAL,
      }),
    ).rejects.not.toThrow(/50\.12/);
  });

  it('accepts cents, and trailing zeros are not extra precision', async () => {
    await configureManualMethod();
    const userId = await makeClient('deposit-cents@test.local');

    await expect(
      transactions.requestDeposit({ userId, amount: '100.05', currency: 'USD', method: MANUAL }),
    ).resolves.toBeDefined();
    await expect(
      transactions.requestDeposit({
        userId,
        amount: '100.50000000',
        currency: 'USD',
        method: MANUAL,
      }),
    ).resolves.toBeDefined();
  });
});

describe('a gateway that will not start the payment', () => {
  beforeEach(() => {
    // Whish reachable and enabled, so the deposit gets as far as the provider.
    gateways.isConfigured.mockReturnValue(true);
  });

  afterEach(() => {
    // Back to the honest default for a test environment with no Whish keys —
    // every other test in this file depends on it.
    gateways.isConfigured.mockReturnValue(false);
    gateways.startPayment.mockReset();
    gateways.startPayment.mockResolvedValue({ paymentUrl: 'https://example.test/pay/stub' });
  });

  async function enabledWhishDeposit(email: string): Promise<string> {
    await ctx.db.execute(sql`UPDATE payment_methods SET enabled = true WHERE key = 'whish'`);
    return makeClient(email);
  }

  async function depositRow(userId: string) {
    const { rows } = await ctx.db.execute<{ state: string; rejection_reason: string | null }>(
      sql`SELECT state, rejection_reason FROM transactions WHERE user_id = ${userId}`,
    );
    return rows;
  }

  it('marks the deposit FAILED when the provider refuses', async () => {
    gateways.startPayment.mockRejectedValueOnce(
      new ValidationError('The payment provider refused the request. Please try again.'),
    );
    const userId = await enabledWhishDeposit('gateway-refused@test.local');

    await expect(
      transactions.requestDeposit({ userId, amount: '100', currency: 'USD', method: 'whish' }),
    ).rejects.toThrow(/refused/i);

    const rows = await depositRow(userId);
    expect(rows).toHaveLength(1);
    // NOT `pending`. That is the bug: "processing" for a payment that never
    // started, with no link and nothing coming.
    expect(rows[0].state).toBe('failure');
    // The provider's own reason, so support can answer "why" months later from
    // a row that would otherwise say only `failure`.
    expect(rows[0].rejection_reason).toMatch(/refused/i);
  });

  /**
   * ⚠️ THE OPPOSITE, and the more expensive mistake of the two.
   *
   * `PaymentIndeterminateError` means the provider does not know the outcome —
   * a payment link may exist and may still be paid. Marking that `failure` tells
   * a client who goes on to pay that their money did not arrive. It stays
   * pending and the reconciler settles it from `getStatus`.
   */
  it('leaves the deposit PENDING when the provider does not know', async () => {
    gateways.startPayment.mockRejectedValueOnce(
      new PaymentIndeterminateError('The payment provider did not confirm the result.'),
    );
    const userId = await enabledWhishDeposit('gateway-unknown@test.local');

    await expect(
      transactions.requestDeposit({ userId, amount: '100', currency: 'USD', method: 'whish' }),
    ).rejects.toThrow(/did not confirm/i);

    const rows = await depositRow(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('pending');
    expect(rows[0].rejection_reason).toBeNull();
  });

  /** Neither path touches a balance — `requestDeposit` writes no ledger rows. */
  it('credits nothing either way', async () => {
    gateways.startPayment.mockRejectedValueOnce(new ValidationError('refused'));
    const userId = await enabledWhishDeposit('gateway-noledger@test.local');

    await expect(
      transactions.requestDeposit({ userId, amount: '100', currency: 'USD', method: 'whish' }),
    ).rejects.toThrow();

    const { rows } = await ctx.db.execute<{ count: number }>(
      sql`SELECT count(*)::int AS count FROM ledger_entries`,
    );
    expect(rows[0].count).toBe(0);
  });
});

describe('per-method bounds', () => {
  /*
   * The bounds are the PLATFORM's now — the per-method columns went in 0042 —
   * and these pin that the figure enforced is the figure `listAvailable` hands
   * the deposit screen. If the two ever diverge, a client is refused by a number
   * they were never shown, which is a rejection with no visible cause.
   */
  it('refuses below the resolved minimum, naming the figure', async () => {
    await configureManualMethod();
    const [method] = await methods.listAvailable();
    const belowFloor = toDecimal(method.minAmount).minus('0.01').toFixed(2);
    const userId = await makeClient('below@test.local');

    await expect(
      transactions.requestDeposit({
        userId,
        amount: belowFloor,
        currency: 'USD',
        method: MANUAL,
      }),
    ).rejects.toThrow(/minimum Bank transfer deposit/i);
  });

  it('refuses above the resolved maximum, naming the figure', async () => {
    await configureManualMethod();
    const [method] = await methods.listAvailable();
    const aboveCeiling = toDecimal(method.maxAmount).plus('1').toFixed(2);
    const userId = await makeClient('above@test.local');

    await expect(
      transactions.requestDeposit({
        userId,
        amount: aboveCeiling,
        currency: 'USD',
        method: MANUAL,
      }),
    ).rejects.toThrow(/maximum Bank transfer deposit/i);
  });

  it('applies the method bound AND the platform bound', async () => {
    await configureManualMethod();
    const userId = await makeClient('both-bounds@test.local');

    /*
     * Neither is derivable from the other: a provider may refuse under $20
     * while the platform's own floor is $10. The tighter of the two is what
     * the client experiences, and here that is the platform's.
     */
    await expect(
      transactions.requestDeposit({ userId, amount: '1', currency: 'USD', method: MANUAL }),
    ).rejects.toThrow(/minimum Bank transfer deposit is 10/i);
  });

  it('accepts an amount inside both', async () => {
    await configureManualMethod();
    const userId = await makeClient('within@test.local');

    const deposit = await transactions.requestDeposit({
      userId,
      amount: '100',
      currency: 'USD',
      method: MANUAL,
    });
    expect(deposit.amount).toBe('100.00000000');
  });
});

describe('managing methods', () => {
  it('refuses a currency the platform does not hold', async () => {
    await expect(
      methods.create({ key: 'bogus', name: 'Bogus', currency: 'XXX' }, ADMIN),
    ).rejects.toThrow(/unknown currency/i);
  });

  it('refuses a duplicate key, case-insensitively', async () => {
    // Keys are normalised, so 'Whish' and 'whish' are one method rather than
    // two rows a client could be offered side by side.
    await expect(
      methods.create({ key: 'WHISH', name: 'Whish again', currency: 'USD' }, ADMIN),
    ).rejects.toThrow(/already exists/i);
  });

  /**
   * Enabling is the ONE thing an operator changes, so it is the one thing that
   * must not need anything else sent with it.
   *
   * The admin console's toggle is a row action: it PATCHes `{ enabled }` alone,
   * from a table row that does not hold the rest of the method. A partial update
   * that blanked the untouched fields would rename a method to nothing and drop
   * its logo every time somebody turned it off and on again.
   */
  it('toggling enabled leaves every other field alone', async () => {
    await methods.create(
      {
        key: 'toggle_me',
        name: 'Toggle me',
        currency: 'USD',
        logoUrl: '/v1/uploads/payment-logos/abc.png',
        sortOrder: 4,
      },
      ADMIN,
    );

    const off = await methods.update('toggle_me', { enabled: false }, ADMIN);

    expect(off.enabled).toBe(false);
    expect(off.name).toBe('Toggle me');
    expect(off.currency).toBe('USD');
    expect(off.logoUrl).toBe('/v1/uploads/payment-logos/abc.png');
    expect(off.sortOrder).toBe(4);
  });

  /*
   * DELETING IS GONE — `remove()` and its route were removed, not hidden behind
   * a confirmation. `transactions.method_key` is a RESTRICT foreign key, so
   * deleting only ever worked on methods nobody had used and threw a conflict on
   * every method that mattered.
   *
   * Disabling is what it was reached for, and these two tests pin that it does
   * the whole job: gone from the client's list, and refused on the write path.
   * Without BOTH, a method could vanish from the screen while still accepting a
   * deposit from a client who had the page open.
   */
  it('disabling hides a method from clients without touching its history', async () => {
    await configureManualMethod();
    const userId = await makeClient('history@test.local');
    const filed = await transactions.requestDeposit({
      userId,
      amount: '100',
      currency: 'USD',
      method: MANUAL,
    });

    await methods.update(MANUAL, { enabled: false }, ADMIN);

    const available = await methods.listAvailable();
    expect(available.map((m) => m.key)).not.toContain(MANUAL);

    // The deposit filed against it is untouched and still names the method —
    // which is the thing deleting the row would have destroyed.
    expect(filed.method).toBe(MANUAL);
    expect(await methods.findOne(MANUAL)).not.toBeNull();
  });

  it('refuses a new deposit through a disabled method', async () => {
    await configureManualMethod();
    await methods.update(MANUAL, { enabled: false }, ADMIN);
    const userId = await makeClient('disabled@test.local');

    await expect(
      transactions.requestDeposit({ userId, amount: '100', currency: 'USD', method: MANUAL }),
    ).rejects.toThrow(/not currently available/i);
  });

  /*
   * The per-method bound columns were dropped in 0042, so the §6.1 guarantee
   * moved to the RESOLVED bounds — which is where it matters now, because those
   * are the figures both the deposit screen and the validator read.
   *
   * A bound that round-tripped through a float would compare wrongly against an
   * amount that did not, so the assertion is on the SHAPE: eight decimal places,
   * as a string, exactly as every other monetary value crosses this boundary.
   */
  it('reports the resolved bounds as 8dp strings — §6.1', async () => {
    await configureManualMethod();

    const [method] = await methods.listAvailable();
    expect(typeof method.minAmount).toBe('string');
    expect(typeof method.maxAmount).toBe('string');
    expect(method.minAmount).toMatch(/^\d+\.\d{8}$/);
    expect(method.maxAmount).toMatch(/^\d+\.\d{8}$/);
  });
});
