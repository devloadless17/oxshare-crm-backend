import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { TradingService } from '../src/modules/trading/trading.service';
import type { Mt5BridgeClient } from '../src/modules/trading/mt5/mt5-bridge.client';
import type { Mt5AccountSyncService } from '../src/modules/trading/mt5/mt5-account-sync.service';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * `GET /trading/accounts/:id/history` reads `mt5_deals`, and NOTHING else.
 *
 * ## What this suite is defending
 *
 * This endpoint used to call the MT5 bridge on every view. It now serves the
 * CRM's own ingested deals, and the value of that change is destroyed by a
 * well-meaning "fall back to live if the table looks empty" — which is exactly
 * the shape somebody reaches for the first time a client says a deal is missing.
 *
 * So the bridge here is a stub that THROWS on every method and reports itself
 * unconfigured. A read that reaches it fails this suite by name, rather than
 * passing against a mocked return value that quietly keeps the old path alive.
 *
 * ## The assertions that earn their runtime
 *
 * Ordering and windowing are asserted with rows that would pass under a wrong
 * implementation if there were only two of them: a same-second group whose
 * tickets must break the tie numerically ('9' must not outrank '100'), and
 * deals placed either side of both window edges.
 *
 * The statistics use amounts that do not sum exactly in binary, so a float would
 * show, and include a scratch exit — a trade that is neither a win nor a loss.
 */
let ctx: MoneyTestContext;
let trading: TradingService;
let userId: number;
let otherUserId: number;
let accountId: string;
let otherAccountId: string;

/** The bridge, as this endpoint is now allowed to use it: not at all. */
const forbiddenBridge = new Proxy(
  {},
  {
    get(_target, property) {
      if (property === 'isConfigured') return false;
      throw new Error(
        `historyMine reached the MT5 bridge (.${String(property)}). It must serve mt5_deals.`,
      );
    },
  },
) as unknown as Mt5BridgeClient;

const syncStub = {} as Mt5AccountSyncService;

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  trading = new TradingService(ctx.db, forbiddenBridge, syncStub);
}, 120_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

async function makeClient(email: string): Promise<number> {
  const { rows } = await ctx.db.execute<{ id: number }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name, verification_level, email_verified)
    VALUES (${email}, 'x', 'Test', 'Client', 1, true)
    RETURNING id
  `);
  return rows[0].id;
}

async function makeAccount(owner: number, login: string): Promise<string> {
  const { rows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO trading_accounts (user_id, login, currency, environment, status)
    VALUES (${owner}, ${login}, 'USD', 'live', 'active')
    RETURNING id
  `);
  return rows[0].id;
}

interface SeedDeal {
  ticket: string;
  login: string;
  action: number;
  entry: number;
  profit?: string;
  volume?: string;
  commission?: string;
  swap?: string;
  symbol?: string;
  dealtAt: string;
}

/**
 * Rows written straight to `mt5_deals`, which is how they arrive in production
 * too — `Mt5DealsService.ingest` is a plain insert. Going through it would drag
 * in the bridge's wire DTO and the duplicate check, neither of which this
 * suite asserts.
 */
async function seedDeals(deals: SeedDeal[]): Promise<void> {
  for (const deal of deals) {
    await ctx.db.execute(sql`
      INSERT INTO mt5_deals
        (mt5_deal_id, login, symbol, action, entry, volume, price, profit, commission, swap,
         dealt_at, source)
      VALUES (
        ${deal.ticket}, ${deal.login}, ${deal.symbol ?? 'EURUSD'}, ${deal.action}, ${deal.entry},
        ${deal.volume ?? '1.00000000'}, '1.08500000', ${deal.profit ?? '0.00000000'},
        ${deal.commission ?? '0.00000000'}, ${deal.swap ?? '0.00000000'}, ${deal.dealtAt}, 'sweep'
      )
    `);
  }
}

