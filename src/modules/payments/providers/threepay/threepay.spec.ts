import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ProviderBusyError } from '../payment-provider';
import { evmAddressIssue, evmAddressKey, tronAddressIssue } from './threepay-address';
import { amountOf, bodyWithAmount, countOf, loggableBody, parseLossless } from './threepay-json';
import { RequestBudget, budgetReadingOf } from './threepay-rate-limit';
import { retryAfterMs } from './threepay.client';
import { arrivedOf, isProvidersPage } from './threepay.provider';
import { noticesOf, signatureProblem } from './threepay-webhook.receiver';

/**
 * 3PAY'S TRANSLATION, the parts that decide money without a network (0174):
 * where a payout may go, what an amount is, whose webhook it is, and what a
 * delivery asks the core to re-read. The engine behaviour runs against the
 * simulator in `test/threepay-flow.spec.ts`.
 */

describe('where a USDT payout may go', () => {
  // Real Base58Check addresses (3pay's guide's own examples).
  const TRON = 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE';

  it('accepts a real TRC20 address and refuses one mistyped character', () => {
    expect(tronAddressIssue(TRON)).toBeUndefined();
    expect(tronAddressIssue(`  ${TRON} `)).toBeUndefined();
    expect(tronAddressIssue('TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSF')).toMatch(/not a valid TRC20/);
    expect(tronAddressIssue('TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLS')).toMatch(/34 characters/);
    expect(tronAddressIssue('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed')).toMatch(/starts with T/);
  });

  it('refuses the addresses money is certainly lost at', () => {
    expect(tronAddressIssue('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')).toMatch(/token contract/);
    expect(tronAddressIssue('T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb')).toMatch(/zero address/);
    expect(evmAddressIssue('0xdAC17F958D2ee523a2206206994597C13D831ec7')).toMatch(/token contract/);
    expect(evmAddressIssue('0xdac17f958d2ee523a2206206994597c13d831ec7')).toMatch(/token contract/);
    expect(evmAddressIssue(`0x${'0'.repeat(40)}`)).toMatch(/zero address/);
  });

  it('holds an ERC20 address to its EIP-55 checksum when it carries one', () => {
    const checksummed = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
    expect(evmAddressIssue(checksummed)).toBeUndefined();
    // No checksum claimed: all lower case, or all upper.
    expect(evmAddressIssue(checksummed.toLowerCase())).toBeUndefined();
    expect(evmAddressIssue(`0x${checksummed.slice(2).toUpperCase()}`)).toBeUndefined();
    // One capital flipped: the checksum it claims does not match — mistyped.
    expect(evmAddressIssue('0x5AAeb6053F3E94C9b9A09f33669435E7Ef1BeAed')).toMatch(/checksum/);
    expect(evmAddressIssue('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAe')).toMatch(/40 letters/);
  });

  it('compares an EVM address case-blind, a Tron address exactly', () => {
    expect(evmAddressKey(' 0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed ')).toBe(
      '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed',
    );
  });
});

describe('3pay amounts are never floats', () => {
  it('reads every JSON number as the exact text 3pay sent', () => {
    const body = parseLossless(
      '{"amount": 12345678901234567.89, "fee": 2.00, "net": 0.1, "page": 3}',
    ) as Record<string, unknown>;
    expect(amountOf(body['amount'])).toBe('12345678901234567.89');
    expect(amountOf(body['fee'])).toBe('2');
    expect(amountOf(body['net'])).toBe('0.1');
    expect(countOf(body['page'])).toBe(3);
    expect(amountOf(undefined)).toBeUndefined();
    expect(amountOf('abc')).toBeUndefined();
  });

  it('sends an amount as an exact JSON number, the rest as strings', () => {
    const text = bodyWithAmount('102.00', { walletAddress: 'T"x', callbackUrl: undefined });
    expect(text).toBe('{"amount":102,"walletAddress":"T\\"x"}');
    expect(JSON.parse(text)).toEqual({ amount: 102, walletAddress: 'T"x' });
    expect(bodyWithAmount('0.10', {})).toBe('{"amount":0.1}');
    expect(() => bodyWithAmount('-5', {})).toThrow();
  });
});

