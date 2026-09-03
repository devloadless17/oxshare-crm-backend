import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'reflect-metadata';
import { Mt5LiveService } from '../src/modules/trading/mt5/mt5-live.service';
import type { Mt5LiveDto } from '../src/modules/trading/mt5/dto/mt5-live.dto';

/**
 * The live reading refreshes the balance mirror, without becoming a write storm.
 *
 * ## What this is worth
 *
 * The live loop re-reads a watched account every round, so it holds the freshest
 * balance in the system — and this path used to throw it away. The mirror behind
 * `/accounts`, the transfer picker and the admin console was fed only by a
 * five-minute balance sweep sitting behind a five-minute deal ingestion, so a
 * client could watch a live balance on one screen while the figure behind the
 * next was minutes old.
 *
 * Writing it through also skips the slower half of that chain: this is a BALANCE
 * read, so it never waits for the sweep to notice a deal.
 *
 * ## Why the throttle is the thing under test
 *
 * The obvious implementation writes on every reading, which is an UPDATE per
 * second per watched account for a column that only moves when a deal closes.
 * The obvious fix — dropping the write entirely — is what was there before. The
 * property worth pinning is the middle: fresh enough to matter, quiet enough to
 * ignore, and incapable of failing the feed it rides on.
 *
 * Mutation-checked: removing the throttle, and removing the try/catch, each fail
 * the named test below.
 */

const READING: Mt5LiveDto = {
  login: '00012345',
  currency: 'USD',
  balance: '1250.00000000',
  equity: '1237.60000000',
  credit: '0.00000000',
  margin: '33.00000000',
  marginFree: '1204.60000000',
  marginLevel: '3750.30',
  readAt: '2026-09-03T12:00:00.000Z',
  positions: [],
};

/** One account row, as the login lookup finds it. */
const ACCOUNT = { id: 'acct-1', userId: 'user-1' };

function build(options: { recordFails?: boolean } = {}) {
  const recordFromOperation = options.recordFails
    ? vi.fn().mockRejectedValue(new Error('database is having a bad minute'))
    : vi.fn().mockResolvedValue(undefined);

  const publish = vi.fn().mockResolvedValue(undefined);

  /* The login → account lookup, which is all this service asks the db for. */
  const db = {
    select: () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([ACCOUNT]) }) }),
    }),
  };

  const service = new Mt5LiveService(
    db as never,
    { publish } as never,
    { recordFromOperation } as never,
  );

  return { service, recordFromOperation, publish };
}

/**
 * The mirror write is deliberately NOT awaited by `ingest` — the live event is
 * the time-critical half. So the assertions have to let the microtask queue
 * drain before looking.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('a live reading refreshes the balance mirror', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes the balance through on the first reading for an account', async () => {
    const { service, recordFromOperation } = build();

    await service.ingest(READING);
    await settle();

    expect(recordFromOperation).toHaveBeenCalledTimes(1);
    const [login, balance, readAt] = recordFromOperation.mock.calls[0];
    expect(login).toBe('00012345');
    expect(balance).toBe('1250.00000000');
    /*
     * MT5's READ time, not the moment of the write. `recordFromOperation`
     * compares read times to decide whether a value is stale, so passing "now"
     * would let a live reading overwrite a fresher sweep delivery.
     */
    expect((readAt as Date).toISOString()).toBe('2026-09-03T12:00:00.000Z');
  });

  /*
   * THE regression this file exists for. The live loop reads a watched account
   * every round, so an unthrottled write is one UPDATE per round per account,
   * for ever, on a column that moves only when a deal closes.
   */
  it('does not write again for the same account inside the window', async () => {
    const { service, recordFromOperation } = build();

    await service.ingest(READING);
    await service.ingest(READING);
    await service.ingest(READING);
    await settle();

    expect(recordFromOperation).toHaveBeenCalledTimes(1);
  });

  it('throttles per account, so a second account is not suppressed by the first', async () => {
    const { service, recordFromOperation } = build();

    await service.ingest(READING);
    await service.ingest({ ...READING, login: '00099999' });
    await settle();

    expect(recordFromOperation).toHaveBeenCalledTimes(2);
  });

  it('writes again once the window has passed', async () => {
    vi.useFakeTimers();
    try {
      const { service, recordFromOperation } = build();

      await service.ingest(READING);
      await vi.advanceTimersByTimeAsync(31_000);
      await service.ingest(READING);
      await vi.advanceTimersByTimeAsync(1);

      expect(recordFromOperation).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  /*
   * Nobody asked for this write. The client asked for live figures and already
   * has them by the time it runs, so a database problem must cost a slightly
   * stale column and nothing else — the feed keeps working and the sweep
   * repairs the mirror either way.
   */
  it('still delivers the live figures when the mirror write fails', async () => {
    const { service, publish } = build({ recordFails: true });

    const result = await service.ingest(READING);
    await settle();

    expect(result).toEqual({ delivered: true });
    expect(publish).toHaveBeenCalledTimes(1);
  });

  /*
   * THE reason the write is wrapped, and the assertion the obvious version of
   * this test missed.
   *
   * `mirrorBalance` is called with `void` rather than awaited, so a rejection
   * inside it does not surface through `ingest` at all — it becomes an
   * UNHANDLED REJECTION. Asserting that `ingest` resolves therefore passes with
   * or without the try/catch, which is a test that proves nothing about the
   * thing it is named for. Node can be configured to terminate the process on
   * one of these, and this path runs once per live reading per watched account.
   *
   * So the listener is the assertion: the failure has to be caught where it
   * happens, not merely kept out of the caller's return value.
   */
  it('swallows the failure rather than leaving an unhandled rejection', async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);

    try {
      const { service } = build({ recordFails: true });

      await expect(service.ingest(READING)).resolves.toEqual({ delivered: true });
      await settle();
      // A rejection surfaces on the macrotask after the microtask queue drains.
      await settle();

      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});
