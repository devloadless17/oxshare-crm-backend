import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { TradingService } from '../src/modules/trading/trading.service';
import type { Mt5BridgeClient } from '../src/modules/trading/mt5/mt5-bridge.client';
import type { Mt5AccountSyncService } from '../src/modules/trading/mt5/mt5-account-sync.service';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * `GET /trading/balance-movements` — the money that moved on a client's MT5
 * accounts with NO position behind it.
 *
 * ## The defect this closes, and why it was invisible
 *
 * The dealer adjustment (`POST /admin/trading-accounts/:id/balance`) moved
 * money on MT5 with no wallet leg and no ledger entry: a correction or a bonus,
 * not a client funding an account. Every CRM money screen reads
 * `transactions`, so that movement appeared on NONE of them — an admin could
 * credit or DEBIT a client's trading account and the client's own transaction
 * history showed nothing at all. Found by hand, by the owner.
 *
 * ⚠️ THAT ROUTE IS GONE. Console movements go through
 * `POST /admin/trading-accounts/:id/fund`, which records both directions. This
 * endpoint now covers what remains: balance operations MT5 booked itself — a
 * swap correction, or a movement made directly in the broker terminal — which
 * have no `transactions` row and never will. The cases below are unaffected;
 * they seed `mt5_deals` directly and never called the removed route.
 *
 * The data was never missing. `deal-codes.ts` had already written down that the
 * client should see these, and `mt5_deals` stores every deal the bridge
 * ingests. The only screen that read them went in `1cfd673`, together with the
 * trade statistics it was really built for.
 *
 * ## What these cases are defending against, specifically
 *
 * 1. **The empty pass.** A read that returns `[]` looks identical whether it is
 *    correct or broken, so every case here asserts a POPULATED result and names
 *    the row it expects. `items: []` was the first thing the live endpoint
 *    returned and it proved nothing.
 * 2. **Quietly becoming the Activity card again.** Trades must stay OUT. If
 *    somebody widens this to "all deals" the trade case fails by name, rather
 *    than the screen silently regrowing the panel that was deliberately removed.
 * 3. **Another client's money.** Scoped by the caller's accounts, and a second
 *    client with movements of their own is present in every case so a missing
 *    predicate shows up as their row appearing rather than as nothing at all.
 */
let ctx: MoneyTestContext;
let trading: TradingService;
let userId: string;
let otherUserId: string;
let accountA: string;
let accountB: string;

/** This endpoint must never reach the bridge: it serves the CRM's own record. */
const forbiddenBridge = new Proxy(
  {},
  {
    get(_target, property) {
      if (property === 'isConfigured') return false;
      throw new Error(`balance-movements reached the bridge (${String(property)})`);
    },
  },
) as unknown as Mt5BridgeClient;

/*
 * Not `async () => undefined`: an async function with nothing to await is a
 * `require-await` error, and the gate is right to say so. The contract is "a
 * promise that resolves", which `Promise.resolve()` states without pretending
 * there is work here. Nothing in this suite should reach it anyway — the read
 * under test never syncs.
 */
const syncStub = {
  recordFromOperation: () => Promise.resolve(undefined),
} as unknown as Mt5AccountSyncService;

const DEAL_BUY = 0;
const DEAL_BUY_CANCELED = 13;
const DEAL_BALANCE = 2; // not a trade, not a cancellation: a money movement

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  trading = new TradingService(ctx.db, forbiddenBridge, syncStub);
}, 180_000);

afterAll(async () => {
  await stopMoneyTestDb(ctx);
});

