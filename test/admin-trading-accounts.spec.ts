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
  tradingAccounts,
  users,
} from '../src/database/schema';

/**
 * `GET /v1/admin/trading-accounts` — the client trading-account list.
 *
 * The sibling of `admin-wallets.spec.ts` and asserts the same three properties
 * for the same reasons: client scope in the WHERE clause, balances as
 * unmodified strings, and a 400 on an unrecognised sort key.
 *
 * Two things differ and each has its own case below:
 *
 *  - `environment` and `status` are real Postgres ENUMS, so an unrecognised
 *    value must be a 400 naming the allowed set rather than a 500 carrying a
 *    database error (R-2.5). The wallet list's `currency` filter is a varchar
 *    against an operator-managed table and is legitimately just an empty list.
 *  - `login` is NULLABLE, so its sort pins NULLS LAST in BOTH directions —
 *    otherwise "lowest login first" leads with every account that has no login,
 *    which today is most of them.
 */

const MASTER = { email: 'ta-master@oxshare.com', password: 'admin-password-123' };
const SCOPED = { email: 'ta-scoped@oxshare.com', password: 'admin-password-123' };
const NO_PERMS = { email: 'ta-nobody@oxshare.com', password: 'admin-password-123' };

/** Wider than a JavaScript number represents exactly — see the wallet spec. */
const HUGE_BALANCE = '12345678901234567.89012345';

let ctx: HttpTestContext;
let mineId: string;
let theirsId: string;
let liveAccountId: string;
let demoAccountId: string;
let noLoginAccountId: string;

interface AccountRow {
  id: string;
  login: string | null;
  environment: string;
  status: string;
  balance: string;
  currency: string;
  user: { id: string; email: string };
}

interface AccountList {
  items: AccountRow[];
  nextCursor: string | null;
  total: number;
  page: number;
  limit: number;
}

const body = (res: { body: unknown }) => res.body as AccountList;
const ownerIds = (res: { body: unknown }) => body(res).items.map((a) => a.user.id);

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const passwords = new PasswordService();
  const db = ctx.db.db;

  const [masterRole] = await db
    .insert(roles)
    .values({ name: 'TA Master', permissions: ALL_PERMISSIONS, isSystem: true })
    .returning();
  await db.insert(admins).values({
    email: MASTER.email,
    passwordHash: await passwords.hash(MASTER.password),
    name: 'TA Master',
    role: 'master_admin',
    roleId: masterRole.id,
    permissions: ALL_PERMISSIONS,
    status: 'active',
  });

  // Holds the route's permission; only territory constrains them.
  const [scopedRole] = await db
    .insert(roles)
    /*
     * `trading.view`, not `withdrawals.view` — the key both routes here
     * require since holdings were split out of the money keys. Same stale
     * fixture as `admin-wallets.spec.ts`: without it every scope assertion
     * below was refused before any scoping happened.
     */
    .values({ name: 'TA Scoped', permissions: ['clients.view', 'trading.view'] })
    .returning();
  const [scopedAdmin] = await db
    .insert(admins)
    .values({
      email: SCOPED.email,
      passwordHash: await passwords.hash(SCOPED.password),
      name: 'TA Scoped',
      role: 'sub_admin',
      roleId: scopedRole.id,
      permissions: [],
      status: 'active',
    })
    .returning();

  const [weakRole] = await db
    .insert(roles)
    .values({ name: 'TA Nobody', permissions: ['tags.view'] })
    .returning();
  await db.insert(admins).values({
    email: NO_PERMS.email,
    passwordHash: await passwords.hash(NO_PERMS.password),
    name: 'TA Nobody',
    role: 'sub_admin',
    roleId: weakRole.id,
    permissions: [],
    status: 'active',
  });

  const [mineTag] = await db
    .insert(clientTags)
    .values({ slug: 'ta-mine', label: 'TA Mine' })
    .returning();

  const [mine] = await db
    .insert(users)
    .values({
      email: 'ta-mine@oxshare-e2e.test',
      passwordHash: 'x',
      firstName: 'Mine',
      lastName: 'Client',
    })
    .returning();
  const [theirs] = await db
    .insert(users)
    .values({
      email: 'ta-theirs@oxshare-e2e.test',
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
   * Four accounts covering every axis the assertions need: both environments,
   * a suspended status, a null login, and the wide balance.
   *
   * `trading_accounts_login_uq` is unique WHERE NOT NULL, so the two null-login
   * rows do not collide — which is itself the schema behaviour that makes the
   * NULLS LAST sort worth pinning.
   */
  const [live] = await db
    .insert(tradingAccounts)
    .values({
      userId: mineId,
      login: '00012345',
      mt5Group: 'real\\Standard',
      environment: 'live',
      currency: 'USD',
      balance: HUGE_BALANCE,
      tier: 'standard',
      leverage: 100,
      status: 'active',
    })
    .returning();
  liveAccountId = live.id;

  const [demo] = await db
    .insert(tradingAccounts)
    .values({
      userId: mineId,
      login: '00099999',
      environment: 'demo',
      currency: 'USD',
      balance: '10000.00000000',
      status: 'active',
    })
    .returning();
  demoAccountId = demo.id;

  // No login yet — the ordinary shape today, since there is no MT5 bridge.
  const [noLogin] = await db
    .insert(tradingAccounts)
    .values({
      userId: mineId,
      environment: 'live',
      currency: 'USD',
      balance: '0',
      status: 'suspended',
    })
    .returning();
  noLoginAccountId = noLogin.id;

  await db.insert(tradingAccounts).values({
    userId: theirsId,
    login: '00055555',
    environment: 'live',
    currency: 'USD',
    balance: '42.00000000',
    status: 'active',
  });
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('listing and paging', () => {
  it('lists accounts with their owner joined, and a total', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/trading-accounts?limit=100');

    expect(res.status).toBe(200);
    expect(body(res).items.length).toBeGreaterThanOrEqual(4);
    expect(body(res).total).toBeGreaterThanOrEqual(4);

    const row = body(res).items.find((a) => a.id === liveAccountId);
    expect(row?.user.id).toBe(mineId);
    expect(row?.user.email).toBe('ta-mine@oxshare-e2e.test');
  });

  it('serves the login as a STRING, preserving leading zeros', async () => {
    // A number here would render `00012345` as `12345`, and the bridge treats
    // those as different logins. The schema types it varchar for this reason.
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get(`/v1/admin/trading-accounts?userId=${mineId}&limit=100`);

    const row = body(res).items.find((a) => a.id === liveAccountId);
    expect(row?.login).toBe('00012345');
    expect(res.text).toContain('"login":"00012345"');
  });

  it('pages with a cursor, and the second page does not repeat the first', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const first = await session.get('/v1/admin/trading-accounts?limit=2');

    expect(first.status).toBe(200);
    expect(body(first).items).toHaveLength(2);
    expect(body(first).nextCursor).not.toBeNull();

    const second = await session.get(
      `/v1/admin/trading-accounts?limit=2&cursor=${encodeURIComponent(
        body(first).nextCursor ?? '',
      )}`,
    );
    expect(second.status).toBe(200);

    const firstIds = body(first).items.map((a) => a.id);
    const secondIds = body(second).items.map((a) => a.id);
    expect(secondIds.filter((id) => firstIds.includes(id))).toEqual([]);
  });
});

