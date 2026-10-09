import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { AdminHoldingsService } from '../src/modules/admin/admin-holdings.service';
import { ClientVisibilityService } from '../src/common/security/client-visibility.service';
import { UsersStore } from '../src/store/users.store';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * The client profile's Positions tab: CLOSED positions only (owner, 26 Sep
 * 2026), built from the ingested MT5 deals.
 *
 * It read the `positions` table, which nothing on the live path writes — MT5
 * delivers deals — so the tab said "No closed positions yet." for clients with
 * hundreds of closed trades. These pin that a closing deal is a row, that its
 * opening deal supplies the open side, price and time, and that the side is the
 * POSITION's rather than the closing deal's.
 */
let ctx: MoneyTestContext;
let holdings: AdminHoldingsService;
let clientId: number;
let otherId: number;

const BUY = 0;
const SELL = 1;
const BALANCE = 2;
const IN = 0;
const OUT = 1;

async function account(userId: number, login: string, environment = 'live'): Promise<void> {
  await ctx.db.execute(sql`
    INSERT INTO trading_accounts (user_id, login, currency, environment)
    VALUES (${userId}, ${login}, 'USD', ${environment})
  `);
}

async function deal(d: {
  ticket: string;
  login: string;
  positionId: string | null;
  action: number;
  entry: number;
  price: string;
  profit?: string;
  commission?: string;
  at: string;
}): Promise<void> {
  await ctx.db.execute(sql`
    INSERT INTO mt5_deals
      (mt5_deal_id, login, mt5_position_id, symbol, action, entry, volume, price, profit,
       commission, swap, dealt_at, source)
    VALUES (
      ${d.ticket}, ${d.login}, ${d.positionId}, 'EURUSD', ${d.action}, ${d.entry}, '0.10000000',
      ${d.price}, ${d.profit ?? '0'}, ${d.commission ?? '0'}, '0', ${d.at}, 'sweep'
    )
  `);
}

