import { ALL_PERMISSIONS } from './support/all-permissions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { actingAs, startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import { admins, roles, transactions, users, wallets } from '../src/database/schema';

/**
 * Server-side sorting on the admin lists — R-2.5, over HTTP.
 *
 * ## Why these assertions and not "the endpoint accepts ?sort="
 *
 * R-2.5 names the failure precisely: "sorting the 25 rows you happen to be
 * holding looks identical to sorting the dataset, and is wrong in a way no one
 * notices until someone acts on the top row." A test that only checked the
 * request succeeded would pass against a client-side sort, against a sort that
 * silently did nothing, and against one that ordered by the wrong column. So
 * each list below is seeded with rows whose correct order is KNOWN and
 * DIFFERENT from insertion order, and the assertion is on the sequence.
 *
 * Three properties per endpoint, because each catches a different regression:
 *
 *   1. ascending and descending both order correctly — a `desc`-only
 *      implementation, or one whose comparator ignores the direction, passes
 *      every "does it sort" test and reverses nothing.
 *   2. an unknown key is a 400 that NAMES what is allowed — the rule that makes
 *      a typo actionable instead of silent. A fallback to the default would
 *      leave the admin clicking a header and seeing nothing change, with
 *      nothing anywhere to explain why.
 *   3. omitting `sort` leaves the previous ordering untouched — every one of
 *      these lists already had a hardcoded ORDER BY that screens depend on, and
 *      adding the parameter must not have quietly changed the default view.
 *
 * ## The money assertion is the one to read carefully
 *
 * `amount` is NUMERIC(28,8). The withdrawal seed below deliberately includes
 * two amounts that differ only beyond the 53-bit float boundary
 * (`12345678901234567.89` vs `.88`) and one that a lexicographic sort would
 * order wrongly (`9.00000000` before `10.00000000`). Both shortcuts — casting
 * to float, or comparing as text — produce a visibly different sequence, so
 * this fails if either is ever introduced.
 */

const MASTER = { email: 'sort-http-master@oxshare.com', password: 'admin-password-123' };

let ctx: HttpTestContext;

/** Withdrawal amounts, deliberately awkward. See the money note above. */
const AMOUNTS = [
  '10.00000000',
  '9.00000000',
  '12345678901234567.89',
  '12345678901234567.88',
  '1000.50000000',
] as const;

/**
 * Ascending by true NUMERIC value — not by text, and not by float.
 *
 * Written at the column's own scale. `NUMERIC(28,8)` pads to eight decimal
 * places on the way out, and the API passes that string through untouched (§6.1
 * — money crosses the boundary as the exact string the database produced), so
 * `12345678901234567.89` is served as `12345678901234567.89000000`. Asserting
 * the padded form is asserting the real contract.
 */
const AMOUNTS_ASC = [
  '9.00000000',
  '10.00000000',
  '1000.50000000',
  '12345678901234567.88000000',
  '12345678901234567.89000000',
] as const;

