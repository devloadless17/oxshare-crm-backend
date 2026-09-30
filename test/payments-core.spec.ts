import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { ConfigService } from '@nestjs/config';
import { TransactionsService } from '../src/modules/payments/transactions.service';
import { PaymentMethodsService } from '../src/modules/payments/payment-methods.service';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { CurrenciesService } from '../src/modules/currencies/currencies.service';
import { AuditLogStore } from '../src/store/audit-log.store';
import { UsersStore } from '../src/store/users.store';
import { paymentMethods } from '../src/database/schema';
import { HostedDepositsService } from '../src/modules/payments/core/hosted-deposits.service';
import { PayoutEngine } from '../src/modules/payments/core/payout-engine.service';
import { ChannelSwitchesService } from '../src/modules/payments/core/channel-switches.service';
import { PaymentProviderRegistry } from '../src/modules/payments/providers/payment-provider-registry';
import { ManualPaymentProvider } from '../src/modules/payments/providers/manual/manual.provider';
import type {
  PaymentChannel,
  PaymentProviderAdapter,
  PaymentStatus,
  PayoutRail,
} from '../src/modules/payments/providers/payment-provider';
import type { EmailService } from '../src/modules/email/email.service';
import type { ResourceChangedPublisher } from '../src/common/realtime/resource-changed';
import { auditStubAs } from './audit-stub';
import { emailStub } from './email-stub';
import { notificationsStub } from './notifications-stub';
import { transferExecutorStubAs, transfersStubAs } from './transfer-chain-stub';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * THE PAYMENTS CORE, held to its promises with a provider that has none of
 * Rival's comforts (0173).
 *
 * `testpay` declares 3pay's hardest traits — a payout API with NO idempotency
 * key and NO reference, a `wait` policy when it cannot pay, USD-only channels
 * moving USDT at par, and deposits that credit what ARRIVED — without any
 * network. What is asserted is the CORE: the fingerprint lock, adoption,
 * "a person decides", the 429 requeue, the credit policies, the channel
 * switches, the currency door. The 3pay adapter's own translation is held by
 * its simulator spec; Rival's by `rival-*.spec.ts`.
 */

const USDT: PaymentChannel['asset'] = { code: 'USDT-TRC20', label: 'USDT on Tron (TRC20)' };
const ADDRESS = 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE';
const OTHER_ADDRESS = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

const rail = {
  idempotency: 'none' as const,
  cancellable: false,
  ratePerMinute: null,
  whenUnavailable: 'wait' as const,
  adoptWindowMs: 15 * 60_000,
  // The provider takes its 2.00 fee OUT of the amount: gross up, so the client
  // receives exactly what they asked for (the owner, 30 Sep 2026).
  quote: vi.fn((_channel: PaymentChannel, amount: string) =>
    Promise.resolve({ gross: new Decimal(amount).plus(2).toFixed(2), fee: '2.00', net: amount }),
  ),
  submit: vi.fn(),
  find: vi.fn(),
  read: vi.fn(),
};

const testpay = {
  code: 'testpay',
  name: 'TestPay',
  builtIn: false,
  configFields: [{ name: 'apiKey', label: 'API key', kind: 'secret' as const, required: true }],
  channels: [
    {
      code: 'usdt',
      direction: 'deposit',
      label: 'USDT',
      flow: 'redirect',
      settlementScale: 2,
      currencies: ['USD'],
      asset: USDT,
      bindable: true,
      creditPolicy: 'received',
      hostedPageReturns: false,
    },
    {
      code: 'usdt',
      direction: 'payout',
      label: 'USDT',
      flow: 'automated',
      settlementScale: 2,
      currencies: ['USD'],
      asset: USDT,
      bindable: true,
      destination: {
        kind: 'crypto_address',
        network: 'TRC20',
        label: 'TRC20 address',
        validate: (value: string) =>
          /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(value) ? undefined : 'Not a TRC20 address.',
      },
    },
  ] as PaymentChannel[],
  payouts: rail as unknown as PayoutRail,
  usable: true as boolean,
  isUsable() {
    return Promise.resolve(this.usable);
  },
  startPayment: vi.fn().mockResolvedValue({
    paymentUrl: 'https://pay.testpay.example/checkout/abc',
    externalId: 'INV-0',
  }),
  checkPayment: vi.fn(),
} satisfies PaymentProviderAdapter & { usable: boolean };