/**
 * A LOCAL wall-clock instant, as an ISO string.
 *
 * `resolveWindow` builds its bounds from a local `Date` — deliberately, so that
 * a client asking for "the 10th" gets their own 10th. The fixtures have to be
 * placed on the same clock or every edge assertion here would be testing the
 * runner's timezone instead of the boundary.
 */
function localIso(year: number, month: number, day: number, hour: number, minute = 0): string {
  return new Date(year, month - 1, day, hour, minute, 0, 0).toISOString();
}

function ymd(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const MAY = { from: ymd(2026, 5, 1), to: ymd(2026, 5, 31) };

beforeEach(async () => {
  await ctx.db.execute(sql`DELETE FROM mt5_deals`);
  await ctx.db.execute(sql`DELETE FROM trading_accounts`);
  await ctx.db.execute(sql`DELETE FROM users`);

  userId = await makeClient('history-owner@test.local');
  otherUserId = await makeClient('history-stranger@test.local');
  accountId = await makeAccount(userId, '5000001');
  otherAccountId = await makeAccount(otherUserId, '5000002');
});

describe('account history is served from mt5_deals', () => {
  it('answers with the ingested deals while the bridge is unreachable', async () => {
    await seedDeals([
      {
        ticket: '101',
        login: '5000001',
        action: 0,
        entry: 1,
        profit: '25.00000000',
        dealtAt: localIso(2026, 5, 10, 12),
      },
      {
        ticket: '102',
        login: '5000001',
        action: 2,
        entry: 0,
        profit: '500.00000000',
        symbol: '',
        dealtAt: localIso(2026, 5, 11, 9),
      },
    ]);

    const history = await trading.historyMine(userId, accountId, MAY);

    /*
     * ONLY the closed trade. The balance operation (102) is ingested, counts
     * toward `lastDealAt`, and is deliberately NOT listed: this endpoint pages
     * CLOSED TRADES now, and the filter moved into SQL when it did — a page of
     * 25 ingested rows holding three closed trades would otherwise return short
     * pages and a `total` nobody can reach. Balance movements are read through
     * `/accounts/:id/movements`, which exists for exactly them.
     */
    expect(history.deals.map((deal) => deal.ticket)).toEqual(['101']);
    expect(history.deals[0].closing).toBe(true);
    expect(history.total).toBe(1);
    expect(history.stats.trades).toBe(1);
    /* The deposit still moved money on the account, so "last activity" is its
       timestamp and not the trade's. */
    expect(history.stats.lastDealAt?.toISOString()).toBe(localIso(2026, 5, 11, 9));
  });

  it("never returns another client's deals, even though it queries by login", async () => {
    await seedDeals([
      {
        ticket: '201',
        login: '5000002',
        action: 0,
        entry: 1,
        profit: '9999.00000000',
        dealtAt: localIso(2026, 5, 10, 12),
      },
    ]);

    const mine = await trading.historyMine(userId, accountId, MAY);
    expect(mine.deals).toEqual([]);

    // And the row is not invisible to everybody — it belongs to the other account.
    const theirs = await trading.historyMine(otherUserId, otherAccountId, MAY);
    expect(theirs.deals.map((deal) => deal.ticket)).toEqual(['201']);
  });

  it('breaks a same-second tie by ticket NUMERICALLY, not lexically', async () => {
    const sameSecond = localIso(2026, 5, 10, 12, 30);
    await seedDeals([
      { ticket: '9', login: '5000001', action: 0, entry: 1, dealtAt: sameSecond },
      { ticket: '100', login: '5000001', action: 0, entry: 1, dealtAt: sameSecond },
      { ticket: '1000', login: '5000001', action: 0, entry: 1, dealtAt: sameSecond },
    ]);

    const history = await trading.historyMine(userId, accountId, MAY);

    // A lexical DESC would give ['9', '1000', '100'] — the order this guards.
    expect(history.deals.map((deal) => deal.ticket)).toEqual(['1000', '100', '9']);
  });

  it('includes both edges of the window whole, and nothing outside it', async () => {
    await seedDeals([
      // The last minute before the window opens, and the first inside it.
      { ticket: '1', login: '5000001', action: 0, entry: 1, dealtAt: localIso(2026, 5, 9, 23, 59) },
      { ticket: '2', login: '5000001', action: 0, entry: 1, dealtAt: localIso(2026, 5, 10, 0, 0) },
      // Late on the final day — the row that vanishes when `to` is read as midnight.
      {
        ticket: '3',
        login: '5000001',
        action: 0,
        entry: 1,
        dealtAt: localIso(2026, 5, 12, 23, 59),
      },
      { ticket: '4', login: '5000001', action: 0, entry: 1, dealtAt: localIso(2026, 5, 13, 0, 1) },
    ]);

    const history = await trading.historyMine(userId, accountId, {
      from: ymd(2026, 5, 10),
      to: ymd(2026, 5, 12),
    });

    expect(history.deals.map((deal) => deal.ticket)).toEqual(['3', '2']);
  });

  it('computes the statistics exactly, over closing trades only', async () => {
    await seedDeals([
      // 0.1 + 0.2 is 0.30000000000000004 in binary floats.
      {
        ticket: '11',
        login: '5000001',
        action: 0,
        entry: 1,
        profit: '0.10000000',
        volume: '0.10000000',
        commission: '-0.30000000',
        dealtAt: localIso(2026, 5, 10, 9),
      },
      {
        ticket: '12',
        login: '5000001',
        action: 1,
        entry: 1,
        profit: '0.20000000',
        volume: '0.20000000',
        commission: '-0.30000000',
        dealtAt: localIso(2026, 5, 10, 10),
      },
      {
        ticket: '13',
        login: '5000001',
        action: 0,
        entry: 1,
        profit: '-5.00000000',
        volume: '1.00000000',
        swap: '-0.50000000',
        dealtAt: localIso(2026, 5, 10, 11),
      },
      // A scratch exit: neither a win nor a loss, and still a trade.
      {
        ticket: '14',
        login: '5000001',
        action: 1,
        entry: 1,
        profit: '0.00000000',
        volume: '1.00000000',
        dealtAt: localIso(2026, 5, 10, 12),
      },
      // An OPENING deal — its profit is a placeholder and it is not a round trip.
      {
        ticket: '15',
        login: '5000001',
        action: 0,
        entry: 0,
        profit: '0.00000000',
        volume: '3.00000000',
        dealtAt: localIso(2026, 5, 10, 13),
      },
      // A deposit is not a winning trade, and its volume is not lots traded.
      {
        ticket: '16',
        login: '5000001',
        action: 2,
        entry: 0,
        profit: '1000.00000000',
        volume: '0.00000000',
        symbol: '',
        dealtAt: localIso(2026, 5, 10, 14),
      },
    ]);

    const { stats, deals, total } = await trading.historyMine(userId, accountId, MAY);

    /*
     * FOUR, not six: the opening deal (15) and the deposit (16) are ingested and
     * are not closed trades, so they are filtered in SQL rather than returned
     * for the browser to hide. The statistics below are unchanged by that — they
     * always counted closing trades only, which is why `trades` is also 4.
     */
    expect(deals).toHaveLength(4);
    expect(deals.map((deal) => deal.ticket)).toEqual(['14', '13', '12', '11']);
    expect(total).toBe(4);
    expect(stats.trades).toBe(4);
    expect(stats.wins).toBe(2);
    expect(stats.losses).toBe(1);
    expect(stats.volume).toBe('2.30000000');
    expect(stats.netProfit).toBe('-4.70000000');
    expect(stats.grossProfit).toBe('0.30000000');
    expect(stats.grossLoss).toBe('-5.00000000');
    expect(stats.commission).toBe('-0.60000000');
    expect(stats.swap).toBe('-0.50000000');
    expect(stats.bestTrade).toBe('0.20000000');
    expect(stats.worstTrade).toBe('-5.00000000');
    // The dates span EVERY deal, the deposit included — this is "last activity".
    expect(stats.firstDealAt?.toISOString()).toBe(localIso(2026, 5, 10, 9));
    expect(stats.lastDealAt?.toISOString()).toBe(localIso(2026, 5, 10, 14));
  });

  /*
   * ── PAGING ───────────────────────────────────────────────────────────────
   *
   * The window used to come back as ONE array capped at 500, and the screen
   * inferred truncation from its length. These pin the replacement: a slice
   * plus a real `total`, and statistics that describe the WINDOW rather than
   * the slice.
   */
  it('returns one page of closed trades and a total for the whole window', async () => {
    await seedDeals(
      Array.from({ length: 7 }, (_, index) => ({
        ticket: String(300 + index),
        login: '5000001',
        action: 0,
        entry: 1,
        profit: '1.00000000',
        // An hour apart so the newest-first order is unambiguous.
        dealtAt: localIso(2026, 5, 10, 9 + index),
      })),
    );

    const first = await trading.historyMine(userId, accountId, { ...MAY, page: 1, limit: 3 });

    // Newest first: 306 was dealt at 15:00, 300 at 09:00.
    expect(first.deals.map((deal) => deal.ticket)).toEqual(['306', '305', '304']);
    expect(first.total).toBe(7);
    expect(first.page).toBe(1);
    expect(first.limit).toBe(3);

    const last = await trading.historyMine(userId, accountId, { ...MAY, page: 3, limit: 3 });

    // The final page is SHORT rather than padded, and page 4 would be empty.
    expect(last.deals.map((deal) => deal.ticket)).toEqual(['300']);
    expect(last.total).toBe(7);
  });

  it('keeps the statistics describing the WINDOW, not the page', async () => {
    await seedDeals([
      {
        ticket: '401',
        login: '5000001',
        action: 0,
        entry: 1,
        profit: '100.00000000',
        dealtAt: localIso(2026, 5, 10, 9),
      },
      {
        ticket: '402',
        login: '5000001',
        action: 0,
        entry: 1,
        profit: '-40.00000000',
        dealtAt: localIso(2026, 5, 10, 10),
      },
      {
        ticket: '403',
        login: '5000001',
        action: 0,
        entry: 1,
        profit: '7.00000000',
        dealtAt: localIso(2026, 5, 10, 11),
      },
    ]);

    /*
     * A page holding ONE trade whose profit is 7.00. If the totals were summed
     * from the returned array — the bug this guards — `netProfit` would read
     * 7.00 and `bestTrade` 7.00, and a client paging through their month would
     * watch both change under them.
     */
    const page = await trading.historyMine(userId, accountId, { ...MAY, page: 1, limit: 1 });

    expect(page.deals).toHaveLength(1);
    expect(page.deals[0].ticket).toBe('403');
    expect(page.total).toBe(3);

    expect(page.stats.trades).toBe(3);
    expect(page.stats.netProfit).toBe('67.00000000');
    expect(page.stats.bestTrade).toBe('100.00000000');
    expect(page.stats.worstTrade).toBe('-40.00000000');
    expect(page.stats.wins).toBe(2);
    expect(page.stats.losses).toBe(1);
  });

  it('reports an empty window rather than reaching for the trading server', async () => {
    const history = await trading.historyMine(userId, accountId, MAY);

    expect(history.deals).toEqual([]);
    expect(history.stats.trades).toBe(0);
    expect(history.stats.bestTrade).toBeNull();
    expect(history.stats.firstDealAt).toBeNull();
  });

  it('still refuses a window wider than the cap', async () => {
    await expect(
      trading.historyMine(userId, accountId, { from: ymd(2026, 1, 1), to: ymd(2026, 5, 31) }),
    ).rejects.toThrow(/at most 31 days/);
  });
});