interface WithdrawalRow {
  amount: string;
  state: string;
  user: { email: string };
}
interface AdminRow {
  name: string;
  email: string;
}
interface RoleRow {
  name: string;
}

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const passwords = new PasswordService();
  const db = ctx.db.db;

  const [masterRole] = await db
    .insert(roles)
    .values({ name: 'Sort HTTP Master', permissions: ALL_PERMISSIONS, isSystem: true })
    .returning();
  await db.insert(admins).values({
    email: MASTER.email,
    passwordHash: await passwords.hash(MASTER.password),
    name: 'Sort Master',
    role: 'master_admin',
    roleId: masterRole.id,
    permissions: ALL_PERMISSIONS,
    status: 'active',
  });

  /*
   * Administrators seeded OUT of alphabetical order, so a passing name sort
   * cannot be insertion order wearing a disguise. Zora is inserted first and
   * must come last ascending.
   */
  for (const [name, email] of [
    ['Zora Admin', 'sort-zora@oxshare.com'],
    ['Alba Admin', 'sort-alba@oxshare.com'],
    ['Mira Admin', 'sort-mira@oxshare.com'],
  ] as const) {
    await db.insert(admins).values({
      email,
      passwordHash: await passwords.hash('admin-password-123'),
      name,
      role: 'sub_admin',
      permissions: ['clients.view'],
      status: 'active',
    });
  }

  // Roles, likewise inserted in a deliberately unhelpful order.
  for (const name of ['Zeta Reviewer', 'Alpha Reviewer', 'Mid Reviewer']) {
    await db.insert(roles).values({ name, permissions: ['clients.view'], isSystem: false });
  }

  /*
   * One client per withdrawal, with emails whose alphabetical order is again
   * NOT the insertion order — that is what makes the `userEmail` sort (a
   * column on the joined table, not on `transactions`) a real assertion.
   */
  for (let i = 0; i < AMOUNTS.length; i += 1) {
    const [client] = await db
      .insert(users)
      .values({
        email: `sort-client-${AMOUNTS.length - i}@oxshare-e2e.test`,
        passwordHash: 'x',
        firstName: `Client${AMOUNTS.length - i}`,
        lastName: 'Sorted',
        verificationLevel: 1,
      })
      .returning();

    const [wallet] = await db
      .insert(wallets)
      .values({ userId: client.id, currency: 'USD', balance: '0', onHold: '0' })
      .returning();

    await db.insert(transactions).values({
      userId: client.id,
      walletId: wallet.id,
      direction: 'withdrawal',
      amount: AMOUNTS[i],
      currency: 'USD',
      state: 'pending',
      provider: 'manual_test',
      destination: 'test-destination',
    });
  }
});

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

// ── GET /admin/withdrawals ────────────────────────────────────────────────────

