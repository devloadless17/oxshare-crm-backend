import { ALL_PERMISSIONS } from './support/all-permissions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  actingAs,
  anonymous,
  startHttpTestApp,
  stopHttpTestApp,
  type HttpTestContext,
} from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import {
  adminClientTagScopes,
  admins,
  clientTagAssignments,
  clientTags,
  roles,
  users,
  wallets,
} from '../src/database/schema';

/**
 * `GET /v1/admin/wallets` — the client-balance list.
 *
 * Three properties are worth more than the rest of this file put together:
 *
 *  1. **A scoped admin sees only their own clients' wallets.** These are
 *     client-owned money rows, so the predicate is in the WHERE clause and an
 *     out-of-scope wallet never enters the result set — not the items, not the
 *     `total`, not the cursor.
 *  2. **Balances come back as the exact strings the column holds.** The seed
 *     below deliberately uses a value wider than a JavaScript number represents
 *     exactly, so a `Number()` anywhere on the path shows up as a changed
 *     string rather than as a rounding nobody notices.
 *  3. **An unknown sort key is a 400 naming what IS allowed** — R-2.5. A
 *     silently ignored sort is a lie the UI tells.
 */

const MASTER = { email: 'wallets-master@oxshare.com', password: 'admin-password-123' };
const SCOPED = { email: 'wallets-scoped@oxshare.com', password: 'admin-password-123' };
const NO_PERMS = { email: 'wallets-nobody@oxshare.com', password: 'admin-password-123' };

/**
 * A balance wider than `Number.MAX_SAFE_INTEGER` by a long way.
 *
 * `Number('12345678901234567.89012345')` is `12345678901234568` — the fraction
 * is gone entirely and the integer part is wrong. So if any layer coerces, this
 * value cannot survive, and the assertion below is a real test of §6.1 rather
 * than a restatement of it.
 */
const HUGE_BALANCE = '12345678901234567.89012345';

let ctx: HttpTestContext;
let mineId: string;
let theirsId: string;
let hugeWalletId: string;

interface WalletRow {
  id: string;
  balance: string;
  onHold: string;
  currency: string;
  user: { id: string; email: string };
}

interface WalletList {
  items: WalletRow[];
  nextCursor: string | null;
  total: number;
  page: number;
  limit: number;
}

