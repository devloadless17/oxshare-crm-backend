import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { TradingService } from '../src/modules/trading/trading.service';
import type { Mt5BridgeClient } from '../src/modules/trading/mt5/mt5-bridge.client';
import { Mt5AccountSyncService } from '../src/modules/trading/mt5/mt5-account-sync.service';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * The accounts list asks MT5 before it answers, when the mirror is old.
 *
 * ## The failure this defends against
 *
 * A client closes a trade in the terminal, opens the portal, and reads their
 * balance. The mirror behind that number is written by a background sweep whose
 * worst case is minutes, so the first thing they see is the figure from before
 * their trade — at the one moment they are certain what the right answer is.
 * Worse, they act on it: the transfer screen offers the same number, so a stale
 * one either refuses a movement they should be allowed or offers one MT5 will
 * refuse.
 *
 * Tuning the sweep cannot fix that, because the sweep does not know the client
 * has opened the page. So the list reads MT5 itself, and these tests pin BOTH
 * halves: that it does, and that its three bounds hold — because an unbounded
 * version of this is a per-render MT5 call on the most-visited screen in the
 * portal, serialised behind the one session lock every other read needs too.
 *
 * `listTransferable` and the dashboard both delegate to `listMine`, so they
 * inherit all of it; that delegation is asserted here rather than assumed.
 */
let ctx: MoneyTestContext;
let userId: string;

/** What MT5 says right now, and how many times it was asked. */
const mt5 = { balance: '900.00000000', calls: [] as string[], fail: false, delayMs: 0 };

const bridge = {
  isConfigured: true,
  async getAccount(login: string) {
    mt5.calls.push(login);
    if (mt5.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, mt5.delayMs));
    if (mt5.fail) throw new Error('MT5 is busy');
    return { login: Number(login), balance: mt5.balance, currency: 'USD' };
  },
} as unknown as Mt5BridgeClient;

function service(): TradingService {
  /*
   * The REAL sync service, not a stub. `recordFromOperation` carries the
   * staleness guard that decides whether this write wins, and a stub would let
   * a regression in that guard pass here — which is precisely the write this
   * feature depends on.
   */
  return new TradingService(ctx.db, bridge, new Mt5AccountSyncService(ctx.db));
}

