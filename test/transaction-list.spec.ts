import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { ConfigService } from '@nestjs/config';
import { PaymentMethodsService } from '../src/modules/payments/payment-methods.service';
import { TransactionsService } from '../src/modules/payments/transactions.service';
import { WalletService } from '../src/modules/wallet/wallet.service';
import { CurrenciesService } from '../src/modules/currencies/currencies.service';
import { MoneyLimits } from '../src/config/money-limits';
import { auditStubAs } from './audit-stub';
import { emailStubAs } from './email-stub';
import { notificationsStubAs } from './notifications-stub';
import { gatewayStubAs } from './gateway-stub';
import { startMoneyTestDb, stopMoneyTestDb, type MoneyTestContext } from './money-setup';

/**
 * A client's own history, narrowed and ordered BY THE DATABASE.
 *
 * ## ⚠️ What this exists to prevent
 *
 * `listForUser` was a bare `SELECT ... ORDER BY created_at DESC LIMIT 100` with
 * no parameters, and the portal filtered, sorted and counted the result in the
 * browser. Both apps documented that array as "the client's whole history" — the
 * `LIMIT 100` had quietly made the sentence false, and nobody noticed because
 * no test ever gave a client more than a handful of rows.
 *
 * So the assertions that earn their runtime here are the ones that need MORE
 * ROWS THAN A PAGE to fail. A test over three transactions passes whether the
 * filtering happens in SQL or in JavaScript, and would have passed against the
 * broken version too.
 *
 * The money assertion is the amount ordering. `amount` is `NUMERIC(28,8)`, so
 * Postgres compares it exactly — the point of sorting there rather than here is
 * that `'9.00000000'` cannot outrank `'100.00000000'` the way a text comparison
 * would, and no value has to leave the database to be compared (§6.1).
 */
let ctx: MoneyTestContext;
let methods: PaymentMethodsService;
let transactions: TransactionsService;
let wallets: WalletService;
let userId: string;
let otherUserId: string;

beforeAll(async () => {
  ctx = await startMoneyTestDb();
  const currencies = new CurrenciesService(ctx.db, auditStubAs());
  wallets = new WalletService(ctx.db);
  methods = new PaymentMethodsService(
    ctx.db,
    currencies,
    auditStubAs(),
    gatewayStubAs(),
    new MoneyLimits(new ConfigService()),
  );
  transactions = new TransactionsService(
    wallets,
    ctx.db,
    new MoneyLimits(new ConfigService()),
    methods,
    currencies,
    gatewayStubAs(),
    new ConfigService(),
    emailStubAs(),
    notificationsStubAs(),
  );
}, 120_000);

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

/**
 * Rows written straight to the table, not through `requestDeposit`.
 *
 * This suite is about the READ. Going through the write path would drag in the
 * deposit bounds, the method configuration and the wallet, none of which this
 * asserts — and it could not produce a withdrawal, a settled row or a
 * back-dated `created_at` at all, which are exactly what the filters need.
 */
async function seed(
  owner: string,
  rows: {
    direction: 'deposit' | 'withdrawal';
    amount: string;
    currency: 'USD' | 'USDT';
    state: 'pending' | 'success' | 'failure';
    createdAt: string;
  }[],
): Promise<void> {
  const [wallet] = await Promise.all([wallets.getOrCreateWallet(owner, 'USD')]);
  for (const row of rows) {
    await ctx.db.execute(sql`
      INSERT INTO transactions
        (user_id, wallet_id, direction, amount, currency, state, provider, provider_ref, created_at)
      VALUES (
        ${owner}, ${wallet.id}, ${row.direction}, ${row.amount}, ${row.currency},
        ${row.state}, 'manual_seed', ${`REF-${Math.random().toString(36).slice(2, 10)}`},
        ${row.createdAt}
      )
    `);
  }
}