describe('filters', () => {
  it('filters by userId', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get(`/v1/admin/trading-accounts?userId=${theirsId}&limit=100`);

    expect(res.status).toBe(200);
    expect(body(res).items.length).toBeGreaterThan(0);
    expect(new Set(ownerIds(res))).toEqual(new Set([theirsId]));
  });

  it('filters by environment', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/trading-accounts?environment=demo&limit=100');

    expect(res.status).toBe(200);
    expect(body(res).items.map((a) => a.id)).toContain(demoAccountId);
    for (const account of body(res).items) expect(account.environment).toBe('demo');
  });

  it('filters by status', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/trading-accounts?status=suspended&limit=100');

    expect(res.status).toBe(200);
    expect(body(res).items.map((a) => a.id)).toContain(noLoginAccountId);
    for (const account of body(res).items) expect(account.status).toBe('suspended');
  });

  it('400s on an unknown environment rather than 500ing on the enum cast', async () => {
    /*
     * R-2.5, and the specific bug `query-params.ts` was written for: comparing
     * an unrecognised value against a Postgres enum column errors with "invalid
     * input value for enum", which surfaces as a 500 carrying a database error
     * for what is ordinarily a typo.
     */
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/trading-accounts?environment=paper');

    expect(res.status).toBe(400);
    const message = JSON.stringify(res.body);
    expect(message).toContain('live');
    expect(message).toContain('demo');
  });

  it('400s on an unknown status for the same reason', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/trading-accounts?status=frozen');
    expect(res.status).toBe(400);
  });
});

describe('sorting — R-2.5', () => {
  it('sorts by balance ascending and descending, and they are mirrors', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);

    const asc = await session.get('/v1/admin/trading-accounts?sort=balance&order=asc&limit=100');
    const desc = await session.get('/v1/admin/trading-accounts?sort=balance&order=desc&limit=100');

    expect(asc.status).toBe(200);
    expect(desc.status).toBe(200);

    const ascIds = body(asc).items.map((a) => a.id);
    expect(ascIds).toEqual([...body(desc).items.map((a) => a.id)].reverse());
    // Compared as numeric at full precision, so the widest value sorts last.
    expect(ascIds[ascIds.length - 1]).toBe(liveAccountId);
  });

  it('sorts by login with nulls LAST in both directions', async () => {
    /*
     * The property the nullable column needs pinned.
     *
     * Postgres defaults to NULLS LAST for ASC and NULLS FIRST for DESC, so
     * without an explicit pin the unassigned accounts would silently move from
     * one end of the list to the other when the direction flips — and "lowest
     * login first" would lead with rows that have no login at all.
     */
    const session = await actingAs(ctx, 'admin', MASTER);

    for (const order of ['asc', 'desc']) {
      const res = await session.get(
        `/v1/admin/trading-accounts?sort=login&order=${order}&limit=100`,
      );
      expect(res.status).toBe(200);

      const logins = body(res).items.map((a) => a.login);
      const firstNull = logins.indexOf(null);
      if (firstNull === -1) continue;

      // Once the nulls start they never stop: no non-null value appears after
      // the first null, in EITHER direction.
      expect(
        logins.slice(firstNull).every((l) => l === null),
        `sort=login&order=${order} put a non-null login after a null one`,
      ).toBe(true);
    }
  });

  it('sorts by the joined client email', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/trading-accounts?sort=userEmail&order=asc&limit=100');

    expect(res.status).toBe(200);
    const emails = body(res).items.map((a) => a.user.email);
    expect(emails).toEqual([...emails].sort());
  });

  it('400s on an unknown sort key, naming what IS allowed', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/trading-accounts?sort=equity');

    expect(res.status).toBe(400);
    const message = JSON.stringify(res.body);
    expect(message).toContain('equity');
    expect(message).toContain('environment');
  });
});

