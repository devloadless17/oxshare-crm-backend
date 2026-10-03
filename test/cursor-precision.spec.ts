import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { buildCursorPage } from '../src/common/pagination';
import { ALL_PERMISSIONS } from './support/all-permissions';
import { actingAs, startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import { admins, roles } from '../src/database/schema';

/**
 * A KEYSET PAGE DOES NOT SKIP ROWS THAT SHARE A MILLISECOND.
 *
 * ## The defect, and why it hid
 *
 * `node-postgres` returns a `timestamptz` as a JS `Date`, which holds
 * MILLISECONDS. The column holds MICROSECONDS. So a cursor minted from
 * `Date.toISOString()` is truncated DOWN, and the seek
 *
 *     (created_at, id) < (cursor.value, cursor.id)
 *
 * then excludes the boundary row and EVERY row sharing its millisecond: their
 * `created_at` is greater than the truncated value.
 *
 * `pagination.ts` documents this hazard in the module header — "a cursor minted
 * from the truncated value seeks past every row sharing the boundary row's
 * millisecond — rows silently skipped, the exact failure this module exists to
 * prevent" — and then every call site handed it a Date, because that is what
 * the driver returns. The guard was written and never armed.
 *
 * ## Why a bulk insert is the honest fixture
 *
 * Rows written by ONE statement share a timestamp to the microsecond, so every
 * row after the first page is excluded and page two comes back EMPTY with
 * `nextCursor: null` — the list reporting that it has ended. That is the
 * strongest form of the bug and it is not exotic: an import, a migration, a
 * backfill, or an audit log under load all produce it. On a record whose whole
 * value is completeness, a gap people believe is worse than an outage.
 *
 * Measured before the fix: 200 clients in one INSERT, page 1 returned 25 and
 * page 2 returned 0 of the remaining 175.
 */

const MASTER = { email: 'cursor-precision@oxshare.com', password: 'admin-password-123' };

/** Every TypeScript source file under a root, tests excluded. */
function walkSource(root: string, out: string[] = []): string[] {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) walkSource(path, out);
    else if (path.endsWith('.ts') && !path.endsWith('.spec.ts') && !path.includes('pagination.ts'))
      out.push(path);
  }
  return out;
}

/**
 * Page a list to the end by its cursor, collecting every id.
 *
 * Bounded, so a cursor that never advances fails as a test rather than hanging
 * the suite — which is what a truncated cursor does when the boundary value
 * matches nothing at all.
 */
async function walk(
  session: Awaited<ReturnType<typeof actingAs>>,
  path: string,
  limit = 25,
): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 30; page++) {
    const sep = path.includes('?') ? '&' : '?';
    const url: string =
      `${path}${sep}limit=${limit}` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
    const res = await session.get(url);
    if (res.status !== 200)
      throw new Error(`${url} answered ${res.status}: ${JSON.stringify(res.body)}`);
    const body = res.body as { items: { id: string }[]; nextCursor: string | null };
    seen.push(...body.items.map((r) => r.id));
    cursor = body.nextCursor;
    if (!cursor) break;
  }
  return seen;
}
const ROWS = 200;
const LIMIT = 25;

let ctx: HttpTestContext;

