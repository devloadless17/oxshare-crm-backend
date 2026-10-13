import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { ConfigService } from '@nestjs/config';
import { TransactionsService } from '../src/modules/payments/transactions.service';
import { PaymentMethodsService } from '../src/modules/payments/payment-methods.service';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { CurrenciesService } from '../src/modules/currencies/currencies.service';
import { AuditLogStore } from '../src/store/audit-log.store';
import { UsersStore } from '../src/store/users.store';
import { PaymentProvidersStore } from '../src/store/payment-providers.store';
import { paymentProviders } from '../src/database/schema';
import { sealSecret } from '../src/common/security/secret-box';
import { PaymentIndeterminateError, ValidationError } from '../src/common/errors/domain-errors';
import { HostedDepositsService } from '../src/modules/payments/core/hosted-deposits.service';
import { PayoutEngine } from '../src/modules/payments/core/payout-engine.service';
import { ChannelSwitchesService } from '../src/modules/payments/core/channel-switches.service';
import { ProviderWebhookIngress } from '../src/modules/payments/core/provider-webhook-ingress.service';
import { ProviderRecordsAudit } from '../src/modules/payments/core/provider-records-audit.service';
import { PaymentProviderExchangesStore } from '../src/store/payment-provider-exchanges.store';
import { PaymentProviderRegistry } from '../src/modules/payments/providers/payment-provider-registry';
import { ManualPaymentProvider } from '../src/modules/payments/providers/manual/manual.provider';
import { ThreePayPaymentProvider } from '../src/modules/payments/providers/threepay/threepay.provider';
import { ThreePayClient } from '../src/modules/payments/providers/threepay/threepay.client';
import { ThreePayConfigService } from '../src/modules/payments/providers/threepay/threepay-config.service';
import { ThreePayWebhookReceiver } from '../src/modules/payments/providers/threepay/threepay-webhook.receiver';
import type { EmailService } from '../src/modules/email/email.service';
import type { ResourceChangedPublisher } from '../src/common/realtime/resource-changed';
import { auditStubAs } from './audit-stub';
import { emailStub } from './email-stub';
import { notificationsStub } from './notifications-stub';
import { transferExecutorStubAs, transfersStubAs } from './transfer-chain-stub';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';
import { ThreePaySim } from './support/threepay-sim';

/**
 * 3PAY, END TO END against its simulator (0174; rebuilt 12 Oct 2026): the REAL
 * adapter, client, settings and webhook receiver, through the REAL payments
 * core, on real Postgres. The simulator behaves as 3pay's LIVE server was
 * measured to; a few cases switch it to the PDF guide's shapes, because the
 * adapter must read both.
 */

const TRON = 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE';
const COLD_WALLET = 'TTjcKQmLLRHzFVPkErrABJ7kf23TNEVW1y';
const ADMIN = '00000000-0000-4000-8000-00000000c0de';

let ctx: MoneyTestContext;
let sim: ThreePaySim;
let wallets: WalletService;
let transactions: TransactionsService;
let deposits: HostedDepositsService;
let payouts: PayoutEngine;
let ingress: ProviderWebhookIngress;
let records: ProviderRecordsAudit;
let exchanges: PaymentProviderExchangesStore;
let settings: ThreePayConfigService;
let adapter: ThreePayPaymentProvider;
let threepay: ThreePayClient;
const bell = notificationsStub();
const email = emailStub();

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  sim = new ThreePaySim();
  await sim.start();

  const config = new ConfigService({ API_PUBLIC_URL: 'https://api.oxshare.test' });
  const providersStore = new PaymentProvidersStore(ctx.db);
  settings = new ThreePayConfigService(providersStore, config);
  exchanges = new PaymentProviderExchangesStore(ctx.db);
  threepay = new ThreePayClient(settings, config, exchanges);
  adapter = new ThreePayPaymentProvider(threepay, settings);
  const registry = new PaymentProviderRegistry([new ManualPaymentProvider(), adapter]);
  wallets = new WalletService(ctx.db);
  const currencies = new CurrenciesService(ctx.db, auditStubAs());
  const methods = new PaymentMethodsService(ctx.db, currencies, auditStubAs(), registry);
  transactions = new TransactionsService(
    wallets,
    ctx.db,
    methods,
    currencies,
    registry,
    config,
    email as unknown as EmailService,
    bell,
    transfersStubAs(),
    transferExecutorStubAs(),
  );
  deposits = new HostedDepositsService(
    ctx.db,
    registry,
    wallets,
    transactions,
    methods,
    currencies,
    new AuditLogStore(ctx.db),
    bell,
    { publish: vi.fn().mockResolvedValue(undefined) } as unknown as ResourceChangedPublisher,
  );
  payouts = new PayoutEngine(
    ctx.db,
    registry,
    new ChannelSwitchesService(ctx.db, registry),
    transactions,
    new AuditLogStore(ctx.db),
    new UsersStore(ctx.db),
    email as unknown as EmailService,
    bell,
    { publish: vi.fn().mockResolvedValue(undefined) } as unknown as ResourceChangedPublisher,
    config,
  );
  ingress = new ProviderWebhookIngress(
    [new ThreePayWebhookReceiver(settings, threepay)],
    registry,
    deposits,
    payouts,
    providersStore,
    exchanges,
  );
  records = new ProviderRecordsAudit(ctx.db, new AuditLogStore(ctx.db));

  await ctx.db.execute(sql`
    INSERT INTO currencies (code, name, symbol, enabled, is_default)
    VALUES ('USD', 'US Dollar', '$', true, true) ON CONFLICT (code) DO NOTHING`);
  // The row 0174 seeds, filled in as an operator would in the console.
  await ctx.db
    .update(paymentProviders)
    .set({
      enabled: true,
      config: {
        baseUrl: sim.baseUrl,
        apiKey: sim.apiKey,
        trc20PayoutFee: '2.00',
        erc20PayoutFee: '2.50',
      },
      secrets: { apiSecret: sealSecret(sim.apiSecret, process.env['APP_ENCRYPTION_KEY']) },
    })
    .where(eq(paymentProviders.code, 'threepay'));
  await ctx.db.execute(sql`
    INSERT INTO payment_methods (key, name, internal_label, currency, enabled, provider_code, channel_code)
    VALUES ('usdt_trc20_in', 'USDT (TRC20)', 'USDT TRC20 in', 'USD', true, 'threepay', 'usdt_trc20')
    ON CONFLICT (key) DO NOTHING`);
  await ctx.db.execute(sql`
    INSERT INTO withdrawal_payment_methods (key, name, internal_label, enabled, provider_code, channel_code)
    VALUES ('usdt_trc20_out', 'USDT (TRC20)', 'USDT TRC20 out', true, 'threepay', 'usdt_trc20'),
           ('usdt_erc20_out', 'USDT (ERC20)', 'USDT ERC20 out', true, 'threepay', 'usdt_erc20')
    ON CONFLICT (key) DO NOTHING`);
}, 120_000);