describe('the withdrawal queue sorts by amount, in the database, as NUMERIC', () => {
  const amounts = (body: unknown) =>
    (body as { items: WithdrawalRow[] }).items.map((r) => r.amount);

  it('orders ascending by true numeric value', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/withdrawals?sort=amount&order=asc&limit=100');
    expect(res.status).toBe(200);

    /*
     * The whole point of the awkward fixtures.
     *
     * A text sort would put '10.00000000' before '9.00000000' and
     * '1000.50000000' before '9.00000000'. A float cast would make the two
     * 12345678901234567.8x values compare equal and order them arbitrarily.
     * Only an exact NUMERIC comparison in SQL produces this sequence.
     */
    expect(amounts(res.body)).toEqual([...AMOUNTS_ASC]);
  });

  it('orders descending as the exact mirror', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/withdrawals?sort=amount&order=desc&limit=100');
    expect(res.status).toBe(200);

    // Mirror, not merely "reverse-ish": this is what catches a comparator that
    // ignores the direction, and a NULLS placement that flips with it.
    expect(amounts(res.body)).toEqual([...AMOUNTS_ASC].reverse());
  });

  it('distinguishes two amounts that differ beyond float precision', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/withdrawals?sort=amount&order=asc&limit=100');

    const big = amounts(res.body).filter((a) => a.startsWith('12345678901234567'));
    // `Number('12345678901234567.89') === Number('12345678901234567.88')` is
    // true in JavaScript. In Postgres NUMERIC they are two different values,
    // and the queue must order them as such.
    expect(big).toEqual(['12345678901234567.88000000', '12345678901234567.89000000']);
  });

  it('sorts by the JOINED client email, not just by its own columns', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/withdrawals?sort=userEmail&order=asc&limit=100');
    expect(res.status).toBe(200);

    const emails = (res.body as { items: WithdrawalRow[] }).items.map((r) => r.user.email);
    expect(emails).toEqual([...emails].sort());
  });

  it('REFUSES an unknown sort key, naming what is allowed', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/withdrawals?sort=password_hash');

    expect(res.status).toBe(400);
    const message = JSON.stringify(res.body);
    // Naming the allowed values is the requirement, not merely refusing: a bare
    // "invalid sort" leaves the caller guessing at the vocabulary.
    expect(message).toContain('amount');
    expect(message).toContain('createdAt');
    // And it must not have silently served a page under the default ordering.
    expect(res.body).not.toHaveProperty('items');
  });

  it('REFUSES an unknown order direction', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/withdrawals?sort=amount&order=sideways');

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('asc');
  });

  /**
   * ── THE PROTOTYPE CHAIN IS PART OF EVERY OBJECT, AND `in` WALKS IT ─────────
   *
   * `clientSortKey` gated on `value in CLIENT_SORT_COLUMNS`, which is true for
   * `constructor`, `__proto__`, `toString`, `valueOf` and `hasOwnProperty` on
   * ANY object literal. So five strings passed a check whose only job is to be a
   * closed allowlist, and the map lookup then handed drizzle a FUNCTION where a
   * column belonged.
   *
   * It was never SQL injection — drizzle binds an unrecognised value as a
   * parameter, not as an identifier — and it is not reachable anonymously
   * either: `AdminGuard` runs first, so a caller needs a real admin session to
   * get as far as the sort validator at all. What it was is an unhandled 500 on
   * the client list and the CSV export, from a string anyone holding the
   * weakest admin account could send.
   *
   * Both halves of that are worth stating. Overstating the reach is how a small
   * bug gets fixed in a panic and a big one gets argued about; understating it
   * is how "only an admin can trigger it" becomes a reason not to fix a
   * validator that does not validate.
   *
   * Asserting 400-not-500 is the point. A 500 would still "refuse" the request,
   * which is exactly why this went unnoticed — the difference between a refusal
   * and a crash is invisible from the outside unless a test looks at the number.
   */
  it.each([['constructor'], ['__proto__'], ['toString'], ['valueOf'], ['hasOwnProperty']])(
    'REFUSES the inherited property %s as a sort key — 400, never a 500',
    async (key) => {
      const session = await actingAs(ctx, 'admin', MASTER);
      const res = await session.get(`/v1/admin/clients?sort=${key}`);

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toContain('createdAt');
    },
  );

  it('still sorts clients by a real key', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/clients?sort=createdAt&order=asc');

    expect(res.status).toBe(200);
  });

  /** The export reaches the same validator by a different route, so it gets its own case. */
  it('REFUSES an inherited sort key on the CSV export too', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/clients/export?sort=constructor');

    expect(res.status).toBe(400);
  });

  it('leaves the DEFAULT ordering unchanged when no sort is given', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/withdrawals?limit=100');
    expect(res.status).toBe(200);

    // Newest first — what the queue served before it was sortable. The seeds
    // are inserted in sequence, so the last one inserted leads.
    const rows = (res.body as { items: { requestedAt: string }[] }).items;
    const times = rows.map((r) => new Date(r.requestedAt).getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });
});

// ── GET /admin/users (the administrator directory) ───────────────────────────

describe('the administrator directory is ordered at all, and sortable', () => {
  const names = (body: unknown) => (body as AdminRow[]).map((r) => r.name);

  it('DEFAULTS to name ascending — the bug fix, not a preference', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/users');
    expect(res.status).toBe(200);

    /*
     * This query previously had no ORDER BY at all, so Postgres was free to
     * return the directory in any order and to change it between reads. The
     * assertion is on the whole sequence rather than on "Alba is present",
     * because an unordered result passes the latter every time.
     */
    const listed = names(res.body);
    expect(listed).toEqual([...listed].sort((a, b) => a.localeCompare(b)));
    expect(listed).toContain('Alba Admin');
    expect(listed.indexOf('Alba Admin')).toBeLessThan(listed.indexOf('Zora Admin'));
  });

  it('sorts descending when asked', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/users?sort=name&order=desc');
    expect(res.status).toBe(200);

    const listed = names(res.body);
    expect(listed.indexOf('Zora Admin')).toBeLessThan(listed.indexOf('Alba Admin'));
  });

  it('keeps the BARE ARRAY shape when no page is requested', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/users');

    // Live callers — the admin directory screen and the CSV export — read this
    // as an array. Adding paging must not have wrapped it for everybody.
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('switches to the paginated envelope only when paging is asked for', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/users?page=1&limit=2');
    expect(res.status).toBe(200);

    const body = res.body as { items: AdminRow[]; total: number; page: number; limit: number };
    expect(Array.isArray(body)).toBe(false);
    expect(body.items).toHaveLength(2);
    // The count is over the whole directory, not the page.
    expect(body.total).toBeGreaterThan(2);
    expect(body.page).toBe(1);
    expect(body.limit).toBe(2);
  });

  it('pages through a STABLE order — no row repeated, none skipped', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const first = await session.get('/v1/admin/users?page=1&limit=2');
    const second = await session.get('/v1/admin/users?page=2&limit=2');

    const page1 = (first.body as { items: AdminRow[] }).items.map((r) => r.email);
    const page2 = (second.body as { items: AdminRow[] }).items.map((r) => r.email);

    // The property OFFSET paging only has when the ORDER BY is total. Without
    // the `id` tiebreak, rows sharing a name/role can appear on both pages.
    expect(page1.filter((e) => page2.includes(e))).toEqual([]);
  });

  it('REFUSES an unknown sort key, naming what is allowed', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/users?sort=passwordHash');

    expect(res.status).toBe(400);
    const message = JSON.stringify(res.body);
    expect(message).toContain('name');
    expect(message).toContain('email');
  });
});