describe('a 3pay webhook is 3pay’s only if its signature says so', () => {
  const apiSecret = 'sk_live_test_secret';
  const webhookSecret = 'whsec_account_secret';
  const keys = { webhookSecrets: [webhookSecret], apiSecret };
  const raw = Buffer.from('{"type":"deposit","status":"confirmed","invoiceNo":"INV-1"}');
  const sign = (body: Buffer, key: string) => createHmac('sha256', key).update(body).digest('hex');

  it('verifies the HMAC of the RAW bytes under either documented scheme', () => {
    // Its online docs: `X-Webhook-Signature: sha256=<hex>`, the account's webhook secret.
    expect(
      signatureProblem(raw, { webhook: `sha256=${sign(raw, webhookSecret)}` }, keys),
    ).toBeNull();
    expect(
      signatureProblem(raw, { webhook: sign(raw, webhookSecret).toUpperCase() }, keys),
    ).toBeNull();
    // Its PDF guide: `x-3pay-signature: <hex>`, the API secret.
    expect(signatureProblem(raw, { legacy: sign(raw, apiSecret) }, keys)).toBeNull();
  });

  it('holds each header to its OWN key', () => {
    expect(signatureProblem(raw, { webhook: sign(raw, apiSecret) }, keys)).toMatch(
      /does not match/,
    );
    expect(signatureProblem(raw, { legacy: sign(raw, webhookSecret) }, keys)).toMatch(
      /does not match/,
    );
  });

  it('refuses a missing, malformed, forged or tampered delivery', () => {
    expect(signatureProblem(raw, {}, keys)).toMatch(/no signature header/);
    expect(signatureProblem(raw, { webhook: 'sha256=abc' }, keys)).toMatch(/malformed/);
    expect(signatureProblem(raw, { legacy: sign(raw, 'another-secret') }, keys)).toMatch(
      /does not match/,
    );
    const tampered = Buffer.from(raw.toString().replace('INV-1', 'INV-2'));
    expect(signatureProblem(tampered, { legacy: sign(raw, apiSecret) }, keys)).toMatch(
      /does not match/,
    );
    // No webhook secret known here: said so, because that is what an operator must fix.
    expect(
      signatureProblem(
        raw,
        { webhook: sign(raw, webhookSecret) },
        { webhookSecrets: [], apiSecret },
      ),
    ).toMatch(/webhook secret, which is not known here/);
  });
});

describe('what a delivery asks the core to re-read (the doorbell)', () => {
  it('a final deposit rings under BOTH its names; an unfinished one rings nothing', () => {
    // The live shape: the event under `data`, named by its transaction id.
    expect(
      noticesOf({
        success: true,
        data: { type: 'deposit', status: 'confirmed', transactionId: 'T-1', invoiceNo: 'INV-1' },
      }),
    ).toEqual([
      expect.objectContaining({
        subject: 'payment',
        providerId: 'T-1',
        otherIds: ['INV-1'],
        kind: 'status',
      }),
    ]);
    // The guide's shape, naming only the invoice.
    expect(noticesOf({ type: 'deposit', status: 'confirmed', invoiceNo: 'INV-1' })).toEqual([
      expect.objectContaining({ subject: 'payment', providerId: 'INV-1', kind: 'status' }),
    ]);
    expect(noticesOf({ type: 'deposit', status: 'pending', invoiceNo: 'INV-1' })).toEqual([]);
    expect(
      noticesOf({ data: { type: 'deposit', status: 'amount confirmed', transactionId: 'T-1' } }),
    ).toEqual([]);
    // A word nobody documented still rings: the re-read decides.
    expect(noticesOf({ type: 'deposit', status: 'partial', invoiceNo: 'INV-1' })).toHaveLength(1);
  });

  it('a payout rings for its withdrawal id, whichever word 3pay uses for it', () => {
    expect(
      noticesOf({ type: 'payout', status: 'completed', transactionId: 'W1', invoiceNo: 'WD-1' }),
    ).toEqual([expect.objectContaining({ subject: 'payout', providerId: 'W1', kind: 'status' })]);
    expect(
      noticesOf({ data: { type: 'withdrawal', status: 'rejected', transactionId: 'W1' } }),
    ).toEqual([expect.objectContaining({ subject: 'payout', providerId: 'W1' })]);
    expect(noticesOf({ type: 'payout', status: 'executing', transactionId: 'W1' })).toEqual([]);
    // Waiting for approval in 3pay's dashboard: nothing final to re-read.
    expect(
      noticesOf({ data: { type: 'withdrawal', status: 'pending', transactionId: 'W1' } }),
    ).toEqual([]);
  });

  it('a refund rings both: the payout re-read, the deposit as an ALARM', () => {
    const notices = noticesOf({ type: 'refund', transactionId: 'X1', invoiceNo: 'INV-9' });
    expect(notices).toEqual([
      expect.objectContaining({ subject: 'payout', providerId: 'X1', kind: 'status' }),
      expect.objectContaining({
        subject: 'payment',
        providerId: 'X1',
        otherIds: ['INV-9'],
        kind: 'alarm',
      }),
    ]);
    expect(noticesOf({ type: 'mystery', transactionId: 'X1' })).toEqual([]);
  });
});