afterAll(async () => {
  deposits.onModuleDestroy(); // no re-check outlives the database
  await sim.stop();
  await stopMoneyTestDb(ctx);
});

beforeEach(async () => {
  vi.clearAllMocks();
  sim.reset();
  settings.invalidate();
  threepay.forget();
  // Earlier cases' open payouts must not wait behind, be swept into, or count
  // against the submission rate of, this one.
  await ctx.db.execute(sql`
    UPDATE transactions SET state = 'failure', payout_fingerprint = NULL
     WHERE provider_code = 'threepay' AND state IN ('pending', 'approved')`);
  await ctx.db.execute(sql`
    UPDATE transactions SET provider_submitted_at = now() - interval '1 hour'
     WHERE provider_code = 'threepay' AND provider_submitted_at IS NOT NULL`);
});

let seq = 0;
async function client(fund = '0'): Promise<number> {
  seq += 1;
  const { rows } = await ctx.db.execute<{ id: number }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name, verification_level, email_verified)
    VALUES (${`threepay-${seq}@spec.test`}, 'x', 'Usdt', 'Client', 1, true) RETURNING id`);
  const userId = rows[0].id;
  if (fund !== '0') {
    await wallets.post({
      userId,
      currency: 'USD',
      amount: fund,
      entryType: 'deposit',
      referenceType: 'transaction',
      referenceId: `seed-${userId}`,
    });
  }
  return userId;
}

async function balance(userId: number): Promise<string> {
  const { rows } = await ctx.db.execute<{ balance: string }>(
    sql`SELECT balance FROM wallets WHERE user_id = ${userId} AND currency = 'USD'`,
  );
  return rows[0]?.balance ?? '0.00000000';
}

const row = (txId: string) => transactions.getById(txId);

/** Deliver a webhook to the ingress exactly as 3pay would. */
function deliver(
  event: Record<string, unknown>,
  options: { secret?: string; shape?: 'live' | 'guide'; legacy?: boolean; test?: boolean } = {},
) {
  const { body, headers } = sim.webhook(event, options);
  const all: Record<string, string> = {
    ...headers,
    ...(options.test ? { 'x-webhook-test': 'true' } : {}),
  };
  return ingress.receive('threepay', body, (name) => all[name.toLowerCase()]);
}

const confirmed = (tx: { providerPaymentId: string | null }) => ({
  type: 'deposit',
  status: 'confirmed',
  transactionId: tx.providerPaymentId,
  amount: 100,
});

async function deposit(amount = '100') {
  const userId = await client();
  const started = await transactions.requestDeposit({
    userId,
    amount,
    currency: 'USD',
    method: 'usdt_trc20_in',
  });
  const tx = await row(started.id);
  return { userId, tx };
}

async function approvedWithdrawal(
  amount = '100',
  destination = TRON,
  methodKey = 'usdt_trc20_out',
): Promise<string> {
  const userId = await client('1000');
  const requested = await transactions.requestWithdrawal({
    userId,
    amount,
    currency: 'USD',
    destination,
    methodKey,
  });
  await transactions.approve(requested.id, ADMIN, { awaitsProviderPayout: true });
  return requested.id;
}

describe('3pay deposits', () => {
  it('opens a link as the LIVE server reads it: the fields in the query, our reference in the body', async () => {
    const { tx } = await deposit('100');
    const request = sim.createRequests[0];
    expect(request.query).toMatchObject({
      currencyType: 'USDT-TRC20',
      amount: '100',
      timer: '30',
      webhookUrl: 'https://api.oxshare.test/v1/payments/providers/threepay/webhook',
    });
    // Where the payer's browser goes afterwards: the API's return bounce.
    expect(request.query['callbackUrl']).toMatch(
      /^https:\/\/api\.oxshare\.test\/v1\/payments\/deposits\/OX-[A-Z0-9]+\/return\/success/,
    );
    expect(JSON.parse(request.body)).toMatchObject({ referenceId: tx.providerRef });

    const invoice = sim.invoices[0];
    expect(invoice.referenceId).toBe(tx.providerRef);
    // Named by 3pay's transaction id, the one its verify call and webhooks use.
    expect(tx.providerPaymentId).toBe(invoice.transactionId);
    expect(tx.providerPaymentUrl).toMatch(/^https:\/\/pay\.3pa-y\.example\/s\//);
    // 3pay's reply does not say when the link ends; ours is the timer we sent.
    const minutes = ((tx.providerPaymentExpiresAt?.getTime() ?? 0) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(28);
    expect(minutes).toBeLessThan(30);
  });

  it('credits what 3pay’s API says ARRIVED — to the cent, rounded down, never a float', async () => {
    const { userId, tx } = await deposit('100');
    sim.confirm(tx.providerPaymentId ?? '', '99.999999');

    const answer = await deliver(confirmed(tx));
    expect(answer.status).toBe(200);
    const settled = await row(tx.id);
    expect(settled.state).toBe('success');
    expect(settled.amount).toBe('99.99000000');
    expect(settled.requestedAmount).toBe('100.00000000');
    expect(settled.providerAmountReceived).toBe('99.99999900');
    expect(await balance(userId)).toBe('99.99000000');

    // The same delivery again changes nothing (3pay retries; replays are free).
    expect((await deliver(confirmed(tx))).status).toBe(200);
    expect(await balance(userId)).toBe('99.99000000');
  });

  it('a delivery is only a doorbell: a signed "confirmed" 3pay’s API does not confirm credits nothing', async () => {
    const { userId, tx } = await deposit('100');
    const answer = await deliver(confirmed(tx));
    // Answered 200, as 3pay's guide asks of every verified delivery — and nothing credited.
    expect(answer.status).toBe(200);
    expect((await row(tx.id)).state).toBe('pending');
    expect(await balance(userId)).toBe('0.00000000');
  });

  it('3pay rings before its API agrees: the deposit is asked about again, and credited with no second delivery', async () => {
    const paced = adapter as unknown as { noticeRecheckMs: readonly number[] };
    const declared = paced.noticeRecheckMs;
    paced.noticeRecheckMs = [40, 80];
    try {
      const { userId, tx } = await deposit('100');
      expect((await deliver(confirmed(tx))).status).toBe(200);
      expect((await row(tx.id)).state).toBe('pending');

      sim.confirm(tx.providerPaymentId ?? '', '100'); // its API catches up; it sends nothing more
      await vi.waitFor(async () => expect((await row(tx.id)).state).toBe('success'), {
        timeout: 5000,
      });
      expect(await balance(userId)).toBe('100.00000000');
    } finally {
      paced.noticeRecheckMs = declared;
    }
  });

  it('refuses a forged delivery before reading it, and the signature 3pay does not use', async () => {
    const { tx } = await deposit('100');
    sim.confirm(tx.providerPaymentId ?? '', '100');
    expect((await deliver(confirmed(tx), { secret: 'not-the-secret' })).status).toBe(401);
    // The API secret is no key for a webhook (3pay, 13 Oct 2026)…
    expect((await deliver(confirmed(tx), { secret: sim.apiSecret })).status).toBe(401);
    // …and `x-3pay-signature`, which its guide once described, is never accepted.
    expect((await deliver(confirmed(tx), { legacy: true })).status).toBe(401);
    expect((await row(tx.id)).state).toBe('pending');
  });

  it('a rotated webhook secret is read from the account again', async () => {
    const receiver = new ThreePayWebhookReceiver(settings, threepay);
    const read = (event: Record<string, unknown>) => {
      const { body, headers } = sim.webhook(event);
      return receiver.read(body, (name) => headers[name.toLowerCase()]);
    };
    const event = { type: 'deposit', status: 'confirmed', transactionId: 'T-1' };
    expect((await read(event)).verified).toBe(true); // the secret is now remembered
    sim.webhookSecret = 'f'.repeat(64);
    expect((await read(event)).verified).toBe(true);
    // …but a second failure inside ten minutes spends no request: a forged flood costs nothing.
    sim.webhookSecret = 'e'.repeat(64);
    sim.calls.length = 0;
    expect((await read(event)).verified).toBe(false);
    expect(sim.calls).toEqual([]);
  });

  it('the dashboard’s test delivery is answered 200 and moves nothing', async () => {
    const answer = await deliver({}, { test: true });
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ outcome: 'test' });
  });

  it('the guide’s envelopes work end to end: replies under `data`, a flat webhook', async () => {
    sim.shape = 'guide';
    const { userId, tx } = await deposit('100');
    // Known by its transaction id, the only id 3pay's verify takes.
    expect(tx.providerPaymentId).toBe(sim.invoices[0].transactionId);
    expect(tx.providerPaymentUrl).toMatch(/\/checkout\//);
    sim.confirm(tx.providerPaymentId ?? '', '100');
    const answer = await deliver({
      type: 'deposit',
      status: 'confirmed',
      transactionId: tx.providerPaymentId,
      invoiceNo: sim.invoices[0].invoiceNo,
    });
    expect(answer.status).toBe(200);
    expect(await balance(userId)).toBe('100.00000000');
    // Never asked by invoice number: 3pay's verify does not take one.
    expect(sim.calls.filter((call) => call.includes('invoiceNo='))).toEqual([]);
  });

  it('a link answer that names no transaction id is not used: it is found again by our reference', async () => {
    const userId = await client();
    sim.createOmitsTransactionId = true;
    await expect(
      transactions.requestDeposit({
        userId,
        amount: '25',
        currency: 'USD',
        method: 'usdt_trc20_in',
      }),
    ).rejects.toBeInstanceOf(PaymentIndeterminateError);
    const [unnamed] = (
      await ctx.db.execute<{ id: string }>(
        sql`SELECT id FROM transactions WHERE user_id = ${userId} AND direction = 'deposit'`,
      )
    ).rows;
    expect((await row(unnamed.id)).providerPaymentId).toBeNull();
    await ctx.db.execute(
      sql`UPDATE transactions SET created_at = now() - interval '5 minutes' WHERE id = ${unnamed.id}`,
    );
    await deposits.sweep('threepay');
    expect(sim.invoices).toHaveLength(1);
    expect((await row(unnamed.id)).providerPaymentId).toBe(sim.invoices[0].transactionId);
  });

  it('the payer’s own check asks 3pay at most once in 15 seconds, and never fails at its limit', async () => {
    const { tx } = await deposit('100');
    const check = () => deposits.settle(undefined, tx.providerRef ?? '', { ownerId: tx.userId });
    const verifies = () => sim.calls.filter((call) => call.includes('/transaction/verify')).length;
    sim.calls.length = 0;
    // A client pressing "Check now" again and again (16 times in 5 s on 12 Oct 2026).
    for (let press = 0; press < 5; press += 1) await check();
    expect(verifies()).toBe(1);

    await ctx.db.execute(
      sql`UPDATE transactions SET provider_checked_at = now() - interval '20 seconds' WHERE id = ${tx.id}`,
    );
    await check();
    expect(verifies()).toBe(2);

    // At 3pay's limit the stored state is the answer, never an error.
    await ctx.db.execute(
      sql`UPDATE transactions SET provider_checked_at = now() - interval '20 seconds' WHERE id = ${tx.id}`,
    );
    sim.used.read = 100;
    threepay.forget();
    expect((await check()).state).toBe('pending');
  });

  it('an expired link fails; a LATE confirmation is credited exactly once', async () => {
    const { userId, tx } = await deposit('50');
    sim.expire(tx.providerPaymentId ?? '');
    await ctx.db.execute(
      sql`UPDATE transactions SET created_at = now() - interval '5 minutes' WHERE id = ${tx.id}`,
    );
    await deposits.sweep('threepay');
    expect((await row(tx.id)).state).toBe('failure');

    sim.confirm(tx.providerPaymentId ?? '', '50');
    await ctx.db.execute(
      sql`UPDATE transactions SET provider_checked_at = now() - interval '2 hours' WHERE id = ${tx.id}`,
    );
    await deposits.sweep('threepay');
    await deposits.sweep('threepay');
    expect((await row(tx.id)).state).toBe('success');
    expect(await balance(userId)).toBe('50.00000000');
  });

  it('when the sweep has used its share of 3pay’s reads, a delivery from 3pay is still checked and credited', async () => {
    const first = await deposit('20');
    const paid = await deposit('30');
    await ctx.db.execute(sql`
      UPDATE transactions SET created_at = now() - interval '5 minutes'
       WHERE id IN (${first.tx.id}, ${paid.tx.id})`);
    sim.used.read = 65; // 35 left at 3pay: inside what the sweep must leave
    sim.calls.length = 0;
    await deposits.sweep('threepay');
    // One read told us where 3pay's count stands; the sweep then stopped.
    expect(sim.calls.filter((call) => call.includes('/transaction/verify'))).toHaveLength(1);

    sim.confirm(paid.tx.providerPaymentId ?? '', '30');
    expect((await deliver(confirmed(paid.tx))).status).toBe(200);
    expect((await row(paid.tx.id)).state).toBe('success');
    expect(await balance(paid.userId)).toBe('30.00000000');
  });

  it('a link nobody opened closes as soon as its time is up, not half an hour later', async () => {
    const { userId, tx } = await deposit('50');
    await ctx.db.execute(sql`
      UPDATE transactions
         SET created_at = now() - interval '35 minutes',
             provider_payment_expires_at = now() - interval '2 minutes'
       WHERE id = ${tx.id}`);
    await deposits.sweep('threepay');
    const closed = await row(tx.id);
    expect(closed.state).toBe('failure');
    expect(closed.rejectionReason).toBe('The payment link expired before the payment arrived.');
    expect(await balance(userId)).toBe('0.00000000');
  });

  it('an OPENED link past our time that 3pay never expired is closed — and a late payment still credits', async () => {
    const { userId, tx } = await deposit('50');
    sim.open(tx.providerPaymentId ?? ''); // 3pay's timer started late: payable after ours ends
    await ctx.db.execute(sql`
      UPDATE transactions
         SET created_at = now() - interval '2 hours',
             provider_payment_expires_at = now() - interval '20 minutes'
       WHERE id = ${tx.id}`);
    await deposits.sweep('threepay');
    expect((await row(tx.id)).state).toBe('pending'); // inside the grace: a last-minute payment confirms

    await ctx.db.execute(sql`
      UPDATE transactions SET provider_payment_expires_at = now() - interval '90 minutes'
       WHERE id = ${tx.id}`);
    await deposits.sweep('threepay');
    expect((await row(tx.id)).state).toBe('failure');
    expect(await balance(userId)).toBe('0.00000000');

    sim.confirm(tx.providerPaymentId ?? '', '50');
    await ctx.db.execute(
      sql`UPDATE transactions SET provider_checked_at = now() - interval '2 hours' WHERE id = ${tx.id}`,
    );
    await deposits.sweep('threepay');
    expect((await row(tx.id)).state).toBe('success');
    expect(await balance(userId)).toBe('50.00000000');
  });

  it('an old expired link is asked about rarely: a week-old one is not re-asked after two hours', async () => {
    const { tx } = await deposit('50');
    sim.expire(tx.providerPaymentId ?? '');
    await ctx.db.execute(sql`
      UPDATE transactions
         SET state = 'failure', settled_at = now() - interval '7 days',
             provider_checked_at = now() - interval '2 hours'
       WHERE id = ${tx.id}`);
    sim.calls.length = 0;
    await deposits.sweep('threepay');
    expect(sim.calls.filter((call) => call.includes('/transaction/verify'))).toEqual([]);
  });

  it('money that arrived on a link 3pay did not confirm is a person’s — never credited, never failed', async () => {
    const { userId, tx } = await deposit('100');
    sim.expire(tx.providerPaymentId ?? '', '40');
    await deposits.settleRow(await row(tx.id), 'poll');
    const flagged = await row(tx.id);
    expect(flagged.state).toBe('pending');
    expect(flagged.needsAttention).toBe(true);
    expect(flagged.attentionReason).toMatch(/40 USDT-TRC20 arrived/);
    expect(await balance(userId)).toBe('0.00000000');
  });

  it('3pay reporting another network is never credited', async () => {
    const { userId, tx } = await deposit('100');
    sim.confirm(tx.providerPaymentId ?? '', '100');
    sim.invoice(tx.providerPaymentId ?? '').currencyType = 'USDT-ERC20';
    await deposits.settleRow(await row(tx.id), 'poll');
    expect((await row(tx.id)).needsAttention).toBe(true);
    expect(await balance(userId)).toBe('0.00000000');
  });

  it('with no arrival figure, the link’s amount is credited only when 3pay’s own sums agree', async () => {
    sim.reportsArrival = false;
    // Paid in full: net 99 + fee 1 is the link's 100.
    const full = await deposit('100');
    sim.confirm(full.tx.providerPaymentId ?? '', '100');
    await deposits.settleRow(await row(full.tx.id), 'poll');
    expect(await balance(full.userId)).toBe('100.00000000');

    // 60 arrived on a 100 link: net 59 + fee 1 is not 100, so nobody guesses.
    const short = await deposit('100');
    sim.confirm(short.tx.providerPaymentId ?? '', '60');
    await deposits.settleRow(await row(short.tx.id), 'poll');
    const flagged = await row(short.tx.id);
    expect(flagged.state).toBe('pending');
    expect(flagged.needsAttention).toBe(true);
    expect(await balance(short.userId)).toBe('0.00000000');
  });

  it('a start whose ANSWER was lost is found by our reference — the link is never made twice', async () => {
    const userId = await client();
    sim.dropNextCreate = true;
    await expect(
      transactions.requestDeposit({
        userId,
        amount: '25',
        currency: 'USD',
        method: 'usdt_trc20_in',
      }),
    ).rejects.toBeInstanceOf(PaymentIndeterminateError);
    const [lost] = (
      await ctx.db.execute<{ id: string }>(
        sql`SELECT id FROM transactions WHERE user_id = ${userId} AND direction = 'deposit'`,
      )
    ).rows;
    expect((await row(lost.id)).providerPaymentId).toBeNull();

    await ctx.db.execute(
      sql`UPDATE transactions SET created_at = now() - interval '5 minutes' WHERE id = ${lost.id}`,
    );
    await deposits.sweep('threepay');
    expect(sim.invoices).toHaveLength(1);
    expect((await row(lost.id)).providerPaymentId).toBe(sim.invoices[0].transactionId);
  });

  it('a refusal by 3pay never shows the client 3pay’s words, and the deposit is failed', async () => {
    const userId = await client();
    sim.ipBlocked = true;
    const attempt = transactions.requestDeposit({
      userId,
      amount: '25',
      currency: 'USD',
      method: 'usdt_trc20_in',
    });
    await expect(attempt).rejects.toThrow('USDT deposits are unavailable right now');
    const { rows } = await ctx.db.execute<{ state: string; rejection_reason: string }>(
      sql`SELECT state, rejection_reason FROM transactions WHERE user_id = ${userId}`,
    );
    expect(rows[0].state).toBe('failure');
    expect(rows[0].rejection_reason).not.toMatch(/whitelist|Validation|IP/i);
  });

  it('at 3pay’s limit of payment links, the client is told to wait and nothing is sent', async () => {
    const userId = await client();
    await deposit('10'); // the budget now follows 3pay's own count
    sim.used.create = 20;
    await deposit('10').catch(() => undefined); // 3pay answers 429: the window is closed
    sim.createRequests.length = 0;
    await expect(
      transactions.requestDeposit({
        userId,
        amount: '25',
        currency: 'USD',
        method: 'usdt_trc20_in',
      }),
    ).rejects.toThrow(/busy right now/);
    expect(sim.createRequests).toEqual([]);
  });
});

describe('3pay payouts', () => {
  it('fee taken out of the amount (`user`): 3pay is asked 102.00 exactly, and the client receives their 100', async () => {
    const txId = await approvedWithdrawal('100');
    await payouts.submitApproved(txId);

    expect(sim.payoutRequests).toHaveLength(1);
    expect(sim.payoutRequests[0]).toMatch(
      /^\{"amount":102,"walletAddress":"TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE","currencyType":"USDT-TRC20"/,
    );
    const paid = await row(txId);
    expect(paid.state).toBe('success');
    expect(paid.amount).toBe('100.00000000');
    expect(paid.providerRequestAmount).toBe('102.00000000');
    expect(paid.providerNetAmount).toBe('100.00000000');
    expect(paid.needsAttention).toBe(false);
  });

  it('an account set to `merchant` is asked 102 all the same: 3pay does not apply that setting yet', async () => {
    // 3pay, 13 Oct 2026: asked for 100 on such an account, the recipient receives 98.
    sim.withdrawalFeePayer = 'merchant';
    const txId = await approvedWithdrawal('100');
    await payouts.submitApproved(txId);
    expect(sim.payoutRequests[0]).toMatch(/^\{"amount":102,/);
    const paid = await row(txId);
    expect(paid.state).toBe('success');
    expect(paid.providerNetAmount).toBe('100.00000000');
    expect(paid.needsAttention).toBe(false);
  });

  it('an account that does not say who carries the fee is asked 102 too', async () => {
    sim.withdrawalFeePayer = null;
    const txId = await approvedWithdrawal('100');
    await payouts.submitApproved(txId);
    expect(sim.payoutRequests[0]).toMatch(/^\{"amount":102,/);
  });

  it('the day 3pay applies `merchant`, the client receives the fee on top: settled, and FLAGGED', async () => {
    sim.withdrawalFeePayer = 'merchant';
    sim.honoursFeePayer = true; // 3pay's announced fix
    const txId = await approvedWithdrawal(
      '100',
      '0x52908400098527886E0F7030069857D2E4169EE7',
      'usdt_erc20_out',
    );
    await payouts.submitApproved(txId);
    expect(sim.payoutRequests[0]).toMatch(/^\{"amount":102\.5,/);
    const paid = await row(txId);
    expect(paid.state).toBe('success');
    expect(paid.needsAttention).toBe(true);
    expect(paid.attentionReason).toMatch(/2\.5 USD MORE than they withdrew/);
  });

  it('the payout pace follows the limit 3pay states: its announced 100 a minute is used at once', async () => {
    const payoutRail = adapter.payouts;
    expect(payoutRail.rate).toEqual({ limit: 25, windowMs: 900_000 }); // 30 per 15 minutes, less 5
    sim.statedLimits.payout = 100;
    sim.windowSeconds = 60;
    const txId = await approvedWithdrawal('10');
    await payouts.submitApproved(txId);
    expect(payoutRail.rate).toEqual({ limit: 95, windowMs: 60_000 });
  });

  it('202 executing: settled only when 3pay’s own record says completed (the webhook re-reads)', async () => {
    sim.nextWithdrawal.push('executing');
    const txId = await approvedWithdrawal('30');
    await payouts.submitApproved(txId);
    const sent = await row(txId);
    expect(sent.state).toBe('approved');
    expect(sent.providerPayoutId).toBe(sim.withdrawals[0]._id);

    sim.finish(sim.withdrawals[0]._id, 'completed');
    const answer = await deliver({
      type: 'withdrawal',
      status: 'completed',
      transactionId: sim.withdrawals[0]._id,
    });
    expect(answer.status).toBe(200);
    expect((await row(txId)).state).toBe('success');
  });

  it('held for approval at 3pay: in flight, not flagged; paid once somebody approves it there', async () => {
    sim.autoWithdraw = false;
    const txId = await approvedWithdrawal('250');
    await payouts.submitApproved(txId);
    const waiting = await row(txId);
    expect(waiting.state).toBe('approved');
    expect(waiting.providerPayoutId).toBe(sim.withdrawals[0]._id);
    expect(waiting.providerStatus).toBe('pending');
    expect(waiting.needsAttention).toBe(false);

    sim.approve(sim.withdrawals[0]._id);
    await ctx.db.execute(
      sql`UPDATE transactions SET provider_submitted_at = now() - interval '5 minutes' WHERE id = ${txId}`,
    );
    sim.calls.length = 0;
    await payouts.reconcile('threepay');
    expect((await row(txId)).state).toBe('success');
    expect(sim.payoutRequests).toHaveLength(1);
    // Read the way 3pay said to read one withdrawal: verify, by its record id.
    expect(sim.calls).toContain(
      `GET /transaction/verify?transactionId=${sim.withdrawals[0]._id}&type=withdrawal`,
    );
  });

  it('a payout the direct read cannot place is read from the withdrawal list instead', async () => {
    sim.autoWithdraw = false;
    sim.verifyReadsWithdrawals = false;
    const txId = await approvedWithdrawal('260');
    await payouts.submitApproved(txId);
    sim.approve(sim.withdrawals[0]._id);
    await ctx.db.execute(
      sql`UPDATE transactions SET provider_submitted_at = now() - interval '5 minutes' WHERE id = ${txId}`,
    );
    await payouts.reconcile('threepay');
    expect((await row(txId)).state).toBe('success');
  });

  it('rejected in 3pay’s dashboard: the client is refunded in full', async () => {
    sim.autoWithdraw = false;
    const txId = await approvedWithdrawal('250');
    const userId = (await row(txId)).userId;
    await payouts.submitApproved(txId);
    expect(await balance(userId)).toBe('750.00000000');

    sim.finish(sim.withdrawals[0]._id, 'rejected');
    await deliver({
      type: 'withdrawal',
      status: 'rejected',
      transactionId: sim.withdrawals[0]._id,
    });
    expect((await row(txId)).state).toBe('failure');
    expect(await balance(userId)).toBe('1000.00000000');
  });

  it('a 500 after 3pay recorded it: HELD, found in 3pay’s list, adopted — never sent twice', async () => {
    sim.nextWithdrawal.push('recorded-then-500');
    const first = await approvedWithdrawal('70');
    const twin = await approvedWithdrawal('70'); // same address, same amount
    await payouts.submitApproved(first);
    await payouts.submitApproved(twin); // waits: the fingerprint lock
    expect(sim.payoutRequests).toHaveLength(1);
    const held = await row(first);
    expect(held.providerPayoutId).toBeNull();
    expect(held.needsAttention).toBe(true);

    await payouts.reconcile('threepay');
    expect((await row(first)).providerPayoutId).toBe(sim.withdrawals[0]._id);
    // Adopted, the lock opens: the twin goes, once.
    expect(sim.payoutRequests).toHaveLength(2);
    expect((await row(twin)).state).toBe('success');
  });

  it('an answer lost on the wire is the same: held, then adopted', async () => {
    sim.nextWithdrawal.push('recorded-then-drop');
    const txId = await approvedWithdrawal('45');
    await payouts.submitApproved(txId);
    expect((await row(txId)).providerPayoutId).toBeNull();

    sim.finish(sim.withdrawals[0]._id, 'completed');
    await payouts.reconcile('threepay');
    await ctx.db.execute(
      sql`UPDATE transactions SET provider_submitted_at = now() - interval '5 minutes' WHERE id = ${txId}`,
    );
    threepay.forget(); // the list is read again, not from the last pass's page
    await payouts.reconcile('threepay');
    expect(sim.payoutRequests).toHaveLength(1);
    expect((await row(txId)).state).toBe('success');
  });

  it('a lost payout is adopted from the guide’s list too (the destination under another name)', async () => {
    sim.shape = 'guide';
    sim.nextWithdrawal.push('recorded-then-500');
    const txId = await approvedWithdrawal('35');
    await payouts.submitApproved(txId);
    await payouts.reconcile('threepay');
    expect((await row(txId)).providerPayoutId).toBe(sim.withdrawals[0]._id);
  });

  it('refused before broadcast (400): a person decides, nothing is held', async () => {
    sim.nextWithdrawal.push('reject-400');
    const txId = await approvedWithdrawal('60');
    await payouts.submitApproved(txId);
    const refused = await row(txId);
    expect(refused.providerSubmittedAt).toBeNull();
    expect(refused.needsAttention).toBe(true);
    expect(refused.attentionReason).toMatch(/Insufficient balance/);
    expect(bell.notifyAdmins).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'withdrawal.payout_submit_failed' }),
    );
  });

  it('a 429 requeues it — never an attention row — and it goes once 3pay allows', async () => {
    sim.nextWithdrawal.push('rate-429');
    const txId = await approvedWithdrawal('20');
    await payouts.submitApproved(txId);
    const waiting = await row(txId);
    expect(waiting.providerSubmittedAt).toBeNull();
    expect(waiting.needsAttention).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 1100)); // 3pay's Retry-After: 1
    await payouts.reconcile('threepay');
    expect((await row(txId)).state).toBe('success');
  });

  it('paid to ANOTHER wallet (3pay’s forced cold-wallet route): never told "paid" — a person’s', async () => {
    sim.forceRouteTo = COLD_WALLET;
    const txId = await approvedWithdrawal('900');
    await payouts.submitApproved(txId);
    const flagged = await row(txId);
    expect(flagged.state).toBe('approved');
    expect(flagged.needsAttention).toBe(true);
    expect(flagged.attentionReason).toMatch(/did NOT receive it/);
    expect(bell.notify).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'withdrawal.paid' }),
      expect.anything(),
    );
  });

  it('3pay’s fee went up: settled (it left), and flagged — the client is short', async () => {
    sim.fees['USDT-TRC20'] = '3.00';
    const txId = await approvedWithdrawal('100');
    await payouts.submitApproved(txId);
    const paid = await row(txId);
    expect(paid.state).toBe('success');
    expect(paid.needsAttention).toBe(true);
    expect(paid.attentionReason).toMatch(/1 USD short/);
  });

  it('several payouts in flight cost ONE read of 3pay’s list, not one each', async () => {
    sim.autoWithdraw = false;
    const ids = [
      await approvedWithdrawal('210'),
      await approvedWithdrawal('220'),
      await approvedWithdrawal('230'),
    ];
    for (const id of ids) await payouts.submitApproved(id);
    await ctx.db.execute(sql`
      UPDATE transactions SET provider_submitted_at = now() - interval '5 minutes'
       WHERE provider_code = 'threepay' AND state = 'approved'`);
    for (const withdrawal of sim.withdrawals) sim.approve(withdrawal._id);
    sim.calls.length = 0;
    await payouts.reconcile('threepay');
    expect(sim.calls.filter((call) => call.startsWith('GET /withdrawal-requests'))).toHaveLength(1);
    expect(sim.calls.filter((call) => call.includes('type=withdrawal'))).toHaveLength(0);
    for (const id of ids) expect((await row(id)).state).toBe('success');
  });

  it('a mistyped address never reaches 3pay', async () => {
    const userId = await client('100');
    await expect(
      transactions.requestWithdrawal({
        userId,
        amount: '10',
        currency: 'USD',
        destination: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSF',
        methodKey: 'usdt_trc20_out',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(sim.payoutRequests).toHaveLength(0);
  });
});

describe('what 3pay holds that nothing here explains', () => {
  it('a payout made by hand in 3pay’s dashboard is raised; ours is not; a person acknowledges it', async () => {
    const txId = await approvedWithdrawal('15');
    await payouts.submitApproved(txId);
    const ours = sim.withdrawals[0];
    ours.createdAt = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    const manual = sim.manualWithdrawal('500', COLD_WALLET, new Date(Date.now() - 3 * 60 * 60_000));
    await ctx.db
      .update(paymentProviders)
      .set({ recordsAuditedUntil: new Date(Date.now() - 4 * 60 * 60_000) })
      .where(eq(paymentProviders.code, 'threepay'));

    threepay.forget();
    await records.run(adapter);
    const open = await records.list('threepay', true);
    expect(open.map((r) => r.providerId)).toEqual([manual._id]);
    expect(open[0].amount).toBe('500.00000000');
    expect(open[0].counterparty).toBe(COLD_WALLET);

    await records.acknowledge(
      'threepay',
      open[0].id,
      { id: ADMIN, email: 'desk@oxshare.test', permissions: ['payments.providers.edit'] },
      'Treasury sweep',
    );
    expect(await records.list('threepay', true)).toEqual([]);
    const { rows } = await ctx.db.execute<{ n: number }>(
      sql`SELECT count(*)::int AS n FROM audit_log WHERE action = 'payment_provider.record_acknowledge'`,
    );
    expect(rows[0].n).toBe(1);
  });

  it('the audit waits until there is half an hour of records to judge: no request before then', async () => {
    await ctx.db
      .update(paymentProviders)
      .set({ recordsAuditedUntil: new Date(Date.now() - 2 * 60 * 60_000 - 5 * 60_000) })
      .where(eq(paymentProviders.code, 'threepay'));
    sim.calls.length = 0;
    await records.run(adapter);
    expect(sim.calls).toEqual([]);
  });
});

describe('3pay’s minimum (1 USDT, guide §05)', () => {
  it('is refused at the deposit door, the withdrawal door and on a method, below 1', async () => {
    const userId = await client('1000');
    await expect(
      transactions.requestDeposit({
        userId,
        amount: '0.5',
        currency: 'USD',
        method: 'usdt_trc20_in',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      transactions.requestWithdrawal({
        userId,
        amount: '0.99',
        currency: 'USD',
        destination: TRON,
        methodKey: 'usdt_trc20_out',
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(sim.createRequests).toEqual([]);
    expect(sim.payoutRequests).toEqual([]);
  });
});

describe('the connection test', () => {
  it('says how the account is set, and reads both lists so an unreadable reply is found by a person', async () => {
    sim.autoWithdraw = false;
    sim.withdrawalFeePayer = 'merchant';
    const check = await adapter.testConnection();
    expect(check.ok).toBe(true);
    expect(check.message).toMatch(/Available: 10000 USDT/);
    expect(check.message).toMatch(/every one waits for approval in 3pay’s dashboard/);
    expect(check.message).toMatch(/added to each payout, so the client receives exactly/);
    expect(check.message).toMatch(/withdrawal fee payer to "user"/);
    // The limits are 3pay's own words on these very calls; a kind not called yet is said so.
    expect(check.message).toMatch(/100 status checks per 15 minutes \(97 left now\)/);
    expect(check.message).toMatch(/payment links not stated yet/);
    expect(sim.calls.map((call) => call.split('?')[0])).toEqual([
      'GET /getMerchantDetails',
      'GET /transaction/list',
      'GET /withdrawal-requests',
    ]);
  });

  it('a refused address or key is said plainly', async () => {
    sim.ipBlocked = true;
    const check = await adapter.testConnection();
    expect(check.ok).toBe(false);
    expect(check.message).toMatch(/IP Whitelist/);
  });
});

describe('the exchange log (guide §10: every request and response, 90 days)', () => {
  it('keeps every call and delivery with our reference — never a credential or a signature', async () => {
    const { tx } = await deposit('100');
    sim.confirm(tx.providerPaymentId!, '100');
    const { signature } = sim.webhook(confirmed(tx));
    await deliver(confirmed(tx));
    await adapter.balance();
    // Kept off the money path, so written a moment later.
    await vi.waitFor(async () => {
      const rows = await exchanges.list('threepay', 50);
      expect(
        rows.some((r) => r.direction === 'inbound' && r.reference === tx.providerPaymentId),
      ).toBe(true);
      expect(
        rows.some(
          (r) => r.path.startsWith('/transaction/create') && r.reference === tx.providerRef,
        ),
      ).toBe(true);
      expect(rows.some((r) => r.path.startsWith('/getMerchantDetails') && r.status === 200)).toBe(
        true,
      );
    });

    const rows = await exchanges.list('threepay', 50);
    const create = rows.find((r) => r.path.startsWith('/transaction/create'));
    expect(create?.method).toBe('POST');
    expect(create?.status).toBe(200);
    expect(create?.reference).toBe(tx.providerRef);
    expect(create?.path).toMatch(/currencyType=USDT-TRC20&amount=100/);
    // What 3pay said it allows, kept with the call: its PDF guides print other limits.
    expect(create?.rateLimit).toBe(20);
    expect(create?.rateRemaining).toBe(19);
    expect(create?.rateResetSeconds).toBeGreaterThan(0);
    expect(create?.rateWindowSeconds).toBe(900);
    const inbound = rows.find((r) => r.direction === 'inbound');
    expect(inbound?.reference).toBe(tx.providerPaymentId);
    expect(inbound?.status).toBe(200);
    const everything = JSON.stringify(rows);
    expect(everything).not.toContain(sim.apiSecret);
    expect(everything).not.toContain(signature);
    // 3pay's account reply carries its webhook secret and its owner's contact details.
    expect(everything).not.toContain(sim.webhookSecret);
    expect(everything).not.toContain('owner@merchant.test');
    const account = rows.find((r) => r.path.startsWith('/getMerchantDetails'));
    expect(account?.responseBody).toMatch(/"totalAmt":/);
  });

  it('is append-only until its 90 days are up; the prune removes only what is older', async () => {
    const [latest] = await exchanges.list('threepay', 1);
    await expect(
      ctx.db.execute(sql`UPDATE payment_provider_exchanges SET status = 1 WHERE id = ${latest.id}`),
    ).rejects.toThrow();
    await expect(
      ctx.db.execute(sql`DELETE FROM payment_provider_exchanges WHERE id = ${latest.id}`),
    ).rejects.toThrow();
    await ctx.db.execute(sql`
      INSERT INTO payment_provider_exchanges (provider_code, direction, method, path, occurred_at)
      VALUES ('threepay', 'outbound', 'GET', '/old', now() - interval '100 days')`);
    expect(await exchanges.prune()).toBe(1);
    expect((await exchanges.list('threepay', 1))[0].id).toBe(latest.id);
  });
});