const body = (res: { body: unknown }) => res.body as WalletList;
const ownerIds = (res: { body: unknown }) => body(res).items.map((w) => w.user.id);

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const passwords = new PasswordService();
  const db = ctx.db.db;

  const [masterRole] = await db
    .insert(roles)
    .values({ name: 'Wallets Master', permissions: ALL_PERMISSIONS, isSystem: true })
    .returning();
  await db.insert(admins).values({
    email: MASTER.email,
    passwordHash: await passwords.hash(MASTER.password),
    name: 'Wallets Master',
    role: 'master_admin',
    roleId: masterRole.id,
    permissions: ALL_PERMISSIONS,
    status: 'active',
    // Territory isolation is this file's subject - restrict from the
    // intake pool explicitly (the 0058 default is TRUE).
    seesUntriaged: false,
  });

  /*
   * The scoped admin holds the permission the route requires.
   *
   * Deliberate, and the same reasoning `client-scope-enforcement.spec.ts`
   * records: if the leak assertion below failed because of a missing permission
   * rather than a missing scope, this file would report that scoping works when
   * it does not. The only thing constraining this admin is territory.
   */
  const [scopedRole] = await db
    .insert(roles)
    /*
     * `wallets.view`, not `withdrawals.view` — the key this surface actually
     * requires since the permission rework gave holdings their own. The
     * fixture kept the old one, so every scope assertion below was answered
     * 403 before any scoping ran: the file's whole subject was unreachable,
     * and it failed saying "expected 200" rather than "you granted the wrong
     * key".
     */
    .values({ name: 'Wallets Scoped', permissions: ['wallets.view', 'clients.view'] })
    .returning();
  const [scopedAdmin] = await db
    .insert(admins)
    .values({
      email: SCOPED.email,
      passwordHash: await passwords.hash(SCOPED.password),
      name: 'Wallets Scoped',
      role: 'sub_admin',
      roleId: scopedRole.id,
      permissions: [],
      status: 'active',
      // Territory isolation is this file's subject - restrict from the
      // intake pool explicitly (the 0058 default is TRUE).
      seesUntriaged: false,
    })
    .returning();

  // Holds a permission, just not THIS one — so the 403 below is about the
  // specific key rather than about being unauthenticated.
  const [weakRole] = await db
    .insert(roles)
    .values({ name: 'Wallets Nobody', permissions: ['tags.view'] })
    .returning();
  await db.insert(admins).values({
    email: NO_PERMS.email,
    passwordHash: await passwords.hash(NO_PERMS.password),
    name: 'Wallets Nobody',
    role: 'sub_admin',
    roleId: weakRole.id,
    permissions: [],
    status: 'active',
    // Territory isolation is this file's subject - restrict from the
    // intake pool explicitly (the 0058 default is TRUE).
    seesUntriaged: false,
  });

  const [mineTag] = await db
    .insert(clientTags)
    .values({ slug: 'wallets-mine', label: 'Wallets Mine' })
    .returning();

  const [mine] = await db
    .insert(users)
    .values({
      email: 'wallets-mine@oxshare-e2e.test',
      passwordHash: 'x',
      firstName: 'Mine',
      lastName: 'Client',
    })
    .returning();
  const [theirs] = await db
    .insert(users)
    .values({
      email: 'wallets-theirs@oxshare-e2e.test',
      passwordHash: 'x',
      firstName: 'Theirs',
      lastName: 'Client',
    })
    .returning();
  mineId = mine.id;
  theirsId = theirs.id;

  await db.insert(clientTagAssignments).values({ userId: mineId, tagId: mineTag.id });
  await db.insert(adminClientTagScopes).values({
    adminId: scopedAdmin.id,
    tagId: mineTag.id,
    createdBy: scopedAdmin.id,
  });

  /*
   * `wallets_user_currency_kind_uq` means one wallet per client per currency PER
   * KIND, so the two clients get one main USD wallet each and `mine` gets a USDT
   * one for the currency filter to have something to distinguish.
   *
   * The conflict target must name all THREE columns — migration 0077 widened the
   * index, and a target that matches no unique index is a runtime error rather
   * than a compile one, which is how this suite stopped collecting entirely.
   *
   * Registration also opens wallets for every enabled currency, so these
   * inserts are `onConflictDoNothing` and the ids are read back rather than
   * assumed — a seeded row would otherwise collide and fail the whole suite.
   */
  const [hugeWallet] = await db
    .insert(wallets)
    .values({ userId: mineId, currency: 'USD', balance: HUGE_BALANCE, onHold: '0' })
    .onConflictDoUpdate({
      target: [wallets.userId, wallets.currency, wallets.kind],
      set: { balance: HUGE_BALANCE },
    })
    .returning();
  hugeWalletId = hugeWallet.id;

  await db
    .insert(wallets)
    .values({ userId: mineId, currency: 'USDT', balance: '5.50000000', onHold: '1.25000000' })
    .onConflictDoUpdate({
      target: [wallets.userId, wallets.currency, wallets.kind],
      set: { balance: '5.50000000', onHold: '1.25000000' },
    });

  await db
    .insert(wallets)
    .values({ userId: theirsId, currency: 'USD', balance: '77.00000000', onHold: '0' })
    .onConflictDoUpdate({
      target: [wallets.userId, wallets.currency, wallets.kind],
      set: { balance: '77.00000000' },
    });
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('listing and paging', () => {
  it('lists wallets with their owner joined, and a total', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/wallets?limit=100');

    expect(res.status).toBe(200);
    expect(body(res).items.length).toBeGreaterThanOrEqual(3);
    expect(body(res).total).toBeGreaterThanOrEqual(3);

    // The owner comes from the INNER JOIN, not from a per-row lookup.
    const row = body(res).items.find((w) => w.id === hugeWalletId);
    expect(row?.user.id).toBe(mineId);
    expect(row?.user.email).toBe('wallets-mine@oxshare-e2e.test');
  });

  it('pages with a cursor, and the second page does not repeat the first', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const first = await session.get('/v1/admin/wallets?limit=2');

    expect(first.status).toBe(200);
    expect(body(first).items).toHaveLength(2);
    expect(body(first).nextCursor).not.toBeNull();

    const second = await session.get(
      `/v1/admin/wallets?limit=2&cursor=${encodeURIComponent(body(first).nextCursor ?? '')}`,
    );
    expect(second.status).toBe(200);

    const firstIds = body(first).items.map((w) => w.id);
    const secondIds = body(second).items.map((w) => w.id);
    // The property keyset paging exists for: no row appears on two pages.
    expect(secondIds.filter((id) => firstIds.includes(id))).toEqual([]);
  });

  it('refuses a cursor minted under a different ordering', async () => {
    // A cursor is a POSITION IN AN ORDERING. Replayed against another one it
    // still returns `limit` rows and they are the wrong ones, so it is refused
    // with a sentence rather than silently misinterpreted.
    const session = await actingAs(ctx, 'admin', MASTER);
    const first = await session.get('/v1/admin/wallets?limit=1&sort=balance');
    const cursor = body(first).nextCursor ?? '';

    const replayed = await session.get(
      `/v1/admin/wallets?limit=1&sort=currency&cursor=${encodeURIComponent(cursor)}`,
    );
    expect(replayed.status).toBe(400);
  });
});

