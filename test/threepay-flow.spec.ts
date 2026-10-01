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
 * 3PAY, END TO END against its simulator (0174): the REAL adapter, client,
 * settings and webhook receiver, through the REAL payments core, on real
 * Postgres. 3pay has no sandbox; this is every documented behaviour and
 * failure short of real money (the owner's live test is in the runbook).
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
  adapter = new ThreePayPaymentProvider(new ThreePayClient(settings, config, exchanges), settings);
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
    [new ThreePayWebhookReceiver(settings)],
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
    VALUES ('usdt_trc20_out', 'USDT (TRC20)', 'USDT TRC20 out', true, 'threepay', 'usdt_trc20')
    ON CONFLICT (key) DO NOTHING`);
}, 120_000);

afterAll(async () => {
  await sim.stop();
  await stopMoneyTestDb(ctx);
});

beforeEach(async () => {
  vi.clearAllMocks();
  sim.reset();
  settings.invalidate();
  // Earlier cases' open payouts must not wait behind, or be swept into, this one.
  await ctx.db.execute(sql`
    UPDATE transactions SET state = 'failure', payout_fingerprint = NULL
     WHERE provider_code = 'threepay' AND state IN ('pending', 'approved')`);
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
function deliver(payload: Record<string, unknown>, secret?: string) {
  const { body, signature } = sim.webhook(payload, secret);
  return ingress.receive('threepay', body, (name) =>
    name === 'x-3pay-signature' ? signature : undefined,
  );
}

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

async function approvedWithdrawal(amount = '100', destination = TRON): Promise<string> {
  const userId = await client('1000');
  const requested = await transactions.requestWithdrawal({
    userId,
    amount,
    currency: 'USD',
    destination,
    methodKey: 'usdt_trc20_out',
  });
  await transactions.approve(requested.id, ADMIN, { awaitsProviderPayout: true });
  return requested.id;
}

describe('3pay deposits', () => {
  it('opens a link for exactly the amount, on the method’s network, with our reference', async () => {
    const { tx } = await deposit('100');
    expect(sim.createRequests[0]).toMatch(/^\{"amount":100,/);
    const invoice = sim.invoices[0];
    expect(invoice.currencyType).toBe('USDT-TRC20');
    expect(invoice.clientReference).toBe(tx.providerRef);
    expect(invoice.callbackUrl).toBe(
      'https://api.oxshare.test/v1/payments/providers/threepay/webhook',
    );
    expect(tx.providerPaymentId).toBe(invoice.invoiceNo);
    expect(tx.providerPaymentUrl).toMatch(/^https:\/\/pay\.3pa-y\.example\/checkout\//);
  });

  it('credits what 3pay’s API says ARRIVED — to the cent, rounded down, never a float', async () => {
    const { userId, tx } = await deposit('100');
    sim.confirm(tx.providerPaymentId ?? '', '99.999999');

    const answer = await deliver({
      type: 'deposit',
      status: 'confirmed',
      invoiceNo: tx.providerPaymentId,
      transactionId: 'dep-1',
      amount: 100,
    });
    expect(answer.status).toBe(200);
    const settled = await row(tx.id);
    expect(settled.state).toBe('success');
    expect(settled.amount).toBe('99.99000000');
    expect(settled.requestedAmount).toBe('100.00000000');
    expect(settled.providerAmountReceived).toBe('99.99999900');
    expect(await balance(userId)).toBe('99.99000000');

    // The same delivery again changes nothing (3pay retries; replays are free).
    expect(
      (await deliver({ type: 'deposit', status: 'confirmed', invoiceNo: tx.providerPaymentId }))
        .status,
    ).toBe(200);
    expect(await balance(userId)).toBe('99.99000000');
  });

  it('a delivery is only a doorbell: a signed "confirmed" 3pay’s API does not confirm credits nothing', async () => {
    const { userId, tx } = await deposit('100');
    const answer = await deliver({
      type: 'deposit',
      status: 'confirmed',
      invoiceNo: tx.providerPaymentId,
    });
    // 3pay's stored state has not caught up: retry, nothing credited.
    expect(answer.status).toBe(503);
    expect((await row(tx.id)).state).toBe('pending');
    expect(await balance(userId)).toBe('0.00000000');
  });

  it('refuses a forged delivery before reading it', async () => {
    const { tx } = await deposit('100');
    sim.confirm(tx.providerPaymentId ?? '', '100');
    const answer = await deliver(
      { type: 'deposit', status: 'confirmed', invoiceNo: tx.providerPaymentId },
      'not-the-secret',
    );
    expect(answer.status).toBe(401);
    expect((await row(tx.id)).state).toBe('pending');
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
    expect((await row(lost.id)).providerPaymentId).toBe(sim.invoices[0].invoiceNo);
  });
});

describe('3pay payouts', () => {
  it('grossed up by the fee: 3pay is asked 102.00 exactly, and the client receives their 100', async () => {
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

  it('202 executing: settled only when 3pay’s own list says completed (the webhook re-reads)', async () => {
    sim.nextWithdrawal.push('executing');
    const txId = await approvedWithdrawal('30');
    await payouts.submitApproved(txId);
    const sent = await row(txId);
    expect(sent.state).toBe('approved');
    expect(sent.providerPayoutId).toBe(sim.withdrawals[0]._id);

    sim.finish(sim.withdrawals[0]._id, 'completed');
    const answer = await deliver({
      type: 'payout',
      status: 'completed',
      transactionId: sim.withdrawals[0]._id,
    });
    expect(answer.status).toBe(200);
    expect((await row(txId)).state).toBe('success');
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
    await payouts.reconcile('threepay');
    expect(sim.payoutRequests).toHaveLength(1);
    expect((await row(txId)).state).toBe('success');
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

    await records.run(adapter);
    const open = await records.list('threepay', true);
    expect(open.map((r) => r.providerId)).toEqual([manual._id]);
    expect(open[0].amount).toBe('500.00000000');

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

describe('the exchange log (guide §10: every request and response, 90 days)', () => {
  it('keeps every call and delivery with our reference — never a credential or a signature', async () => {
    const { tx } = await deposit('100');
    sim.confirm(tx.providerPaymentId!, '100');
    const delivery = { type: 'deposit', status: 'confirmed', invoiceNo: tx.providerPaymentId };
    const { signature } = sim.webhook(delivery);
    await deliver(delivery);
    // Kept off the money path, so written a moment later.
    await vi.waitFor(async () => {
      const rows = await exchanges.list('threepay', 50);
      expect(
        rows.some((r) => r.direction === 'inbound' && r.reference === tx.providerPaymentId),
      ).toBe(true);
      expect(
        rows.some((r) => r.path === '/transaction/create' && r.reference === tx.providerRef),
      ).toBe(true);
    });

    const rows = await exchanges.list('threepay', 50);
    const create = rows.find((r) => r.path === '/transaction/create');
    expect(create?.method).toBe('POST');
    expect(create?.status).toBe(200);
    expect(create?.reference).toBe(tx.providerRef);
    expect(create?.requestBody).toMatch(/^\{"amount":100,/);
    const inbound = rows.find((r) => r.direction === 'inbound');
    expect(inbound?.reference).toBe(tx.providerPaymentId);
    expect(inbound?.status).toBe(200);
    const everything = JSON.stringify(rows);
    expect(everything).not.toContain(sim.apiSecret);
    expect(everything).not.toContain(signature);
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
