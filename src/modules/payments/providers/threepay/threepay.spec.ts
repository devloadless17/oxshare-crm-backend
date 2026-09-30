import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ProviderBusyError } from '../payment-provider';
import { evmAddressIssue, evmAddressKey, tronAddressIssue } from './threepay-address';
import { amountOf, bodyWithAmount, countOf, parseLossless } from './threepay-json';
import { SlidingWindowLimit } from './threepay-rate-limit';
import { retryAfterMs } from './threepay.client';
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
  const secret = 'sk_live_test_secret';
  const raw = Buffer.from('{"type":"deposit","status":"confirmed","invoiceNo":"INV-1"}');
  const sign = (body: Buffer, key = secret) => createHmac('sha256', key).update(body).digest('hex');

  it('verifies the HMAC of the RAW bytes, in either hex case', () => {
    expect(signatureProblem(raw, sign(raw), secret)).toBeNull();
    expect(signatureProblem(raw, sign(raw).toUpperCase(), secret)).toBeNull();
  });

  it('refuses a missing, malformed, forged or tampered delivery', () => {
    expect(signatureProblem(raw, undefined, secret)).toMatch(/no x-3pay-signature/);
    expect(signatureProblem(raw, 'sha256=abc', secret)).toMatch(/malformed/);
    expect(signatureProblem(raw, sign(raw, 'another-secret'), secret)).toMatch(/does not match/);
    const tampered = Buffer.from(raw.toString().replace('INV-1', 'INV-2'));
    expect(signatureProblem(tampered, sign(raw), secret)).toMatch(/does not match/);
  });
});

describe('what a delivery asks the core to re-read (the doorbell)', () => {
  it('a final deposit rings for its invoice; an unfinished one rings nothing', () => {
    expect(noticesOf({ type: 'deposit', status: 'confirmed', invoiceNo: 'INV-1' })).toEqual([
      expect.objectContaining({ subject: 'payment', providerId: 'INV-1', kind: 'status' }),
    ]);
    expect(noticesOf({ type: 'deposit', status: 'pending', invoiceNo: 'INV-1' })).toEqual([]);
    // A word nobody documented still rings: the re-read decides.
    expect(noticesOf({ type: 'deposit', status: 'partial', invoiceNo: 'INV-1' })).toHaveLength(1);
  });

  it('a payout rings for its withdrawal id', () => {
    expect(
      noticesOf({ type: 'payout', status: 'completed', transactionId: 'W1', invoiceNo: 'WD-1' }),
    ).toEqual([expect.objectContaining({ subject: 'payout', providerId: 'W1', kind: 'status' })]);
    expect(noticesOf({ type: 'payout', status: 'executing', transactionId: 'W1' })).toEqual([]);
  });

  it('a refund rings both: the payout re-read, the deposit as an ALARM', () => {
    const notices = noticesOf({ type: 'refund', transactionId: 'X1', invoiceNo: 'INV-9' });
    expect(notices).toEqual([
      expect.objectContaining({ subject: 'payout', providerId: 'X1', kind: 'status' }),
      expect.objectContaining({ subject: 'payment', providerId: 'INV-9', kind: 'alarm' }),
    ]);
    expect(noticesOf({ type: 'mystery', transactionId: 'X1' })).toEqual([]);
  });
});

describe('3pay’s request limits, kept on our side', () => {
  it('refuses at once — before sending — when a slot is further away than the caller can wait', async () => {
    let now = 0;
    const limit = new SlidingWindowLimit(
      2,
      () => now,
      (ms) => {
        now += ms;
        return Promise.resolve();
      },
    );
    await limit.take(0);
    await limit.take(0);
    await expect(limit.take(0)).rejects.toBeInstanceOf(ProviderBusyError);
    // A caller that can wait the minute out gets the slot.
    await expect(limit.take(60_000)).resolves.toBeUndefined();
    limit.pause(30_000);
    await expect(limit.take(1_000)).rejects.toBeInstanceOf(ProviderBusyError);
  });

  it('reads Retry-After in seconds or as a date, bounded', () => {
    expect(retryAfterMs('20')).toBe(20_000);
    expect(retryAfterMs(null)).toBe(60_000);
    expect(retryAfterMs('0')).toBe(1_000);
    expect(retryAfterMs('999999')).toBe(600_000);
    const now = Date.parse('2026-09-30T12:00:00Z');
    expect(retryAfterMs('Wed, 30 Sep 2026 12:00:45 GMT', now)).toBe(45_000);
  });
});