beforeEach(async () => {
  await ctx.db.execute(sql`DELETE FROM transfers`);
  await ctx.db.execute(sql`DELETE FROM transactions`);
  await ctx.db.execute(sql`DELETE FROM ledger_entries`);
  await ctx.db.execute(sql`DELETE FROM wallets`);
  await ctx.db.execute(sql`DELETE FROM users`);
  userId = await makeClient('history@test.local');
  otherUserId = await makeClient('somebody-else@test.local');
});

/** More rows than any page this endpoint will serve. */
const MANY = 40;

async function seedMany(): Promise<void> {
  await seed(
    userId,
    Array.from({ length: MANY }, (_, index) => ({
      direction: index % 2 === 0 ? ('deposit' as const) : ('withdrawal' as const),
      amount: `${index + 1}.00000000`,
      currency: index % 3 === 0 ? ('USDT' as const) : ('USD' as const),
      state: index % 4 === 0 ? ('pending' as const) : ('success' as const),
      // One per day, so ordering by date is unambiguous.
      createdAt: new Date(Date.UTC(2026, 0, index + 1, 12)).toISOString(),
    })),
  );
}

describe('scope', () => {
  /*
   * ⚠️ FIRST, because everything else is a detail if this is wrong. The owner
   * comes from the session and is a WHERE clause — R-4.4. A history endpoint
   * that leaked another client's rows would be the worst bug on this screen.
   */
  it('returns only the signed-in client’s own rows', async () => {
    await seed(userId, [
      {
        direction: 'deposit',
        amount: '10.00000000',
        currency: 'USD',
        state: 'success',
        createdAt: '2026-01-01T12:00:00Z',
      },
    ]);
    await seed(otherUserId, [
      {
        direction: 'deposit',
        amount: '999.00000000',
        currency: 'USD',
        state: 'success',
        createdAt: '2026-01-02T12:00:00Z',
      },
    ]);

    const page = await transactions.listForUser(userId);

    expect(page.total).toBe(1);
    expect(page.items).toHaveLength(1);
    expect(page.items[0].amount).toBe('10.00000000');
  });
});

describe('filtering, across the WHOLE history rather than a page', () => {
  beforeEach(seedMany);

  /*
   * ⚠️ THE regression, and it needs the row count to show.
   *
   * With client-side filtering over a capped array, the deposits found were the
   * deposits among the newest hundred — and `total` was the length of whatever
   * had been fetched. Asking for one page of a filtered set has to report the
   * count of the FILTERED SET, not of the page and not of the fetch.
   */
  it('counts every matching row, not the ones on this page', async () => {
    const page = await transactions.listForUser(userId, { direction: 'deposit', limit: 5 });

    expect(page.items).toHaveLength(5);
    // 20 of the 40 seeded rows are deposits.
    expect(page.total).toBe(20);
    expect(page.items.every((row) => row.direction === 'deposit')).toBe(true);
  });

  it('narrows by state and by currency', async () => {
    const pending = await transactions.listForUser(userId, { state: 'pending', limit: 100 });
    expect(pending.total).toBe(pending.items.length);
    expect(pending.items.every((row) => row.state === 'pending')).toBe(true);

    const usdt = await transactions.listForUser(userId, { currency: 'USDT', limit: 100 });
    expect(usdt.items.every((row) => row.currency === 'USDT')).toBe(true);
  });

  it('combines filters as AND rather than OR', async () => {
    const both = await transactions.listForUser(userId, {
      direction: 'deposit',
      currency: 'USDT',
      limit: 100,
    });

    expect(both.items.length).toBeGreaterThan(0);
    expect(both.items.every((row) => row.direction === 'deposit' && row.currency === 'USDT')).toBe(
      true,
    );
  });

  /*
   * ⚠️ INCLUSIVE at both ends. Comparing a timestamp against the end date parsed
   * as midnight excludes almost the whole final day — the "my newest transaction
   * vanished when I set an end date" bug the portal's `date-range.ts` exists to
   * prevent, now that the comparison has moved to SQL.
   *
   * The rows are stamped at 12:00, so a `< to` comparison would drop the last
   * day and this asserts it does not.
   */
  it('includes both ends of the date range', async () => {
    const page = await transactions.listForUser(userId, {
      from: '2026-01-01',
      to: '2026-01-05',
      limit: 100,
    });

    expect(page.total).toBe(5);
  });

  it('excludes rows outside the range', async () => {
    const page = await transactions.listForUser(userId, {
      from: '2026-01-10',
      to: '2026-01-12',
      limit: 100,
    });

    expect(page.total).toBe(3);
  });
});

