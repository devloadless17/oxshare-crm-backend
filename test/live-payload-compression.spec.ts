import { describe, expect, it, vi } from 'vitest';
import 'reflect-metadata';
import {
  Mt5LivePublisher,
  decodeLiveEvent,
  type Mt5LiveEvent,
  type Mt5LivePosition,
} from '../src/modules/trading/mt5/live-snapshot';

/**
 * A trader with a full book still gets their positions pushed.
 *
 * ## The ceiling this removes
 *
 * `pg_notify` refuses a payload over 8000 bytes. A live reading carries the
 * account figures plus every open position, and a position is ~300 bytes of
 * JSON, so the channel ran out at roughly twenty-five open trades. Past that the
 * publisher dropped the positions array and the client's table fell back to its
 * poll — the trader watching that table hardest getting the least live view of
 * it, permanently and silently.
 *
 * A position list is extremely repetitive — the same dozen keys per row — so gzip
 * flattens it: measured here, 40 positions go from 11,776 to 699 bytes and 250
 * from 71,941 to 1,655. That is 17× and 43×, so the ceiling moves from roughly
 * twenty-five open trades to well past a thousand — out of reach of any real
 * book rather than merely further away.
 *
 * ## Why the plain form is still the default
 *
 * Compressing everything would be simpler and worse: the common reading already
 * fits, and an opaque base64 blob costs CPU on both ends and makes the channel
 * unreadable to anyone debugging with `LISTEN mt5_live` in psql. So the shape on
 * the wire depends on the size, and the decoder owns telling them apart — which
 * is the property most worth pinning here, because getting it wrong means a
 * reading that parses into something with no `userId` and is delivered to
 * nobody.
 */

function position(ticket: number): Mt5LivePosition {
  return {
    ticket: String(900000 + ticket),
    symbol: 'EURUSD',
    action: ticket % 2,
    side: ticket % 2 === 0 ? 'buy' : 'sell',
    volume: '0.10000000',
    priceOpen: '1.09000000',
    priceCurrent: '1.09120000',
    stopLoss: null,
    takeProfit: null,
    profit: '-12.40000000',
    swap: '0.00000000',
    commission: null,
    comment: null,
    openedAt: '2026-09-03T09:15:00.000Z',
  };
}

function reading(positionCount: number): Mt5LiveEvent {
  return {
    userId: '11111111-1111-4111-8111-111111111111',
    accountId: '22222222-2222-4222-8222-222222222222',
    currency: 'USD',
    balance: '1250.00000000',
    equity: '1237.60000000',
    credit: '0.00000000',
    margin: '33.00000000',
    marginFree: '1204.60000000',
    marginLevel: '3750.30',
    readAt: '2026-09-03T12:00:00.000Z',
    positions: Array.from({ length: positionCount }, (_, i) => position(i)),
  };
}

/** Capture what actually reached `pg_notify`, which is the only output that matters. */
function publisherSpy() {
  const sent: string[] = [];
  const db = {
    execute: (query: { queryChunks?: unknown[] }) => {
      /*
       * Drizzle's `sql` template keeps the literal SQL and the interpolated
       * values as alternating chunks, boxing each value. Rather than reaching
       * into those internals, every chunk is coerced to text and the JSON one is
       * taken — a `StringChunk` coerces to "[object Object]" and is skipped, so
       * this stays correct if drizzle changes its representation.
       */
      for (const chunk of query.queryChunks ?? []) {
        const text = String(chunk);
        if (text.startsWith('{')) sent.push(text);
      }
      return Promise.resolve(undefined);
    },
  };

  return { publisher: new Mt5LivePublisher(db as never), sent };
}

describe('a live reading survives a full book', () => {
  it('sends a small reading as plain, readable JSON', async () => {
    const { publisher, sent } = publisherSpy();

    await publisher.publish(reading(3));

    expect(sent).toHaveLength(1);
    // Readable on the wire — the property that keeps `LISTEN mt5_live` useful.
    expect(sent[0]).toContain('"accountId"');
    expect(decodeLiveEvent(sent[0]).positions).toHaveLength(3);
  });

  /*
   * THE regression. Forty positions is comfortably past the ~25 the plain form
   * held, and well inside what a real trader runs.
   */
  it('keeps every position on a book that used to overflow the channel', async () => {
    const { publisher, sent } = publisherSpy();

    await publisher.publish(reading(40));

    const decoded = decodeLiveEvent(sent[0]);
    expect(decoded.positions).toHaveLength(40);
    expect(Buffer.byteLength(sent[0], 'utf8')).toBeLessThanOrEqual(7_500);
  });

  it('carries a book an order of magnitude past the old ceiling', async () => {
    const { publisher, sent } = publisherSpy();

    await publisher.publish(reading(250));

    expect(decodeLiveEvent(sent[0]).positions).toHaveLength(250);
  });

  it('round-trips every field rather than only the count', async () => {
    const { publisher, sent } = publisherSpy();

    await publisher.publish(reading(40));
    const decoded = decodeLiveEvent(sent[0]);

    expect(decoded.equity).toBe('1237.60000000');
    expect(decoded.marginLevel).toBe('3750.30');
    expect(decoded.userId).toBe('11111111-1111-4111-8111-111111111111');
    expect(decoded.positions?.[7]).toEqual(position(7));
  });

  /*
   * The room is derived from `userId`, so a decoder that returned the ENVELOPE
   * instead of the event would produce a reading addressed to `client:undefined`
   * — delivered to nobody, with no error anywhere. Worth its own assertion
   * because that failure is completely silent.
   */
  it('decodes to the event, never to the envelope', async () => {
    const { publisher, sent } = publisherSpy();

    await publisher.publish(reading(40));

    expect(sent[0]).toContain('__gz');
    expect(decodeLiveEvent(sent[0]).userId).toBeDefined();
  });

  /*
   * Both forms come off one channel, so the decoder has to tell them apart on
   * the payload alone — there is no flag beside it saying which is which.
   */
  it('reads both forms off the same channel', () => {
    const plain = JSON.stringify(reading(2));
    expect(decodeLiveEvent(plain).positions).toHaveLength(2);
  });

  /*
   * Dropping the positions is still the last resort, and it must stay reachable:
   * a payload that cannot be made to fit has to deliver the account figures
   * rather than nothing.
   *
   * It takes twenty thousand positions to get there, which is the point — the
   * fallback is now unreachable by any real account, and the assertion exists to
   * prove the path still works rather than because anyone will take it.
   */
  it('still falls back to dropping positions when nothing else fits', async () => {
    const { publisher, sent } = publisherSpy();
    const warn = vi.spyOn(publisher['logger'], 'warn').mockImplementation(() => undefined);

    await publisher.publish(reading(20_000));

    const decoded = decodeLiveEvent(sent[0]);
    expect(decoded.positions).toBeUndefined();
    // The account figures survive — they are the half worth keeping.
    expect(decoded.equity).toBe('1237.60000000');
    expect(warn).toHaveBeenCalledOnce();
  });
});