describe('filters', () => {
  it('filters by userId', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get(`/v1/admin/wallets?userId=${theirsId}&limit=100`);

    expect(res.status).toBe(200);
    expect(body(res).items.length).toBeGreaterThan(0);
    expect(new Set(ownerIds(res))).toEqual(new Set([theirsId]));
  });

  it('filters by currency', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/wallets?currency=USDT&limit=100');

    expect(res.status).toBe(200);
    expect(body(res).items.length).toBeGreaterThan(0);
    for (const wallet of body(res).items) expect(wallet.currency).toBe('USDT');
  });

  it('combines both filters', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get(`/v1/admin/wallets?userId=${mineId}&currency=USD&limit=100`);

    expect(res.status).toBe(200);
    expect(body(res).items).toHaveLength(1);
    expect(body(res).items[0].id).toBe(hugeWalletId);
  });
});

describe('sorting — R-2.5', () => {
  it('sorts by balance ascending and descending, and they are mirrors', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);

    const asc = await session.get('/v1/admin/wallets?sort=balance&order=asc&limit=100');
    const desc = await session.get('/v1/admin/wallets?sort=balance&order=desc&limit=100');

    expect(asc.status).toBe(200);
    expect(desc.status).toBe(200);

    const ascIds = body(asc).items.map((w) => w.id);
    const descIds = body(desc).items.map((w) => w.id);
    expect(ascIds).toEqual([...descIds].reverse());

    /*
     * The huge balance sorts LAST ascending — which is the money assertion
     * hiding inside a sorting test. Compared as a float it would collapse
     * against any other large value; Postgres compares `numeric` exactly, so it
     * lands where its true value puts it.
     */
    expect(ascIds[ascIds.length - 1]).toBe(hugeWalletId);
  });

  it('sorts by currency', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/wallets?sort=currency&order=asc&limit=100');

    expect(res.status).toBe(200);
    const codes = body(res).items.map((w) => w.currency);
    expect(codes).toEqual([...codes].sort());
  });

  it('400s on an unknown sort key, naming what IS allowed', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/wallets?sort=balance_desc');

    // Never a silent fallback to the default: the admin clicks a header, the
    // rows come back in the order they were already in, and nothing explains why.
    expect(res.status).toBe(400);
    const message = JSON.stringify(res.body);
    expect(message).toContain('balance_desc');
    // The message names the allowlist, so the caller can act on it.
    expect(message).toContain('currency');
  });

  it('400s on an unknown order', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/wallets?order=sideways');
    expect(res.status).toBe(400);
  });
});

describe('money crosses the boundary as an unmodified string — §6.1', () => {
  it('returns the balance byte-identical to what was stored', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get(`/v1/admin/wallets?userId=${mineId}&currency=USD`);

    expect(res.status).toBe(200);
    const wallet = body(res).items[0];

    // The assertion. `Number(HUGE_BALANCE)` is 12345678901234568 — so any
    // coercion anywhere on this path fails here rather than in production.
    expect(wallet.balance).toBe(HUGE_BALANCE);
    expect(typeof wallet.balance).toBe('string');
  });

  it('returns onHold as a string too', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get(`/v1/admin/wallets?userId=${mineId}&currency=USDT`);

    const wallet = body(res).items[0];
    expect(typeof wallet.onHold).toBe('string');
    expect(wallet.onHold).toBe('1.25000000');
  });

  it('serves the balance as a JSON string, not a JSON number', async () => {
    // `expect(x).toBe('...')` above would also pass if the value arrived as a
    // number and something stringified it on the way in. This reads the raw
    // body text, where a number is unquoted and a string is not.
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get(`/v1/admin/wallets?userId=${mineId}&currency=USD`);

    expect(res.text).toContain(`"balance":"${HUGE_BALANCE}"`);
    expect(res.text).not.toContain(`"balance":${HUGE_BALANCE}`);
  });
});