describe('what ARRIVED on a deposit', () => {
  it('is the on-chain figure whenever 3pay states it', () => {
    expect(arrivedOf({ actualBalance: '40', amount: '100' }, false)).toBe('40');
    expect(arrivedOf({ actualBalance: '99.999999', amount: '100' }, true)).toBe('99.999999');
  });

  it('otherwise is the link’s amount only on a confirmed payment whose own sums agree', () => {
    expect(arrivedOf({ amount: '100', netAmount: '99', fee: '1' }, true)).toBe('100');
    expect(arrivedOf({ amount: '100' }, true)).toBe('100');
    // 3pay credited its merchant the net of 60, not of 100: nobody guesses.
    expect(arrivedOf({ amount: '100', netAmount: '59', fee: '1' }, true)).toBeUndefined();
    // Not confirmed: the link's amount says nothing about what came in.
    expect(arrivedOf({ amount: '100' }, false)).toBeUndefined();
  });
});

describe('a client is only ever sent to 3pay’s own page', () => {
  it('https, on the site the API is served from', () => {
    const api = 'https://pay.3pa-y.com/api/v1';
    expect(isProvidersPage('https://pay.3pa-y.com/s/abc', api)).toBe(true);
    expect(isProvidersPage('https://checkout.3pa-y.com/x', api)).toBe(true);
    expect(isProvidersPage('http://pay.3pa-y.com/s/abc', api)).toBe(false);
    expect(isProvidersPage('https://pay.3pa-y.com.evil.example/s/abc', api)).toBe(false);
    expect(isProvidersPage('https://evil.example/?u=pay.3pa-y.com', api)).toBe(false);
    expect(isProvidersPage('not a url', api)).toBe(false);
  });
});

describe('what the exchange log may keep', () => {
  it('cuts 3pay’s account reply down to the figures, and blanks a credential anywhere', () => {
    const account =
      '{"success":true,"data":{"name":"Owner","email":"o@x.test","totalAmt":12.50,' +
      '"pendingAmt":0,"autoWithdraw":false,"webhookSecret":"ce2a0e91"}}';
    const kept = loggableBody('/getMerchantDetails', account) ?? '';
    expect(kept).toContain('"totalAmt":12.50');
    expect(kept).toContain('"autoWithdraw":false');
    expect(kept).not.toMatch(/ce2a0e91|Owner|o@x\.test/);
    expect(loggableBody('/x', '{"a":1,"apiSecret":"s3cr3t","webhookSecret":"w"}')).toBe(
      '{"a":1,"apiSecret":"[removed]","webhookSecret":"[removed]"}',
    );
    expect(loggableBody('/x', '{"amount":100,"status":"confirmed"}')).toBe(
      '{"amount":100,"status":"confirmed"}',
    );
    expect(loggableBody('/x', null)).toBeNull();
  });
});

