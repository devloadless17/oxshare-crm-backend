import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { actingAs, startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import { admins, users, wallets } from '../src/database/schema';

/**
 * TWO-WAY CURSOR PAGING AND THE CAPPED TOTAL (9 Oct 2026).
 *
 * The console pages every list First / Previous / Next / Last by cursor, so
 * each page costs the same at any depth, and a total stops at 10,000 ("10,000+")
 * so counting costs the same at any size. These pin the two promises that make
 * that safe to show: walking the pages in any order sees every row exactly once,
 * in order — even rows sharing one timestamp, the case a cursor gets wrong — and
 * a capped total says so instead of passing for exact.
 */

const ADMIN = { email: 'paging-admin@oxshare.com', password: 'admin-password-123' };
const ROWS = 10_005;
const PAGE = 25;

let ctx: HttpTestContext;

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const db = ctx.db.db;
  await db.insert(admins).values({
    email: ADMIN.email,
    passwordHash: await new PasswordService().hash(ADMIN.password),
    name: 'Paging Admin',
    role: 'sub_admin',
    permissions: ['clients.view', 'transactions.view', 'withdrawals.view', 'ib.applications.view'],
    seesAllClients: true,
    status: 'active',
  });
  // One statement: every row shares ONE created_at, so only the id tiebreak
  // orders them — the case a truncated or one-column cursor skips rows on.
  await db.execute(sql`
    INSERT INTO users (email, password_hash, first_name, last_name)
    SELECT 'paging-' || g || '@oxshare-e2e.test', 'x', 'Page', 'Walker'
    FROM generate_series(1, ${ROWS}) g`);

  // Movements for the money lists, again sharing ONE created_at.
  const [client] = await db
    .insert(users)
    .values({
      email: 'paging-money@oxshare.test',
      passwordHash: 'x',
      firstName: 'M',
      lastName: 'N',
    })
    .returning();
  const [wallet] = await db
    .insert(wallets)
    .values({ userId: client.id, currency: 'USD', balance: '0', onHold: '0' })
    .returning();
  await db.execute(sql`
    INSERT INTO transactions
      (user_id, wallet_id, direction, amount, currency, state, provider, provider_ref, destination)
    SELECT ${client.id}, ${wallet.id}, 'withdrawal', '1.00000000', 'USD', 'pending',
           'manual_desk', 'paging-w-' || g, 'x'
    FROM generate_series(1, 260) g`);

  // Partner applications in three statuses, for a cursor on an ENUM sort.
  await db.execute(sql`
    INSERT INTO ib_applications (user_id, status)
    SELECT u.id, (ARRAY['pending','approved','rejected']::ib_application_status[])[1 + (u.n % 3)]
    FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM users
          WHERE email LIKE 'paging-%@oxshare-e2e.test' ORDER BY id LIMIT 90) u`);
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

type Page = {
  items: { id: number }[];
  nextCursor: string | null;
  prevCursor?: string | null;
  total?: number;
  totalCapped?: boolean;
};

const LIST = `/v1/admin/clients?q=${encodeURIComponent('paging-')}&limit=${PAGE}`;

async function get(path: string): Promise<Page> {
  const session = await actingAs(ctx, 'admin', ADMIN);
  return (await session.get(path).expect(200)).body as Page;
}
const ids = (page: Page) => page.items.map((i) => i.id);

describe('two-way cursor paging', () => {
  it('First → Next → Next → Previous → Previous returns to the same rows, in order', async () => {
    const first = await get(LIST);
    expect(first.prevCursor).toBeNull();
    const second = await get(`${LIST}&cursor=${first.nextCursor}`);
    const third = await get(`${LIST}&cursor=${second.nextCursor}`);

    // Newest first, id tiebreak: strictly descending, no repeats across pages.
    const walked = [...ids(first), ...ids(second), ...ids(third)];
    expect(new Set(walked).size).toBe(PAGE * 3);
    expect(walked).toEqual([...walked].sort((a, b) => b - a));

    const backToSecond = await get(`${LIST}&cursor=${third.prevCursor}&dir=prev`);
    expect(ids(backToSecond)).toEqual(ids(second));
    const backToFirst = await get(`${LIST}&cursor=${backToSecond.prevCursor}&dir=prev`);
    expect(ids(backToFirst)).toEqual(ids(first));
    expect(backToFirst.prevCursor).toBeNull();
    expect(backToFirst.nextCursor).not.toBeNull();
  });

  it('Last is the final page in list order, and Previous from it continues backward', async () => {
    const last = await get(`${LIST}&dir=last`);
    expect(last.nextCursor).toBeNull();
    expect(last.items).toHaveLength(PAGE);
    // The oldest rows (lowest ids), still shown newest-first within the page.
    expect(ids(last)).toEqual([...ids(last)].sort((a, b) => b - a));
    const before = await get(`${LIST}&cursor=${last.prevCursor}&dir=prev`);
    expect(Math.min(...ids(before))).toBeGreaterThan(Math.max(...ids(last)));
    expect(ids(before).some((id) => ids(last).includes(id))).toBe(false);
  });

  it('refuses a Previous without a cursor and a Last with one', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    await session.get(`${LIST}&dir=prev`).expect(400);
    const first = await get(LIST);
    await session.get(`${LIST}&dir=last&cursor=${first.nextCursor}`).expect(400);
  });

  it('serves up to 500 rows a page', async () => {
    const page = await get(`/v1/admin/clients?q=paging-&limit=500`);
    expect(page.items).toHaveLength(500);
  });
});