let ctx: MoneyTestContext;
let wallets: WalletService;
let transactions: TransactionsService;
let deposits: HostedDepositsService;
let payouts: PayoutEngine;
let switches: ChannelSwitchesService;
const bell = notificationsStub();
const email = emailStub();
const ADMIN = '00000000-0000-4000-8000-00000000c0de';
const DESK_ACTOR = {
  id: ADMIN,
  email: 'desk@oxshare.test',
  permissions: ['deposits.approve', 'deposits.reject'],
};

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  wallets = new WalletService(ctx.db);
  const currencies = new CurrenciesService(ctx.db, auditStubAs());
  const registry = new PaymentProviderRegistry([new ManualPaymentProvider(), testpay]);
  const methods = new PaymentMethodsService(ctx.db, currencies, auditStubAs(), registry);
  transactions = new TransactionsService(
    wallets,
    ctx.db,
    methods,
    currencies,
    registry,
    new ConfigService(),
    email as unknown as EmailService,
    bell,
    transfersStubAs(),
    transferExecutorStubAs(),
  );
  switches = new ChannelSwitchesService(ctx.db, registry);
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
    switches,
    transactions,
    new AuditLogStore(ctx.db),
    new UsersStore(ctx.db),
    email as unknown as EmailService,
    bell,
    { publish: vi.fn().mockResolvedValue(undefined) } as unknown as ResourceChangedPublisher,
    new ConfigService(),
  );

  await ctx.db.execute(sql`
    INSERT INTO currencies (code, name, symbol, enabled, is_default)
    VALUES ('USD', 'US Dollar', '$', true, true), ('EUR', 'Euro', '€', true, false)
    ON CONFLICT (code) DO NOTHING`);
  await ctx.db.execute(sql`
    INSERT INTO payment_providers (code, enabled) VALUES ('testpay', true)
    ON CONFLICT (code) DO NOTHING`);
  await ctx.db.execute(sql`
    INSERT INTO payment_methods (key, name, internal_label, currency, enabled, provider_code, channel_code)
    VALUES ('usdt_in', 'USDT (TRC20)', 'USDT in', 'USD', true, 'testpay', 'usdt')
    ON CONFLICT (key) DO NOTHING`);
  await ctx.db.execute(sql`
    INSERT INTO withdrawal_payment_methods (key, name, internal_label, enabled, provider_code, channel_code)
    VALUES ('usdt_out', 'USDT (TRC20)', 'USDT out', true, 'testpay', 'usdt')
    ON CONFLICT (key) DO NOTHING`);
}, 120_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

beforeEach(async () => {
  vi.clearAllMocks();
  testpay.usable = true;
  await ctx.db.execute(sql`DELETE FROM payment_provider_channels`);
  // Earlier cases' open payouts must not be swept into this one's counts.
  await ctx.db.execute(sql`
    UPDATE transactions SET state = 'failure', payout_fingerprint = NULL
     WHERE provider_code = 'testpay' AND state IN ('pending', 'approved')`);
});

let seq = 0;

async function client(fund = '1000', currency = 'USD'): Promise<number> {
  seq += 1;
  const { rows } = await ctx.db.execute<{ id: number }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name, verification_level, email_verified)
    VALUES (${`core-${seq}@spec.test`}, 'x', 'Core', 'Client', 1, true) RETURNING id`);
  const userId = rows[0].id;
  if (fund !== '0') {
    await wallets.post({
      userId,
      currency,
      amount: fund,
      entryType: 'deposit',
      referenceType: 'transaction',
      referenceId: `seed-${userId}-${currency}`,
    });
  }
  return userId;
}

async function balance(userId: number, currency = 'USD'): Promise<string> {
  const { rows } = await ctx.db.execute<{ balance: string }>(
    sql`SELECT balance FROM wallets WHERE user_id = ${userId} AND currency = ${currency}`,
  );
  return rows[0]?.balance ?? '0.00000000';
}

async function hostedDeposit(amount: string, invoice: string) {
  const userId = await client('0');
  testpay.startPayment.mockResolvedValueOnce({
    paymentUrl: `https://pay.testpay.example/checkout/${invoice}`,
    externalId: invoice,
  });
  const started = await transactions.requestDeposit({
    userId,
    amount,
    currency: 'USD',
    method: 'usdt_in',
  });
  return { userId, txId: started.id };
}