describe('client scope — the top correctness property', () => {
  it("a scoped admin sees only their own clients' wallets", async () => {
    const session = await actingAs(ctx, 'admin', SCOPED);
    const res = await session.get('/v1/admin/wallets?limit=100');

    expect(res.status).toBe(200);
    // The leak assertion. `theirs` carries no tag, so this admin's territory
    // does not include them.
    expect(ownerIds(res)).not.toContain(theirsId);
  });

  it('DOES see wallets inside its territory — the control', async () => {
    /*
     * Without this, "excludes theirs" would pass just as well against a list
     * that returns nothing at all, which is a broken screen rather than a
     * working control.
     */
    const session = await actingAs(ctx, 'admin', SCOPED);
    const res = await session.get('/v1/admin/wallets?limit=100');
    expect(ownerIds(res)).toContain(mineId);
  });

  it('a MASTER admin sees both — the other control', async () => {
    // Proves the exclusion above is about SCOPE and not about the row being
    // missing, filtered by something else, or the fixture being broken.
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/wallets?limit=100');

    expect(ownerIds(res)).toContain(mineId);
    expect(ownerIds(res)).toContain(theirsId);
  });

  it('excludes out-of-scope rows from the TOTAL, not just from the page', async () => {
    /*
     * The half a post-fetch filter would get wrong.
     *
     * If the predicate were applied after the query, the rows would be absent
     * from `items` while `total` still counted them — and the screen would show
     * "1 of 3" with two invisible rows, which is a scope leak expressed as a
     * number instead of as a row.
     */
    const scoped = await actingAs(ctx, 'admin', SCOPED);
    const master = await actingAs(ctx, 'admin', MASTER);

    const scopedRes = await scoped.get('/v1/admin/wallets?limit=100');
    const masterRes = await master.get('/v1/admin/wallets?limit=100');

    expect(body(scopedRes).total).toBe(body(scopedRes).items.length);
    expect(body(scopedRes).total).toBeLessThan(body(masterRes).total);
  });

  it('cannot be escaped with an explicit userId filter', async () => {
    // The obvious bypass attempt: name the client directly. The scope predicate
    // is ANDed into the same WHERE clause, so it still wins.
    const session = await actingAs(ctx, 'admin', SCOPED);
    const res = await session.get(`/v1/admin/wallets?userId=${theirsId}&limit=100`);

    expect(res.status).toBe(200);
    expect(body(res).items).toEqual([]);
  });
});

describe('permissions', () => {
  it('403s for an admin without withdrawals.view', async () => {
    const session = await actingAs(ctx, 'admin', NO_PERMS);
    const res = await session.get('/v1/admin/wallets');

    // 403, never 401 — a 401 would log the admin out of a screen they simply
    // may not read (§8.8).
    expect(res.status).toBe(403);
  });

  it('403s on the export for the same admin', async () => {
    // An export must never require less than its list.
    const session = await actingAs(ctx, 'admin', NO_PERMS);
    const res = await session.get('/v1/admin/wallets/export');
    expect(res.status).toBe(403);
  });

  it('401s with no session at all', async () => {
    // The other half of the 403 above: no cookie is a different failure from
    // the wrong permission, and both must be refused.
    const res = await anonymous(ctx).get('/v1/admin/wallets');
    expect(res.status).toBe(401);
  });
});

describe('the CSV export', () => {
  it('streams a CSV naming the file and the balances', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/wallets/export');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('wallets-');

    expect(res.text).toContain('Balance');
    // The same §6.1 property as the list: the exact string, never re-formatted.
    // A CSV is the output most likely to be re-imported into a spreadsheet that
    // does arithmetic on it.
    expect(res.text).toContain(HUGE_BALANCE);
  });

  it('applies the client scope to the file, exactly as to the list', async () => {
    const session = await actingAs(ctx, 'admin', SCOPED);
    const res = await session.get('/v1/admin/wallets/export');

    expect(res.status).toBe(200);
    expect(res.text).toContain('wallets-mine@oxshare-e2e.test');
    // The worst defect available in this feature: a scoped admin handed a file
    // of the clients they were specifically denied, with a 200 and no error.
    expect(res.text).not.toContain('wallets-theirs@oxshare-e2e.test');
  });

  it('400s on a format it cannot write, rather than renaming a CSV', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/wallets/export?format=xlsx');
    expect(res.status).toBe(400);
  });
});