beforeAll(async () => {
  ctx = await startMoneyTestDb();
}, 120_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

beforeEach(async () => {
  await ctx.db.execute(sql`DELETE FROM trading_accounts`);
  await ctx.db.execute(sql`DELETE FROM users`);
  mt5.balance = '900.00000000';
  mt5.calls = [];
  mt5.fail = false;
  mt5.delayMs = 0;

  const { rows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name, verification_level, email_verified)
    VALUES ('freshness@test.local', 'x', 'Test', 'Client', 1, true)
    RETURNING id
  `);
  userId = rows[0].id;
});

/**
 * `syncedSecondsAgo` is the whole subject of this file, so it is explicit on
 * every account rather than defaulted.
 */
async function makeAccount(
  login: string,
  opts: { balance?: string; syncedSecondsAgo: number | null; status?: string } = {
    syncedSecondsAgo: 0,
  },
): Promise<void> {
  const synced =
    opts.syncedSecondsAgo === null
      ? sql`NULL`
      : sql`now() - (${opts.syncedSecondsAgo} * interval '1 second')`;

  await ctx.db.execute(sql`
    INSERT INTO trading_accounts (user_id, login, currency, environment, status, balance, balance_synced_at)
    VALUES (${userId}, ${login}, 'USD', 'live', ${opts.status ?? 'active'},
            ${opts.balance ?? '100.00000000'}, ${synced})
  `);
}

describe('a balance the client is about to act on', () => {
  it('reads MT5 when the mirror is stale, and answers with what MT5 said', async () => {
    await makeAccount('500001', { balance: '100.00000000', syncedSecondsAgo: 600 });

    const rows = await service().listMine(userId);

    // The point of the whole feature: the client sees MT5's figure, not the
    // one the last sweep happened to leave behind.
    expect(mt5.calls).toEqual(['500001']);
    expect(rows[0].balance).toBe('900.00000000');
  });

  it('writes the fresh figure THROUGH, so the next screen agrees with this one', async () => {
    await makeAccount('500001', { balance: '100.00000000', syncedSecondsAgo: 600 });

    await service().listMine(userId);

    /*
     * The read cost the MT5 session lock — the most expensive thing the bridge
     * does — and discarding the answer is what left the mirror stale for the
     * next screen. Same reasoning `snapshotMine` records.
     */
    const { rows } = await ctx.db.execute<{ balance: string }>(
      sql`SELECT balance FROM trading_accounts WHERE login = '500001'`,
    );
    expect(rows[0].balance).toBe('900.00000000');
  });

  it('does NOT read MT5 when the mirror is already fresh', async () => {
    await makeAccount('500001', { syncedSecondsAgo: 2 });

    await service().listMine(userId);

    /*
     * The bound that stops this becoming a per-render MT5 call. A reload, and
     * the portal's own 30s poll on this screen, must cost nothing when the
     * sweep or a previous load has just written the figure.
     */
    expect(mt5.calls).toEqual([]);
  });

  it('treats a never-synced account as stale', async () => {
    // A brand-new account, or one the sweep has never reached. Null is not
    // "fresh"; it is the strongest case for asking.
    await makeAccount('500001', { syncedSecondsAgo: null });

    await service().listMine(userId);

    expect(mt5.calls).toEqual(['500001']);
  });
});

describe('the bounds, which are what make it safe to ship', () => {
  it('never fails the list when the bridge does', async () => {
    await makeAccount('500001', { balance: '100.00000000', syncedSecondsAgo: 600 });
    mt5.fail = true;

    const rows = await service().listMine(userId);

    /*
     * NOT `viaBridge`, which re-throws so the detail page can offer a retry.
     * Here the answer is the list and the mirror can always supply it, so an
     * unreachable bridge costs a stale balance rather than a screen that will
     * not open at all.
     */
    expect(rows).toHaveLength(1);
    expect(rows[0].balance).toBe('100.00000000');
  });

  it('reads at most five accounts, however many the client holds', async () => {
    for (let i = 1; i <= 8; i++) {
      await makeAccount(`50000${i}`, { syncedSecondsAgo: 600 });
    }

    const rows = await service().listMine(userId);

    // The MT5 session is a single lock and these reads are serial, so this cap
    // is how long one client can hold it away from everybody else.
    expect(mt5.calls).toHaveLength(5);
    expect(rows).toHaveLength(8);
  });

  it('stops at its time budget rather than making the client wait', async () => {
    for (let i = 1; i <= 5; i++) {
      await makeAccount(`50000${i}`, { syncedSecondsAgo: 600 });
    }
    /*
     * A read measured ~150ms on an idle bridge and FORTY SECONDS while a sweep
     * round was running. 900ms each means the third read starts past the
     * 2.5s budget, so the loop must stop — a client opening this page must
     * never wait out a busy bridge.
     */
    mt5.delayMs = 900;

    const started = Date.now();
    const rows = await service().listMine(userId);
    const elapsed = Date.now() - started;

    expect(mt5.calls.length).toBeLessThan(5);
    expect(elapsed).toBeLessThan(5_000);
    // Every account still comes back; the un-refreshed ones answer from the mirror.
    expect(rows).toHaveLength(5);
  });

  it('leaves a closed account alone', async () => {
    await makeAccount('500001', { syncedSecondsAgo: 600, status: 'closed' });
    await makeAccount('500002', { syncedSecondsAgo: 600 });

    await service().listMine(userId);

    // A closed account's balance is not what the client came to check, and
    // spending the budget on one takes it from an account they are trading.
    expect(mt5.calls).toEqual(['500002']);
  });
});

describe('the screens that inherit this', () => {
  it('refreshes for the transfer picker too, which is where the number is acted on', async () => {
    await makeAccount('500001', { balance: '100.00000000', syncedSecondsAgo: 600 });

    const rows = await service().listTransferable(userId);

    /*
     * `listTransferable` delegates to `listMine`. Asserted rather than assumed:
     * this is the screen where a stale balance stops being a cosmetic problem
     * and starts refusing a movement the client is entitled to make.
     */
    expect(mt5.calls).toEqual(['500001']);
    expect(rows[0].balance).toBe('900.00000000');
  });
});