function provider(status: Partial<PaymentStatus>): void {
  testpay.checkPayment.mockResolvedValue({
    settled: true,
    paid: true,
    rawStatus: 'confirmed',
    needsAttention: false,
    currency: 'USDT-TRC20',
    ...status,
  });
}

async function row(txId: string) {
  return transactions.getById(txId);
}

describe('hosted deposits that credit what ARRIVED', () => {
  it('an underpayment credits what arrived, keeping what was asked', async () => {
    const { userId, txId } = await hostedDeposit('100', 'INV-under');
    provider({ amount: '90.00' });

    await deposits.settleRow(await row(txId), 'poll');

    const settled = await row(txId);
    expect(settled.state).toBe('success');
    expect(settled.amount).toBe('90.00000000');
    expect(settled.requestedAmount).toBe('100.00000000');
    expect(await balance(userId)).toBe('90.00000000');
  });

  it('rounds DOWN to the wallet’s places — never more than arrived', async () => {
    const { userId, txId } = await hostedDeposit('100', 'INV-round');
    provider({ amount: '99.999999' });

    await deposits.settleRow(await row(txId), 'poll');
    expect((await row(txId)).amount).toBe('99.99000000');
    expect((await row(txId)).providerAmountReceived).toBe('99.99999900');
    expect(await balance(userId)).toBe('99.99000000');
  });

  it('over the method’s maximum: credited AND flagged for a compliance look', async () => {
    await ctx.db
      .update(paymentMethods)
      .set({ ownMaxAmount: '200' })
      .where(eq(paymentMethods.key, 'usdt_in'));
    try {
      const { userId, txId } = await hostedDeposit('100', 'INV-big');
      provider({ amount: '250.00' });

      await deposits.settleRow(await row(txId), 'poll');
      const settled = await row(txId);
      expect(settled.state).toBe('success');
      expect(await balance(userId)).toBe('250.00000000');
      expect(settled.needsAttention).toBe(true);
      expect(bell.notifyAdmins).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'admin.deposit.attention',
          params: expect.objectContaining({ reason: 'over_limit' }) as unknown,
        }),
      );
    } finally {
      await ctx.db
        .update(paymentMethods)
        .set({ ownMaxAmount: null })
        .where(eq(paymentMethods.key, 'usdt_in'));
    }
  });

  it('the WRONG asset is never credited — a person decides', async () => {
    const { userId, txId } = await hostedDeposit('100', 'INV-asset');
    provider({ amount: '100.00', currency: 'USDT-ERC20' });

    await deposits.settleRow(await row(txId), 'poll');
    const flagged = await row(txId);
    expect(flagged.state).toBe('pending');
    expect(flagged.needsAttention).toBe(true);
    expect(await balance(userId)).toBe('0.00000000');
  });

  it('an EXPIRED link fails; a LATE confirmation is credited exactly once', async () => {
    const { userId, txId } = await hostedDeposit('100', 'INV-late');
    provider({ paid: false, expired: true, rawStatus: 'expired', amount: undefined });
    await deposits.settleRow(await row(txId), 'poll');
    expect((await row(txId)).state).toBe('failure');

    // The provider confirms it later — the money arrived.
    provider({ amount: '100.00' });
    await deposits.settleRow(await row(txId), 'poll');
    await deposits.settleRow(await row(txId), 'poll'); // the replay
    expect((await row(txId)).state).toBe('success');
    expect(await balance(userId)).toBe('100.00000000');

    const { rows } = await ctx.db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM audit_log
       WHERE subject_id = ${txId} AND action = 'deposit.settle_late'`);
    expect(rows[0].n).toBe(1);
  });

  it('money on a link the provider did NOT confirm: flagged, never credited, never failed', async () => {
    const { userId, txId } = await hostedDeposit('100', 'INV-unconfirmed');
    provider({ paid: false, expired: true, rawStatus: 'expired', amount: '50.00' });

    await deposits.settleRow(await row(txId), 'poll');
    const flagged = await row(txId);
    expect(flagged.state).toBe('pending');
    expect(flagged.needsAttention).toBe(true);
    expect(flagged.providerAmountReceived).toBe('50.00000000');
    expect(await balance(userId)).toBe('0.00000000');
  });

  it('the desk finishes a flagged deposit — credit what arrived, once', async () => {
    const { userId, txId } = await hostedDeposit('100', 'INV-desk-credit');
    provider({ paid: false, expired: true, rawStatus: 'expired', amount: '50.00' });
    await deposits.settleRow(await row(txId), 'poll');

    await deposits.creditReceived(txId, DESK_ACTOR, 'Confirmed on the provider dashboard.');
    const credited = await row(txId);
    expect(credited.state).toBe('success');
    expect(credited.needsAttention).toBe(false);
    expect(await balance(userId)).toBe('50.00000000');

    await expect(deposits.creditReceived(txId, DESK_ACTOR, 'twice')).rejects.toThrow(
      /unfinished deposit flagged/,
    );
    expect(await balance(userId)).toBe('50.00000000');
  });

  it('the desk finishes a flagged deposit — close without credit', async () => {
    const { userId, txId } = await hostedDeposit('100', 'INV-desk-close');
    provider({ amount: '100.00', currency: 'USDT-ERC20' });
    await deposits.settleRow(await row(txId), 'poll');

    await deposits.closeWithoutCredit(txId, DESK_ACTOR, 'Sent on the wrong network; refunded.');
    const closed = await row(txId);
    expect(closed.state).toBe('failure');
    expect(closed.needsAttention).toBe(false);
    expect(await balance(userId)).toBe('0.00000000');
  });

  it('a flagged deposit is never re-judged by the sweep (it used to re-page every run)', async () => {
    const { txId } = await hostedDeposit('100', 'INV-quiet');
    provider({ amount: '100.00', currency: 'USDT-ERC20' });
    await deposits.settleRow(await row(txId), 'poll');
    bell.notifyAdmins.mockClear();
    testpay.checkPayment.mockClear();

    await deposits.settleRow(await row(txId), 'poll');
    expect(testpay.checkPayment).not.toHaveBeenCalled();
    expect(bell.notifyAdmins).not.toHaveBeenCalled();
  });
});

describe('payouts on a provider with NO idempotency key and NO reference', () => {
  async function approved(amount = '100', destination = ADDRESS): Promise<string> {
    const userId = await client();
    const requested = await transactions.requestWithdrawal({
      userId,
      amount,
      currency: 'USD',
      destination,
      methodKey: 'usdt_out',
    });
    await transactions.approve(requested.id, ADMIN, { awaitsProviderPayout: true });
    return requested.id;
  }

  it('grosses up by the provider’s fee — the client receives exactly what they asked', async () => {
    const txId = await approved('100');
    rail.submit.mockResolvedValue({ outcome: 'accepted', payoutId: 'P-gross' });

    await payouts.submitApproved(txId);
    const request = rail.submit.mock.calls[0][1] as { amount: string; clientAmount: string };
    expect(request.amount).toBe('102.00');
    expect(request.clientAmount).toBe('100.00000000');
    expect((await row(txId)).providerRequestAmount).toBe('102.00000000');
  });

  it('THE FINGERPRINT LOCK: an identical payout waits while the first is unresolved', async () => {
    const first = await approved('100');
    const second = await approved('100');
    rail.submit.mockResolvedValueOnce({ outcome: 'unknown', reason: 'timeout' });

    await payouts.submitApproved(first); // held: it may exist
    await payouts.submitApproved(second); // same address, same amount → waits
    expect(rail.submit).toHaveBeenCalledTimes(1);
    expect((await row(second)).providerSubmittedAt).toBeNull();

    // The provider's list shows the first after all: adopted, and the second
    // is then free to go.
    rail.find.mockResolvedValue({ complete: true, candidates: ['P-found'] });
    rail.read.mockResolvedValue(new Map());
    rail.submit.mockResolvedValue({ outcome: 'accepted', payoutId: 'P-second' });
    await payouts.reconcile('testpay');

    expect((await row(first)).providerPayoutId).toBe('P-found');
    expect((await row(second)).providerPayoutId).toBe('P-second');
  });

  it('a DIFFERENT destination is not blocked by the lock', async () => {
    const first = await approved('100', ADDRESS);
    const second = await approved('100', OTHER_ADDRESS);
    rail.submit.mockResolvedValueOnce({ outcome: 'unknown', reason: 'timeout' });
    rail.submit.mockResolvedValueOnce({ outcome: 'accepted', payoutId: 'P-other' });

    await payouts.submitApproved(first);
    await payouts.submitApproved(second);
    expect(rail.submit).toHaveBeenCalledTimes(2);
  });

  it('a rate limit REQUEUES — never a pile of attention rows', async () => {
    const txId = await approved('100');
    rail.submit.mockResolvedValueOnce({
      outcome: 'refused',
      reason: 'Too many requests',
      retryAfterMs: 1000,
    });

    await payouts.submitApproved(txId);
    let current = await row(txId);
    expect(current.providerSubmittedAt).toBeNull();
    expect(current.needsAttention).toBe(false);
    expect(bell.notifyAdmins).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'withdrawal.payout_submit_failed' }),
    );

    rail.find.mockResolvedValue({ complete: true, candidates: [] });
    rail.submit.mockResolvedValue({ outcome: 'accepted', payoutId: 'P-requeued' });
    await payouts.reconcile('testpay');
    current = await row(txId);
    expect(current.providerPayoutId).toBe('P-requeued');
  });

  it('ABSENT after the window: the claim clears and a PERSON decides — never an automatic resend', async () => {
    const txId = await approved('100');
    rail.submit.mockResolvedValueOnce({ outcome: 'unknown', reason: 'no answer' });
    await payouts.submitApproved(txId);
    await ctx.db.execute(
      sql`UPDATE transactions SET provider_submitted_at = now() - interval '20 minutes'
           WHERE id = ${txId}`,
    );

    rail.find.mockResolvedValue({ complete: true, candidates: [] });
    await payouts.reconcile('testpay');
    const cleared = await row(txId);
    expect(cleared.providerSubmittedAt).toBeNull();
    expect(cleared.needsAttention).toBe(true);
    expect(bell.notifyAdmins).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'withdrawal.payout_submit_failed' }),
    );
    // The next sweep does NOT resend it: a person's.
    await payouts.reconcile('testpay');
    expect(rail.submit).toHaveBeenCalledTimes(1);

    // The person resends; the flag clears only when the provider accepts it.
    rail.submit.mockResolvedValue({ outcome: 'accepted', payoutId: 'P-resent' });
    await payouts.resubmit(txId);
    const resent = await row(txId);
    expect(resent.providerPayoutId).toBe('P-resent');
    expect(resent.needsAttention).toBe(false);
  });

  it('SEVERAL candidates: held and flagged — never a guess', async () => {
    const txId = await approved('100');
    rail.submit.mockResolvedValueOnce({ outcome: 'unknown', reason: 'no answer' });
    await payouts.submitApproved(txId);

    rail.find.mockResolvedValue({ complete: true, candidates: ['P-a', 'P-b'] });
    await payouts.reconcile('testpay');
    const held = await row(txId);
    expect(held.providerPayoutId).toBeNull();
    expect(held.providerSubmittedAt).not.toBeNull();
    expect(held.attentionReason).toMatch(/2 payouts/);
  });

  it('a payout the provider reports SHORT (its fee changed) settles, and is flagged', async () => {
    const txId = await approved('100');
    rail.submit.mockResolvedValue({
      outcome: 'accepted',
      payoutId: 'P-short',
      report: { payoutId: 'P-short', status: 'completed', rawStatus: 'completed', net: '99.50' },
    });

    await payouts.submitApproved(txId);
    const settled = await row(txId);
    expect(settled.state).toBe('success');
    expect(settled.needsAttention).toBe(true);
    expect(settled.attentionReason).toMatch(/0\.5 USD short/);
  });

  it('a payout the provider holds cannot be cancelled here — it cannot be recalled', async () => {
    const txId = await approved('100');
    rail.submit.mockResolvedValue({ outcome: 'accepted', payoutId: 'P-sent' });
    await payouts.submitApproved(txId);

    await expect(payouts.cancelApproved(await row(txId))).rejects.toThrow(/cannot be recalled/);
  });

  it('a provider that WAITS: switched off, its payouts are paused, hidden and refused', async () => {
    const txId = await approved('100');
    testpay.usable = false;

    expect(await payouts.decide(await row(txId))).toMatchObject({ kind: 'paused' });
    expect((await transactions.listWithdrawalMethods()).map((m) => m.key)).not.toContain(
      'usdt_out',
    );
    await expect(
      transactions.requestWithdrawal({
        userId: await client(),
        amount: '10',
        currency: 'USD',
        destination: ADDRESS,
        methodKey: 'usdt_out',
      }),
    ).rejects.toThrow(/not available/);
    await payouts.reconcile('testpay');
    expect(rail.submit).not.toHaveBeenCalled();
  });

  it('pays out only the wallet currencies its channel serves', async () => {
    const userId = await client('500', 'EUR');
    await expect(
      transactions.requestWithdrawal({
        userId,
        amount: '10',
        currency: 'EUR',
        destination: ADDRESS,
        methodKey: 'usdt_out',
      }),
    ).rejects.toThrow(/pays out USD only/);
  });
});

describe('channel switches — a network off, per direction', () => {
  const route = { providerCode: 'testpay', channelCode: 'usdt' };

  it('refuses to switch one off without a reason', async () => {
    await expect(switches.set(route, 'payout', false, '  ', ADMIN)).rejects.toThrow(/Say why/);
  });

  it('payouts off: hidden, refused, approval paused, the queue waits — and resumes', async () => {
    const userId = await client();
    const requested = await transactions.requestWithdrawal({
      userId,
      amount: '100',
      currency: 'USD',
      destination: ADDRESS,
      methodKey: 'usdt_out',
    });
    await transactions.approve(requested.id, ADMIN, { awaitsProviderPayout: true });

    await switches.set(route, 'payout', false, 'Tron congested', ADMIN);
    expect((await transactions.listWithdrawalMethods()).map((m) => m.key)).not.toContain(
      'usdt_out',
    );
    await expect(
      transactions.requestWithdrawal({
        userId,
        amount: '10',
        currency: 'USD',
        destination: ADDRESS,
        methodKey: 'usdt_out',
      }),
    ).rejects.toThrow(/not available/);
    const decision = await payouts.decide(await row(requested.id));
    expect(decision).toMatchObject({ kind: 'paused' });
    expect(decision.kind === 'paused' ? decision.reason : '').toMatch(/Tron congested/);

    rail.find.mockResolvedValue({ complete: true, candidates: [] });
    await payouts.reconcile('testpay');
    expect(rail.submit).not.toHaveBeenCalled();

    await switches.set(route, 'payout', true, null, ADMIN);
    rail.submit.mockResolvedValue({ outcome: 'accepted', payoutId: 'P-resumed' });
    await payouts.reconcile('testpay');
    expect((await row(requested.id)).providerPayoutId).toBe('P-resumed');
  });

  it('a payout already SENT still finishes while its network is off', async () => {
    const userId = await client();
    const requested = await transactions.requestWithdrawal({
      userId,
      amount: '100',
      currency: 'USD',
      destination: ADDRESS,
      methodKey: 'usdt_out',
    });
    await transactions.approve(requested.id, ADMIN, { awaitsProviderPayout: true });
    rail.submit.mockResolvedValue({ outcome: 'accepted', payoutId: 'P-inflight' });
    await payouts.submitApproved(requested.id);

    await switches.set(route, 'payout', false, 'maintenance', ADMIN);
    await ctx.db.execute(
      sql`UPDATE transactions SET provider_submitted_at = now() - interval '5 minutes'
           WHERE id = ${requested.id}`,
    );
    rail.read.mockResolvedValue(
      new Map([
        ['P-inflight', { payoutId: 'P-inflight', status: 'completed', rawStatus: 'completed' }],
      ]),
    );
    await payouts.reconcile('testpay');
    expect((await row(requested.id)).state).toBe('success');
  });

  it('deposits off: the method leaves the lists and is refused; a paid link still credits', async () => {
    const { userId, txId } = await hostedDeposit('100', 'INV-switch');
    await switches.set(route, 'deposit', false, 'maintenance', ADMIN);

    const methods = new PaymentMethodsService(
      ctx.db,
      new CurrenciesService(ctx.db, auditStubAs()),
      auditStubAs(),
      new PaymentProviderRegistry([new ManualPaymentProvider(), testpay]),
    );
    expect((await methods.listAvailable()).map((m) => m.key)).not.toContain('usdt_in');
    await expect(methods.assertUsable('usdt_in')).rejects.toThrow(/not currently available/);
    expect((await methods.listAllForAdmin()).find((m) => m.key === 'usdt_in')?.availability).toBe(
      'channel_off',
    );

    // Money already moving is never stranded by a switch.
    provider({ amount: '100.00' });
    await deposits.settleRow(await row(txId), 'poll');
    expect(await balance(userId)).toBe('100.00000000');
  });
});