interface Page {
  items: { id: string }[];
  nextCursor: string | null;
}

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const db = ctx.db.db;
  const passwords = new PasswordService();

  const [masterRole] = await db
    .insert(roles)
    .values({ name: 'Cursor Master', permissions: ALL_PERMISSIONS, isSystem: true })
    .returning();
  await db.insert(admins).values({
    email: MASTER.email,
    passwordHash: await passwords.hash(MASTER.password),
    name: 'Cursor Master',
    role: 'master_admin',
    roleId: masterRole.id,
    permissions: ALL_PERMISSIONS,
    status: 'active',
  });

  // ONE statement, so every row shares `created_at` to the microsecond.
  await db.execute(sql`
    INSERT INTO users (email, password_hash, first_name, last_name)
    SELECT 'cursor-' || i || '@oxshare-e2e.test', 'x', 'Cursor', 'Person'
    FROM generate_series(1, ${ROWS}) AS i
  `);
}, 300_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('no paging call site mints its cursor from a Date', () => {
  /*
   * THE GENERAL FORM, derived from the source, because this defect was in SEVEN
   * of eight call sites and fixing four of them looked exactly like fixing all
   * of them.
   *
   * A cursor is only as precise as the value it is minted from, and the driver
   * hands back a Date. So every file that calls `buildCursorPage` must supply
   * the sort value at full precision — as a selected `cursorValue`, or as a raw
   * Postgres literal from a raw query, which is the one place it was already
   * right.
   */
  const CALLERS = [
    'src/modules/admin/admin-clients.service.ts',
    'src/modules/admin/admin-holdings.service.ts',
    'src/modules/payments/queries/transaction-queries.ts',
    'src/modules/wallet/wallet.service.ts',
    'src/store/audit-log.store.ts',
    'src/store/notifications.store.ts',
  ] as const;

  it('finds every caller rather than trusting the list', () => {
    /*
     * The floor, and the reason this case exists at all: the list above is
     * maintained by hand, so a new caller that nobody adds would be a new
     * instance of the bug with a green suite. This derives the callers from the
     * source and refuses a mismatch in either direction.
     */
    /*
     * Separators normalised, because `walkSource` builds paths with `join`
     * and the list above is written the way this repository spells a path.
     * On Windows the two differ, so this compared backslash paths against
     * slash ones and failed with two lists a reader has to diff character by
     * character to see name the same six files. The census is about WHICH
     * files call buildCursorPage, never about how the host writes a path.
     */
    const found = walkSource('src')
      .filter((file) => /buildCursorPage\(/.test(readFileSync(file, 'utf8')))
      .map((file) => file.split('\\').join('/'));
    expect(found.sort(), 'the set of cursor-paging call sites has changed').toEqual(
      [...CALLERS].sort(),
    );
  });

  it('REFUSES to mint a cursor from a Date rather than truncating one', () => {
    /*
     * The guarantee that makes the list above documentation rather than the
     * check. A source-text census cannot do this job: the clients list supplies
     * its raw value from `users.store.ts`, two files away from the call, so a
     * per-file rule reports a correct caller as broken — which is exactly what
     * the first version of this case did.
     *
     * So the refusal lives where the information is. A call site that has not
     * been fixed fails loudly at the call instead of serving a page that
     * silently skips rows.
     */
    expect(() =>
      buildCursorPage(
        [
          { id: '11111111-1111-4111-8111-111111111111', createdAt: new Date() },
          { id: '22222222-2222-4222-8222-222222222222', createdAt: new Date() },
        ],
        1,
      ),
    ).toThrow(/milliseconds/i);
  });

  it('accepts the raw literal, which is what every call site now supplies', () => {
    const page = buildCursorPage(
      [
        {
          id: '11111111-1111-4111-8111-111111111111',
          createdAt: new Date(),
          cursorValue: '2026-09-15 13:19:41.496123+00',
        },
        {
          id: '22222222-2222-4222-8222-222222222222',
          createdAt: new Date(),
          cursorValue: '2026-09-15 13:19:41.496124+00',
        },
      ],
      1,
    );
    expect(page.nextCursor).toBeTruthy();
    const decoded = JSON.parse(Buffer.from(page.nextCursor!, 'base64url').toString('utf8')) as {
      value: string;
    };
    // MICROSECONDS survive. A Date would have arrived as '…496Z'.
    expect(decoded.value).toBe('2026-09-15 13:19:41.496123+00');
  });
});

describe('paging a list whose rows were written together', () => {
  it('the fixture really does share one timestamp', async () => {
    /*
     * The floor. If a future Postgres or driver gave these rows distinct
     * timestamps, every case below would pass while testing nothing — the bug
     * only exists at a shared boundary.
     */
    const { rows } = await ctx.db.db.execute<{ n: string }>(sql`
      SELECT count(DISTINCT created_at) AS n FROM users
      WHERE email LIKE 'cursor-%@oxshare-e2e.test'
    `);
    expect(Number(rows[0].n)).toBe(1);
  });

  it('walks every row with no gap and no repeat', async () => {
    const admin = await actingAs(ctx, 'admin', MASTER);
    const seen: string[] = [];
    let cursor: string | null = null;

    // Bounded, so a cursor that never advances fails as a test rather than
    // hanging the suite.
    for (let page = 0; page < 20; page++) {
      const url: string =
        `/v1/admin/clients?limit=${LIMIT}&withTotal=false` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
      const res = await admin.get(url);
      expect(res.status, JSON.stringify(res.body)).toBe(200);

      const body = res.body as Page;
      seen.push(...body.items.map((r) => r.id));
      cursor = body.nextCursor;
      if (!cursor) break;
    }

    // Every seeded client, exactly once. Before the fix this stopped at 25.
    const { rows } = await ctx.db.db.execute<{ n: string }>(sql`SELECT count(*) AS n FROM users`);
    expect(seen.length, 'the walk did not reach every client').toBe(Number(rows[0].n));
    expect(new Set(seen).size, 'a client was served on two pages').toBe(seen.length);
  });

  it('page TWO is not empty — the shape the bug took', async () => {
    // Stated on its own because it is the symptom somebody would report: the
    // list looks complete, and it is one page long.
    const admin = await actingAs(ctx, 'admin', MASTER);
    const first = await admin.get(`/v1/admin/clients?limit=${LIMIT}&withTotal=false`);
    const cursor = (first.body as Page).nextCursor;
    expect(cursor, 'the first page offered no cursor to continue with').toBeTruthy();

    const second = await admin.get(
      `/v1/admin/clients?limit=${LIMIT}&withTotal=false&cursor=${encodeURIComponent(cursor!)}`,
    );
    expect(second.status).toBe(200);
    expect((second.body as Page).items.length).toBe(LIMIT);
  });

  it('the AUDIT LOG walks every row too — the list this matters most on', async () => {
    /*
     * Append-only, written many times a second under load, and read as
     * evidence. Two rows sharing a millisecond is the ordinary case here rather
     * than the exotic one, so a millisecond-truncated cursor loses rows on an
     * ordinary afternoon — and the reader has no way to tell.
     */
    await ctx.db.db.execute(sql`
      INSERT INTO audit_log (actor_id, actor_email, actor_kind, action, subject_type, subject_id)
      SELECT gen_random_uuid(), 'bulk@oxshare.com', 'admin', 'client.suspend', 'user',
             gen_random_uuid()::text
      FROM generate_series(1, 120) AS i
    `);

    const admin = await actingAs(ctx, 'admin', MASTER);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const url: string =
        `/v1/admin/audit-log?limit=${LIMIT}` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
      const res = await admin.get(url);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const body = res.body as Page;
      seen.push(...body.items.map((r) => r.id));
      cursor = body.nextCursor;
      if (!cursor) break;
    }

    const { rows } = await ctx.db.db.execute<{ n: string }>(sql`
      SELECT count(*) AS n FROM audit_log
    `);
    expect(seen.length, 'the audit walk did not reach every row').toBe(Number(rows[0].n));
    expect(new Set(seen).size, 'an audit row was served twice').toBe(seen.length);
  });

  it('the LEDGER walks every entry — the record a reconciliation is read from', async () => {
    /*
     * Ledger rows written inside ONE transaction share `created_at` exactly,
     * and this list orders by that column alone. A truncated cursor therefore
     * skips movements on the screen an operator opens when the books do not
     * balance — the one place a missing row is most expensive and least likely
     * to be noticed, because the reader is already looking for something odd.
     */
    await ctx.db.db.execute(sql`
      INSERT INTO wallets (user_id, currency, kind, balance)
      SELECT id, 'USD', 'main', '0' FROM users LIMIT 120
    `);
    await ctx.db.db.execute(sql`
      INSERT INTO ledger_entries
        (wallet_id, entry_type, amount, balance_after, reference_type, reference_id)
      SELECT id, 'adjustment', '0', '0', 'manual', gen_random_uuid()::text FROM wallets
    `);

    const admin = await actingAs(ctx, 'admin', MASTER);
    const seen = await walk(admin, '/v1/admin/ledger');

    const { rows } = await ctx.db.db.execute<{ n: string }>(sql`
      SELECT count(*) AS n FROM ledger_entries
    `);
    expect(seen.length, 'the ledger walk did not reach every entry').toBe(Number(rows[0].n));
    expect(new Set(seen).size, 'a ledger entry was served twice').toBe(seen.length);
  });

  it('the WITHDRAWAL desk walks every request', async () => {
    /*
     * Withdrawals submitted together — a batch, a provider callback storm —
     * share a millisecond, and a desk paging its own queue would not see them.
     */
    await ctx.db.db.execute(sql`
      INSERT INTO transactions (user_id, wallet_id, direction, amount, currency, state, provider,
                                destination, withdrawal_method_key)
      SELECT w.user_id, w.id, 'withdrawal', '1.00', 'USD', 'pending', 'whish',
             '+96170111222', NULL
      FROM wallets w LIMIT 120
    `);

    const admin = await actingAs(ctx, 'admin', MASTER);
    const seen = await walk(admin, '/v1/admin/withdrawals');

    const { rows } = await ctx.db.db.execute<{ n: string }>(sql`
      SELECT count(*) AS n FROM transactions WHERE direction = 'withdrawal'
    `);
    expect(seen.length, 'the withdrawal walk did not reach every request').toBe(Number(rows[0].n));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('does not leak the seek artefact into the response', async () => {
    /*
     * The fix carries the raw sort value on the row as `cursorValue`, and
     * `buildCursorPage` strips it. If it ever survives, the API is returning a
     * key no DTO declares — which `response-completeness.spec.ts` refuses, and
     * which the field-mask interceptor cannot mask because the shape does not
     * mention it.
     */
    const admin = await actingAs(ctx, 'admin', MASTER);
    const res = await admin.get(`/v1/admin/clients?limit=5&withTotal=false`);
    const items = (res.body as { items: Record<string, unknown>[] }).items;
    expect(items.length).toBeGreaterThan(0);
    for (const row of items) expect(Object.keys(row)).not.toContain('cursorValue');
  });
});