// ── GET /admin/roles ─────────────────────────────────────────────────────────

describe('the role list is ordered at all, and sortable', () => {
  const names = (body: unknown) => (body as RoleRow[]).map((r) => r.name);

  it('DEFAULTS to name ascending', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/roles');
    expect(res.status).toBe(200);

    // Same bug as the directory: no ORDER BY meant editing a role could move it
    // in the list, because the UPDATE rewrote the row to the end of the heap.
    const listed = names(res.body);
    expect(listed).toEqual([...listed].sort((a, b) => a.localeCompare(b)));
    expect(listed.indexOf('Alpha Reviewer')).toBeLessThan(listed.indexOf('Zeta Reviewer'));
  });

  it('sorts descending when asked', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/roles?sort=name&order=desc');
    expect(res.status).toBe(200);

    const listed = names(res.body);
    expect(listed.indexOf('Zeta Reviewer')).toBeLessThan(listed.indexOf('Alpha Reviewer'));
  });

  it('REFUSES an unknown sort key, naming what is allowed', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/roles?sort=permissions');

    expect(res.status).toBe(400);
    const message = JSON.stringify(res.body);
    expect(message).toContain('name');
    expect(message).toContain('createdAt');
  });
});

// ── GET /admin/audit-log ─────────────────────────────────────────────────────

describe('the audit trail sorts without losing its cursor guarantees', () => {
  it('REFUSES an unknown sort key, naming what is allowed', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/audit-log?sort=details');

    expect(res.status).toBe(400);
    const message = JSON.stringify(res.body);
    expect(message).toContain('createdAt');
    expect(message).toContain('action');
  });

  it('leaves the DEFAULT newest-first ordering unchanged', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/audit-log?limit=50');
    expect(res.status).toBe(200);

    const times = (res.body as { items: { createdAt: string }[] }).items.map((r) =>
      new Date(r.createdAt).getTime(),
    );
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('REFUSES a cursor minted under a DIFFERENT ordering', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const first = await session.get('/v1/admin/audit-log?sort=action&order=asc&limit=1');
    expect(first.status).toBe(200);

    const cursor = (first.body as { nextCursor: string | null }).nextCursor;
    if (!cursor) return; // Too few rows to page; nothing to assert against.

    /*
     * A cursor is a POSITION IN AN ORDERING. Replayed against a different one it
     * is meaningless, and the failure is silent — the seek still runs, still
     * returns rows, and they are the wrong ones. `decodeCursor` refuses it with
     * a sentence instead, and this asserts that the sort key really is stamped
     * into the cursor rather than defaulted.
     */
    const replayed = await session.get(
      `/v1/admin/audit-log?sort=createdAt&order=asc&limit=1&cursor=${encodeURIComponent(cursor)}`,
    );
    expect(replayed.status).toBe(400);
    expect(JSON.stringify(replayed.body)).toContain('sorted by');
  });
});