describe('the capped total', () => {
  it('stops at 10,000 and says so, whatever page it is asked on', async () => {
    const first = await get(`${LIST}&withTotal=true`);
    expect(first).toMatchObject({ total: 10_000, totalCapped: true });
    // Asked from a later page it still counts the whole list, not what follows.
    const later = await get(`${LIST}&withTotal=true&cursor=${first.nextCursor}`);
    expect(later).toMatchObject({ total: 10_000, totalCapped: true });
  });

  it('is exact below the cap', async () => {
    const one = await get(`/v1/admin/clients?q=paging-1@oxshare-e2e.test&withTotal=true`);
    expect(one).toMatchObject({ total: 1, totalCapped: false });
  });
});

describe('the money lists page both ways too', () => {
  for (const [name, list] of [
    ['Financial', '/v1/admin/transactions?direction=withdrawal&limit=25'],
    ['Withdrawals', '/v1/admin/withdrawals?state=pending&limit=25'],
  ] as const) {
    it(`${name}: Next, Next, Previous, Last and Previous see each row once, in order`, async () => {
      const first = await get(list);
      const second = await get(`${list}&cursor=${first.nextCursor}`);
      const third = await get(`${list}&cursor=${second.nextCursor}`);
      const back = await get(`${list}&cursor=${third.prevCursor}&dir=prev`);
      expect(ids(back)).toEqual(ids(second));

      const walked = [...ids(first), ...ids(second), ...ids(third)];
      expect(new Set(walked).size).toBe(75);

      const last = await get(`${list}&dir=last`);
      expect(last.nextCursor).toBeNull();
      const beforeLast = await get(`${list}&cursor=${last.prevCursor}&dir=prev`);
      expect(ids(beforeLast).some((id) => ids(last).includes(id))).toBe(false);
      // Last is a FULL page — the final 25 rows — and the one before it 25 more.
      expect(last.items).toHaveLength(25);
      expect(beforeLast.items).toHaveLength(25);
    });
  }
});

describe('a cursor on an enum sort (IB applications by status)', () => {
  it('walks Next and Previous in the enum order with each row once', async () => {
    const list = '/v1/admin/ib/applications?sort=status&order=asc&limit=25';
    type AppPage = { rows: { application: { id: string; status: string } }[] } & Page;
    const getApps = async (path: string) => (await get(path)) as unknown as AppPage;
    const appIds = (p: AppPage) => p.rows.map((r) => r.application.id);

    const first = await getApps(list);
    const second = await getApps(`${list}&cursor=${first.nextCursor}`);
    const back = await getApps(`${list}&cursor=${second.prevCursor}&dir=prev`);
    expect(appIds(back)).toEqual(appIds(first));
    const statuses = [...first.rows, ...second.rows].map((r) => r.application.status);
    const order = ['pending', 'approved', 'rejected'];
    expect(statuses).toEqual([...statuses].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
    expect(new Set([...appIds(first), ...appIds(second)]).size).toBe(50);
  });
});
