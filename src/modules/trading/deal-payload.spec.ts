import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { DealShapeError, parseDeal, readDealsArray } from './deal-payload';

/**
 * The deal feed mints commission. `mt5-webhook.spec.ts` covers who is allowed to
 * post to it; this covers what they are allowed to post.
 *
 * The HMAC proves the batch came from our bridge. It says nothing about the
 * numbers inside, and before this the parsed body was cast rather than checked —
 * a compile-time assertion that erases at runtime.
 */

const VALID = {
  ticket: '900001',
  login: '500001',
  symbol: 'EURUSD',
  volume: '1.00',
  spread: '12.5',
  profit: '-40.25',
  opened_at: '2026-08-01T10:00:00.000Z',
  closed_at: '2026-08-01T10:30:00.000Z',
};

describe('deal payload shape', () => {
  it('accepts a well-formed deal and keeps money as the exact strings sent', () => {
    const deal = parseDeal(VALID);

    expect(deal.mt5Ticket).toBe('900001');
    expect(deal.volume).toBe('1.00');
    expect(deal.spread).toBe('12.5');
    expect(deal.profit).toBe('-40.25');
    expect(deal.closedAt.toISOString()).toBe('2026-08-01T10:30:00.000Z');
    // Not re-formatted, not normalised, not rounded. Whatever the bridge sent is
    // what reaches decimal.js.
    expect(typeof deal.volume).toBe('string');
  });

  /**
   * The finding that motivated the whole file.
   *
   * JSON has one number type and it is a float, so a monetary value sent as a
   * JSON number has already been destroyed by `JSON.parse` before any of our
   * code runs. decimal.js accepts a number without complaint, so the corrupted
   * figure would have accrued and been paid, and nothing downstream could
   * detect it — the original digits are gone by then.
   */
  it('refuses a monetary field sent as a JSON number, rather than coercing it', () => {
    const body = JSON.parse('{"profit": 12345678901234567.89}') as Record<string, unknown>;

    // Proof the damage is already done at parse time, not something we could fix.
    expect(new Decimal(body.profit as number).toFixed()).not.toBe('12345678901234567.89');

    expect(() => parseDeal({ ...VALID, profit: body.profit })).toThrow(DealShapeError);
    expect(() => parseDeal({ ...VALID, profit: body.profit })).toThrow(/must be a string/);
  });

  it('refuses volume and spread as numbers too', () => {
    for (const field of ['volume', 'spread'] as const) {
      expect(() => parseDeal({ ...VALID, [field]: 1.5 }), field).toThrow(DealShapeError);
    }
  });

  it('names the offending field, so the log says what to fix on the bridge', () => {
    try {
      parseDeal({ ...VALID, spread: 'wide' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(DealShapeError);
      expect((error as DealShapeError).field).toBe('spread');
    }
  });

  it('refuses more than 8 decimal places, which NUMERIC(28,8) would silently round', () => {
    expect(() => parseDeal({ ...VALID, volume: '1.123456789' })).toThrow(/8 decimal places/);
    expect(parseDeal({ ...VALID, volume: '1.12345678' }).volume).toBe('1.12345678');
  });

  it('refuses exponent notation even though decimal.js would accept it', () => {
    // Two spellings of one amount reaching the ledger makes an amount harder to
    // grep for during an investigation, and buys nothing.
    expect(new Decimal('1e5').toFixed()).toBe('100000');
    expect(() => parseDeal({ ...VALID, volume: '1e5' })).toThrow(DealShapeError);
  });

  /**
   * `ticket` is the UNIQUE(mt5_ticket) idempotency key. Past 2^53 a JSON number
   * is rounded, so two distinct deals can collapse onto one key — and the second
   * is swallowed as a duplicate. That is the "a lost deal is an unpaid partner"
   * failure arriving through the front door rather than through a network
   * partition.
   */
  it('refuses a ticket that cannot be represented exactly', () => {
    // Built by arithmetic, not written as a literal: `no-loss-of-precision`
    // rejects the literal outright, which is this whole file's point stated by
    // the linter — a number that cannot survive being written down cannot
    // survive being an idempotency key either.
    const unsafe = Number.MAX_SAFE_INTEGER + 2;
    expect(Number.isSafeInteger(unsafe)).toBe(false);
    expect(() => parseDeal({ ...VALID, ticket: unsafe })).toThrow(/idempotency key/);
  });

  it('still accepts a numeric ticket while it is exactly representable', () => {
    // The bridge contract says string, but real bridges send JSON numbers and
    // refusing a ticket we can represent perfectly would lose a payable deal.
    expect(parseDeal({ ...VALID, ticket: 900001 }).mt5Ticket).toBe('900001');
    expect(parseDeal({ ...VALID, login: 500001 }).mt5Login).toBe('500001');
  });

  it('rejects missing required fields instead of passing undefined downstream', () => {
    for (const field of ['ticket', 'login', 'symbol', 'volume', 'spread', 'closed_at'] as const) {
      const partial: Record<string, unknown> = { ...VALID };
      delete partial[field];
      expect(() => parseDeal(partial), field).toThrow(DealShapeError);
    }
  });

  it('rejects an unparseable timestamp', () => {
    expect(() => parseDeal({ ...VALID, closed_at: 'yesterday' })).toThrow(/parseable timestamp/);
  });

  it('treats a null optional as absent rather than as a rejection', () => {
    // The bridge emits null for "no open time recorded". Refusing the deal over
    // it would lose a payable trade for a non-problem.
    const deal = parseDeal({ ...VALID, profit: null, opened_at: null });
    expect(deal.profit).toBeUndefined();
    expect(deal.openedAt).toBeUndefined();
  });

  /**
   * Deliberately permissive, unlike the rest of the API. `forbidNonWhitelisted`
   * makes a typo'd key a loud 400 everywhere else, but the bridge is a system we
   * do not own and its contract may grow a field before we hear about it.
   * Refusing a batch over an additive change would lose deals to a non-problem.
   */
  it('tolerates unknown fields', () => {
    expect(() => parseDeal({ ...VALID, commissionHint: '3.00', swap: '0' })).not.toThrow();
  });

  it('rejects entries that are not objects', () => {
    for (const entry of [null, 'deal', 42, ['ticket']]) {
      expect(() => parseDeal(entry), JSON.stringify(entry)).toThrow(DealShapeError);
    }
  });
});

describe('batch envelope', () => {
  it('accepts a non-empty deals array without validating its entries', () => {
    // Entry validation is per-deal on purpose: one bad deal must not abort the
    // batch, so the caller catches each separately.
    expect(readDealsArray({ deals: [{ nonsense: true }] })).toHaveLength(1);
  });

  it('rejects a missing, empty or non-array deals field', () => {
    for (const body of [{}, { deals: [] }, { deals: 'one' }, null, 'body']) {
      expect(() => readDealsArray(body), JSON.stringify(body)).toThrow(DealShapeError);
    }
  });
});