describe('money crosses the boundary as an unmodified string — §6.1', () => {
  it('returns the balance byte-identical to what was stored', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get(`/v1/admin/trading-accounts?userId=${mineId}&limit=100`);

    const account = body(res).items.find((a) => a.id === liveAccountId);
    expect(account?.balance).toBe(HUGE_BALANCE);
    expect(typeof account?.balance).toBe('string');
  });

  it('serves the balance as a JSON string, not a JSON number', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get(`/v1/admin/trading-accounts?userId=${mineId}&limit=100`);

    expect(res.text).toContain(`"balance":"${HUGE_BALANCE}"`);
    expect(res.text).not.toContain(`"balance":${HUGE_BALANCE}`);
  });
});

describe('client scope — the top correctness property', () => {
  it("a scoped admin sees only their own clients' accounts", async () => {
    const session = await actingAs(ctx, 'admin', SCOPED);
    const res = await session.get('/v1/admin/trading-accounts?limit=100');

    expect(res.status).toBe(200);
    expect(ownerIds(res)).not.toContain(theirsId);
  });

  it('DOES see accounts inside its territory — the control', async () => {
    const session = await actingAs(ctx, 'admin', SCOPED);
    const res = await session.get('/v1/admin/trading-accounts?limit=100');
    expect(ownerIds(res)).toContain(mineId);
  });

  it('a MASTER admin sees both — the other control', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/trading-accounts?limit=100');

    expect(ownerIds(res)).toContain(mineId);
    expect(ownerIds(res)).toContain(theirsId);
  });

  it('excludes out-of-scope rows from the TOTAL, not just from the page', async () => {
    const scoped = await actingAs(ctx, 'admin', SCOPED);
    const master = await actingAs(ctx, 'admin', MASTER);

    const scopedRes = await scoped.get('/v1/admin/trading-accounts?limit=100');
    const masterRes = await master.get('/v1/admin/trading-accounts?limit=100');

    expect(body(scopedRes).total).toBe(body(scopedRes).items.length);
    expect(body(scopedRes).total).toBeLessThan(body(masterRes).total);
  });

  it('cannot be escaped with an explicit userId filter', async () => {
    const session = await actingAs(ctx, 'admin', SCOPED);
    const res = await session.get(`/v1/admin/trading-accounts?userId=${theirsId}&limit=100`);

    expect(res.status).toBe(200);
    expect(body(res).items).toEqual([]);
  });
});

describe('permissions', () => {
  it('403s for an admin without users.view', async () => {
    const session = await actingAs(ctx, 'admin', NO_PERMS);
    const res = await session.get('/v1/admin/trading-accounts');
    expect(res.status).toBe(403);
  });

  it('403s on the export for the same admin', async () => {
    const session = await actingAs(ctx, 'admin', NO_PERMS);
    const res = await session.get('/v1/admin/trading-accounts/export');
    expect(res.status).toBe(403);
  });

  it('401s with no session at all', async () => {
    const res = await anonymous(ctx).get('/v1/admin/trading-accounts');
    expect(res.status).toBe(401);
  });
});

describe('the CSV export', () => {
  it('streams a CSV naming the file and the balances', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/trading-accounts/export');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('trading-accounts-');

    expect(res.text).toContain('Login');
    expect(res.text).toContain(HUGE_BALANCE);
  });

  it('applies the client scope to the file, exactly as to the list', async () => {
    const session = await actingAs(ctx, 'admin', SCOPED);
    const res = await session.get('/v1/admin/trading-accounts/export');

    expect(res.status).toBe(200);
    expect(res.text).toContain('ta-mine@oxshare-e2e.test');
    expect(res.text).not.toContain('ta-theirs@oxshare-e2e.test');
  });

  it('400s on an unrecognised environment, so a typo is not an empty file', async () => {
    // The same validation as the list: "this segment is empty" and "you typed
    // the segment name wrong" must not produce the same artefact.
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/trading-accounts/export?environment=paper');
    expect(res.status).toBe(400);
  });
});