async function user(email: string): Promise<number> {
  const { rows } = await ctx.db.execute<{ id: number }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name)
    VALUES (${email}, 'x', 'Closed', 'Trader')
    RETURNING id
  `);
  return rows[0].id;
}

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  holdings = new AdminHoldingsService(ctx.db, new ClientVisibilityService(new UsersStore(ctx.db)));
  clientId = await user('closed-positions@oxshare-e2e.test');
  otherId = await user('closed-positions-other@oxshare-e2e.test');
}, 180_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

beforeEach(async () => {
  await ctx.db.execute(sql`DELETE FROM mt5_deals`);
  await ctx.db.execute(
    sql`DELETE FROM trading_accounts WHERE user_id IN (${clientId}, ${otherId})`,
  );
});

describe("a client's closed positions", () => {
  it('lists each closing deal with its opening deal, newest first', async () => {
    await account(clientId, '81001');
    // A BUY opened at 1.1000 and closed by a SELL at 1.1050.
    await deal({
      ticket: '1',
      login: '81001',
      positionId: 'P1',
      action: BUY,
      entry: IN,
      price: '1.10000000',
      commission: '-1.50000000',
      at: '2026-09-20T10:00:00Z',
    });
    await deal({
      ticket: '2',
      login: '81001',
      positionId: 'P1',
      action: SELL,
      entry: OUT,
      price: '1.10500000',
      profit: '50.00000000',
      commission: '-1.50000000',
      at: '2026-09-20T11:00:00Z',
    });
    // A SELL, opened and closed later.
    await deal({
      ticket: '3',
      login: '81001',
      positionId: 'P2',
      action: SELL,
      entry: IN,
      price: '1.20000000',
      at: '2026-09-21T10:00:00Z',
    });
    await deal({
      ticket: '4',
      login: '81001',
      positionId: 'P2',
      action: BUY,
      entry: OUT,
      price: '1.19000000',
      profit: '100.00000000',
      at: '2026-09-21T12:00:00Z',
    });

    const page = await holdings.listClientClosedPositions({ userId: clientId });

    expect(page.total).toBe(2);
    expect(page.rows.map((row) => row.ticket)).toEqual(['4', '2']);

    const buy = page.rows[1];
    expect(buy?.side).toBe('buy');
    expect(buy?.openPrice).toBe('1.10000000');
    expect(buy?.closePrice).toBe('1.10500000');
    expect(buy?.profit).toBe('50.00000000');
    // MT5 charged on both legs; the trade carries both.
    expect(buy?.commission).toBe('-3.00000000');
    expect(buy?.openedAt?.toISOString()).toBe('2026-09-20T10:00:00.000Z');
    expect(buy?.closedAt.toISOString()).toBe('2026-09-20T11:00:00.000Z');
    expect(buy?.login).toBe('81001');
    expect(buy?.environment).toBe('live');

    expect(page.rows[0]?.side).toBe('sell');
  });

  it('lists no open trade and no balance operation', async () => {
    await account(clientId, '81002');
    await deal({
      ticket: '10',
      login: '81002',
      positionId: 'P10',
      action: BUY,
      entry: IN,
      price: '1.1',
      at: '2026-09-22T10:00:00Z',
    });
    await deal({
      ticket: '11',
      login: '81002',
      positionId: null,
      action: BALANCE,
      entry: IN,
      price: '0',
      profit: '1000',
      at: '2026-09-22T09:00:00Z',
    });

    const page = await holdings.listClientClosedPositions({ userId: clientId });

    expect(page.rows).toEqual([]);
    expect(page.total).toBe(0);
  });

  /*
   * An opening deal from before the CRM ingested anything is simply absent.
   * The row still says which way the trade went: the reverse of the deal that
   * closed it — never the closing deal's own side.
   */
  it('reverses the closing side when the opening deal was never ingested', async () => {
    await account(clientId, '81003');
    await deal({
      ticket: '20',
      login: '81003',
      positionId: 'P20',
      action: SELL,
      entry: OUT,
      price: '1.3',
      profit: '-5',
      at: '2026-09-23T10:00:00Z',
    });

    const [row] = (await holdings.listClientClosedPositions({ userId: clientId })).rows;

    expect(row?.side).toBe('buy');
    expect(row?.openPrice).toBeNull();
    expect(row?.openedAt).toBeNull();
  });

  it("covers every one of the client's accounts, demo too, and nobody else's", async () => {
    await account(clientId, '81004', 'live');
    await account(clientId, '81005', 'demo');
    await account(otherId, '81006', 'live');
    await deal({
      ticket: '30',
      login: '81004',
      positionId: 'P30',
      action: SELL,
      entry: OUT,
      price: '1',
      at: '2026-09-24T10:00:00Z',
    });
    await deal({
      ticket: '31',
      login: '81005',
      positionId: 'P31',
      action: SELL,
      entry: OUT,
      price: '1',
      at: '2026-09-24T11:00:00Z',
    });
    await deal({
      ticket: '32',
      login: '81006',
      positionId: 'P32',
      action: SELL,
      entry: OUT,
      price: '1',
      at: '2026-09-24T12:00:00Z',
    });

    const page = await holdings.listClientClosedPositions({ userId: clientId });

    expect(page.rows.map((row) => [row.ticket, row.environment])).toEqual([
      ['31', 'demo'],
      ['30', 'live'],
    ]);
  });

  it('pages, with a total over every page', async () => {
    await account(clientId, '81007');
    for (let i = 0; i < 3; i += 1) {
      await deal({
        ticket: `4${i}`,
        login: '81007',
        positionId: `P4${i}`,
        action: SELL,
        entry: OUT,
        price: '1',
        at: `2026-09-25T1${i}:00:00Z`,
      });
    }

    const second = await holdings.listClientClosedPositions({
      userId: clientId,
      page: 2,
      limit: 2,
    });

    expect(second.total).toBe(3);
    expect(second.rows.map((row) => row.ticket)).toEqual(['40']);
  });
});

describe('a heavy trader across several logins', () => {
  it('pages First → Next → Previous and Last over every login, each deal once, newest first', async () => {
    for (const login of ['82001', '82002', '82003']) await account(clientId, login);
    // 300 closing deals spread over three logins, many sharing one instant.
    await ctx.db.execute(sql`
      INSERT INTO mt5_deals
        (mt5_deal_id, login, mt5_position_id, symbol, action, entry, volume, price, profit,
         commission, swap, dealt_at, source)
      SELECT 'h' || g, (ARRAY['82001','82002','82003'])[1 + g % 3], 'hp' || g, 'EURUSD', 1, 1,
             '0.10000000', '1.1', '1', '0', '0',
             timestamptz '2026-10-01T00:00:00Z' + ((g / 4) || ' seconds')::interval, 'sweep'
      FROM generate_series(1, 300) g`);

    const pageOf = (q: { cursor?: string; dir?: string }) =>
      holdings.listClientClosedPositions({ userId: clientId, limit: 25, ...q });
    const ids = (p: Awaited<ReturnType<typeof pageOf>>) => p.rows.map((r) => r.id);

    const first = await pageOf({});
    expect(first).toMatchObject({ total: 300, totalCapped: false, prevCursor: null });
    const second = await pageOf({ cursor: first.nextCursor! });
    const back = await pageOf({ cursor: second.prevCursor!, dir: 'prev' });
    expect(ids(back)).toEqual(ids(first));

    const walked = [...first.rows, ...second.rows];
    expect(new Set(walked.map((r) => r.id)).size).toBe(50);
    const times = walked.map((r) => new Date(r.closedAt).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));

    const last = await pageOf({ dir: 'last' });
    expect(last.nextCursor).toBeNull();
    expect(last.rows).toHaveLength(25);
    expect(ids(last).some((id) => ids(first).includes(id))).toBe(false);
  });
});