describe('3pay’s request limits, kept on our side', () => {
  it('refuses at once — before sending — when the window is spent, and opens again when it ends', () => {
    let now = 0;
    const budget = new RequestBudget(2, 900_000, { high: 0, normal: 0, low: 0 }, () => now);
    budget.take();
    budget.take();
    expect(() => budget.take()).toThrow(ProviderBusyError);
    now += 900_000;
    expect(() => budget.take()).not.toThrow();
  });

  it('background reads leave room for the ones money hangs on', () => {
    const budget = new RequestBudget(10, 900_000, { high: 0, normal: 2, low: 6 }, () => 0);
    for (let i = 0; i < 4; i += 1) budget.take('low');
    expect(() => budget.take('low')).toThrow(ProviderBusyError); // 6 are kept back
    for (let i = 0; i < 4; i += 1) budget.take('normal');
    expect(() => budget.take('normal')).toThrow(ProviderBusyError); // 2 are kept back
    budget.take('high');
    budget.take('high');
    expect(() => budget.take('high')).toThrow(ProviderBusyError);
  });

  it('a limit 3pay states differently scales what is kept back, and its window is followed', () => {
    // Built for 100 a quarter-hour; 3pay then states its guide's 60 a minute.
    const budget = new RequestBudget(100, 900_000, { high: 0, normal: 60, low: 75 }, () => 0);
    budget.observe({ limit: 60, remaining: 60, resetSeconds: 60, windowSeconds: 60 });
    expect(budget.state()).toMatchObject({ limit: 60, windowSeconds: 60, left: 60, stated: true });
    // `low` keeps back 45 of 60 (three quarters), not 75 of 60 — which would starve it for ever.
    for (let i = 0; i < 15; i += 1) budget.take('low');
    expect(() => budget.take('low')).toThrow(ProviderBusyError);
    // `normal` keeps back 36 of 60.
    for (let i = 0; i < 9; i += 1) budget.take('normal');
    expect(() => budget.take('normal')).toThrow(ProviderBusyError);
    expect(() => budget.take('high')).not.toThrow();
  });

  it('follows what 3pay’s own headers say is left', () => {
    let now = 0;
    const budget = new RequestBudget(100, 900_000, { high: 0, normal: 0, low: 0 }, () => now);
    budget.take();
    // Another process spent most of the window: 3pay says 3 are left for 10 more minutes.
    budget.observe({ limit: 100, remaining: 3, resetSeconds: 600 });
    expect(budget.left()).toBe(3);
    budget.take();
    budget.take();
    budget.take();
    expect(() => budget.take()).toThrow(/10 minutes/);
    now += 600_000;
    expect(budget.left()).toBe(100);
    // A 429 closes it for as long as 3pay said, whatever we counted.
    budget.pause(30_000);
    expect(() => budget.take()).toThrow(ProviderBusyError);
    now += 30_000;
    expect(() => budget.take()).not.toThrow();
  });

  it('reads the headers as counts, and ignores anything else', () => {
    const headers: Record<string, string> = {
      'ratelimit-limit': '100',
      'ratelimit-remaining': '96',
      'ratelimit-reset': '900',
    };
    expect(budgetReadingOf((name) => headers[name] ?? null)).toEqual({
      limit: 100,
      remaining: 96,
      resetSeconds: 900,
    });
    expect(budgetReadingOf(() => null)).toEqual({});
    expect(budgetReadingOf(() => 'soon')).toEqual({});
  });

  it('reads Retry-After in seconds or as a date, bounded', () => {
    expect(retryAfterMs('20')).toBe(20_000);
    expect(retryAfterMs(null)).toBe(60_000);
    expect(retryAfterMs('0')).toBe(1_000);
    expect(retryAfterMs('999999')).toBe(900_000);
    const now = Date.parse('2026-09-30T12:00:00Z');
    expect(retryAfterMs('Wed, 30 Sep 2026 12:00:45 GMT', now)).toBe(45_000);
  });
});