async function makeClient(email: string): Promise<string> {
  const { rows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO users (email, password_hash, first_name, last_name, verification_level, email_verified)
    VALUES (${email}, 'x', 'Test', 'Client', 1, true)
    RETURNING id
  `);
  return rows[0].id;
}

async function makeAccount(owner: string, login: string | null): Promise<string> {
  const { rows } = await ctx.db.execute<{ id: string }>(sql`
    INSERT INTO trading_accounts (user_id, login, currency, environment, status)
    VALUES (${owner}, ${login}, 'USD', 'live', 'active')
    RETURNING id
  `);
  return rows[0].id;
}

async function seedDeal(d: {
  ticket: string;
  login: string;
  action: number;
  profit: string;
  comment?: string;
  dealtAt: string;
}): Promise<void> {
  await ctx.db.execute(sql`
    INSERT INTO mt5_deals
      (mt5_deal_id, login, symbol, action, entry, volume, price, profit, commission, swap,
       comment, dealt_at, source)
    VALUES (
      ${d.ticket}, ${d.login}, 'EURUSD', ${d.action}, 0, '1.00000000', '1.08500000',
      ${d.profit}, '0.00000000', '0.00000000', ${d.comment ?? null}, ${d.dealtAt}, 'sweep'
    )
  `);
}

const recently = () => new Date(Date.now() - 60_000).toISOString();

beforeEach(async () => {
  await ctx.db.execute(sql`DELETE FROM mt5_deals`);
  await ctx.db.execute(sql`DELETE FROM trading_accounts`);
  await ctx.db.execute(sql`DELETE FROM users`);
  userId = await makeClient('bm-owner@oxshare.test');
  otherUserId = await makeClient('bm-other@oxshare.test');
  accountA = await makeAccount(userId, '500001');
  accountB = await makeAccount(userId, '500002');
  await makeAccount(otherUserId, '500999');
});

describe('a dealer adjustment reaches the client', () => {
  it('returns a CREDIT the admin made, with its amount, reason and account', async () => {
    await seedDeal({
      ticket: '9001',
      login: '500001',
      action: DEAL_BALANCE,
      profit: '250.00000000',
      comment: 'Goodwill credit',
      dealtAt: recently(),
    });

    const { items } = await trading.balanceMovementsMine(userId);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      ticket: '9001',
      accountId: accountA,
      login: '500001',
      amount: '250.00000000',
      comment: 'Goodwill credit',
    });
  });

  it('returns a DEBIT as a NEGATIVE amount — the direction must be readable', async () => {
    /*
     * The case that matters most. An admin taking money OFF a client's trading
     * account is the movement with no other client-visible record anywhere, and
     * a screen that renders the figure without its sign would report a debit as
     * though it were a credit.
     */
    await seedDeal({
      ticket: '9002',
      login: '500001',
      action: DEAL_BALANCE,
      profit: '-125.50000000',
      comment: 'Correction',
      dealtAt: recently(),
    });

    const { items } = await trading.balanceMovementsMine(userId);

    expect(items).toHaveLength(1);
    expect(items[0]?.amount).toBe('-125.50000000');
    // A STRING, not a number — §6.1, and the thing a chart is most likely to break.
    expect(typeof items[0]?.amount).toBe('string');
  });

  it('covers EVERY account the client holds, not just one', async () => {
    await seedDeal({
      ticket: '9003',
      login: '500001',
      action: DEAL_BALANCE,
      profit: '10.00000000',
      dealtAt: recently(),
    });
    await seedDeal({
      ticket: '9004',
      login: '500002',
      action: DEAL_BALANCE,
      profit: '20.00000000',
      dealtAt: recently(),
    });

    const { items } = await trading.balanceMovementsMine(userId);

    expect(items.map((i) => i.ticket).sort()).toEqual(['9003', '9004']);
    expect(items.map((i) => i.accountId).sort()).toEqual([accountA, accountB].sort());
  });
});

describe('what must NOT appear', () => {
  it('excludes TRADES — this is not the Activity card coming back', async () => {
    /*
     * Win rate, realised P/L and volume were removed from the portal on
     * purpose. If somebody widens this read to "all deals", this fails by name
     * rather than the panel quietly regrowing.
     */
    await seedDeal({
      ticket: '7001',
      login: '500001',
      action: DEAL_BUY,
      profit: '80.00000000',
      dealtAt: recently(),
    });
    await seedDeal({
      ticket: '9005',
      login: '500001',
      action: DEAL_BALANCE,
      profit: '5.00000000',
      dealtAt: recently(),
    });

    const { items } = await trading.balanceMovementsMine(userId);

    // Populated first: "no trades" is trivially true of an empty list.
    expect(items).toHaveLength(1);
    expect(items[0]?.ticket).toBe('9005');
  });

  it('excludes a dealer CANCELLATION, which is the reversal of an event', async () => {
    await seedDeal({
      ticket: '7002',
      login: '500001',
      action: DEAL_BUY_CANCELED,
      profit: '-80.00000000',
      dealtAt: recently(),
    });
    await seedDeal({
      ticket: '9006',
      login: '500001',
      action: DEAL_BALANCE,
      profit: '5.00000000',
      dealtAt: recently(),
    });

    const { items } = await trading.balanceMovementsMine(userId);

    expect(items).toHaveLength(1);
    expect(items[0]?.ticket).toBe('9006');
  });

  it("never returns ANOTHER client's movements", async () => {
    await seedDeal({
      ticket: '9007',
      login: '500999',
      action: DEAL_BALANCE,
      profit: '999.00000000',
      dealtAt: recently(),
    });
    await seedDeal({
      ticket: '9008',
      login: '500001',
      action: DEAL_BALANCE,
      profit: '1.00000000',
      dealtAt: recently(),
    });

    const { items } = await trading.balanceMovementsMine(userId);

    expect(items).toHaveLength(1);
    expect(items[0]?.ticket).toBe('9008');
    // Named, so a scope regression reads as "the other client's row" rather
    // than as a count that happens to be wrong.
    expect(items.map((i) => i.login)).not.toContain('500999');
  });
});

describe('the window and the cap', () => {
  it('accepts a range WIDER than 31 days — the history cap does not apply here', async () => {
    /*
     * `/accounts/:id/history` caps a window at 31 days, and its own message
     * argues from trade volume: "a whole one is more than a single response can
     * carry for an actively traded account". This list EXCLUDES trades. Dealer
     * adjustments are rare, so a year of them might be three rows — and
     * inheriting that cap would make a client ask twelve times to find out.
     *
     * Copying a constraint because it sits next to the semantics you do want is
     * the mistake this case exists to prevent. Raised by crm-92 in review.
     */
    await seedDeal({
      ticket: '9100',
      login: '500001',
      action: DEAL_BALANCE,
      profit: '42.00000000',
      dealtAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString(),
    });

    const { items } = await trading.balanceMovementsMine(userId, {
      from: '2026-01-01',
      to: '2026-12-31',
    });

    expect(items.map((i) => i.ticket)).toContain('9100');
  });

  it('still refuses a range that runs backwards', async () => {
    await expect(
      trading.balanceMovementsMine(userId, { from: '2026-06-01', to: '2026-05-01' }),
    ).rejects.toThrow(/must not be after/i);
  });

  it('SAYS SO when the list is capped, rather than silently cutting it', async () => {
    /*
     * The failure this product has already shipped twice: a partner's client
     * count that was the length of what fitted, and a referred list capped at
     * fifty with nothing saying so. A cut list that does not announce the cut is
     * a number the reader will trust.
     */
    const many = Array.from({ length: 505 }, (_unused, i) =>
      seedDeal({
        ticket: `8${String(i).padStart(4, '0')}`,
        login: '500001',
        action: DEAL_BALANCE,
        profit: '1.00000000',
        dealtAt: recently(),
      }),
    );
    await Promise.all(many);

    const { items, truncated } = await trading.balanceMovementsMine(userId);

    expect(items).toHaveLength(500);
    expect(truncated, 'a capped list MUST say it is capped').toBe(true);
  });

  it('does not claim truncation when everything fits', async () => {
    // The control. Without it `truncated` could be hard-wired true and the case
    // above would still pass — a flag reporting a problem nobody has.
    await seedDeal({
      ticket: '9101',
      login: '500001',
      action: DEAL_BALANCE,
      profit: '1.00000000',
      dealtAt: recently(),
    });

    const { items, truncated } = await trading.balanceMovementsMine(userId);

    expect(items).toHaveLength(1);
    expect(truncated).toBe(false);
  });
});

describe('accounts MetaTrader has not issued a login for', () => {
  it('are skipped rather than erroring, and do not hide the others', async () => {
    await makeAccount(userId, null);
    await seedDeal({
      ticket: '9009',
      login: '500001',
      action: DEAL_BALANCE,
      profit: '7.00000000',
      dealtAt: recently(),
    });

    const { items } = await trading.balanceMovementsMine(userId);

    expect(items).toHaveLength(1);
    expect(items[0]?.ticket).toBe('9009');
  });

  it('return an empty window for a client with no accounts at all', async () => {
    const lonely = await makeClient('bm-none@oxshare.test');
    const { items, from, to } = await trading.balanceMovementsMine(lonely);

    expect(items).toEqual([]);
    // The window is still answered, so the screen can say what it covered.
    expect(from).toBeInstanceOf(Date);
    expect(to).toBeInstanceOf(Date);
  });
});