describe('ordering — done by the database', () => {
  /*
   * ⚠️ THE money assertion.
   *
   * `'9.00000000'` versus `'100.00000000'` is where a text comparison gives a
   * plausible, wrong answer: it puts 9 first because it compares '9' to '1'.
   * `amount` is NUMERIC, so Postgres compares the values rather than the text —
   * and this fails loudly if the column is ever changed to something textual, or
   * if the sort is moved back into JavaScript without decimal.js.
   */
  it('orders amounts numerically, not as text', async () => {
    await seed(userId, [
      {
        direction: 'deposit',
        amount: '9.00000000',
        currency: 'USD',
        state: 'success',
        createdAt: '2026-01-01T12:00:00Z',
      },
      {
        direction: 'deposit',
        amount: '100.00000000',
        currency: 'USD',
        state: 'success',
        createdAt: '2026-01-02T12:00:00Z',
      },
      {
        direction: 'deposit',
        amount: '25.00000000',
        currency: 'USD',
        state: 'success',
        createdAt: '2026-01-03T12:00:00Z',
      },
    ]);

    const page = await transactions.listForUser(userId, { sort: 'amount', order: 'desc' });

    expect(page.items.map((row) => row.amount)).toEqual([
      '100.00000000',
      '25.00000000',
      '9.00000000',
    ]);
  });

  it('defaults to newest first', async () => {
    await seedMany();
    const page = await transactions.listForUser(userId, { limit: 3 });

    const dates = page.items.map((row) => row.createdAt.toISOString());
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it('reverses when asked', async () => {
    await seedMany();
    const page = await transactions.listForUser(userId, { order: 'asc', limit: 3 });

    const dates = page.items.map((row) => row.createdAt.toISOString());
    expect([...dates].sort()).toEqual(dates);
  });
});

describe('paging', () => {
  beforeEach(seedMany);

  /*
   * ⚠️ Every row exactly once across the pages — nothing dropped, nothing shown
   * twice. This is the property an off-by-one in the OFFSET breaks, and the
   * failure is a client's own transaction silently missing from their history.
   */
  it('covers the whole history across its pages, without repeating a row', async () => {
    const seen: string[] = [];
    for (let page = 1; page <= 4; page++) {
      const result = await transactions.listForUser(userId, { page, limit: 10 });
      seen.push(...result.items.map((row) => row.id));
    }

    expect(seen).toHaveLength(MANY);
    expect(new Set(seen).size).toBe(MANY);
  });

  it('reports the same total on every page', async () => {
    const first = await transactions.listForUser(userId, { page: 1, limit: 10 });
    const last = await transactions.listForUser(userId, { page: 4, limit: 10 });

    expect(first.total).toBe(MANY);
    expect(last.total).toBe(MANY);
  });

  it('returns an empty page past the end rather than throwing', async () => {
    const page = await transactions.listForUser(userId, { page: 99, limit: 10 });

    expect(page.items).toEqual([]);
    // The total still describes the history, so the screen can say so.
    expect(page.total).toBe(MANY);
  });

  /*
   * A sort with many equal values needs a TIE-BREAKER or paging is undefined:
   * Postgres gives no guarantee about the order of equal rows between queries,
   * so the same row can appear on two pages while another appears on none.
   * `state` has four distinct values across forty rows, which is exactly that
   * case.
   */
  it('pages a low-cardinality sort without dropping or repeating a row', async () => {
    const seen: string[] = [];
    for (let page = 1; page <= 4; page++) {
      const result = await transactions.listForUser(userId, { page, limit: 10, sort: 'state' });
      seen.push(...result.items.map((row) => row.id));
    }

    expect(new Set(seen).size).toBe(MANY);
  });
});
