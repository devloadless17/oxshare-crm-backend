import { ALL_PERMISSIONS } from './support/all-permissions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { actingAs, startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import {
  adminClientTagScopes,
  admins,
  clientTagAssignments,
  clientTags,
  kycSubmissions,
  roles,
  users,
} from '../src/database/schema';

/**
 * Row-level client visibility, ENFORCED — the teeth behind
 * `client-scope-coverage.spec.ts`.
 *
 * Coverage proves every admin route STATES a stance. That is only half the
 * guarantee: a route can carry `@ScopedToClients('…')` and scope nothing, and
 * the declaration would read exactly the same. This file drives the real HTTP
 * stack with a genuinely out-of-scope client and requires the route to behave.
 *
 * THE TWO PROPERTIES, and why each is stated separately:
 *
 *   1. A LIST must omit the out-of-scope client. Not "return it flagged", not
 *      "return it and let the UI hide it" — omit it, because the predicate is
 *      in the query and the row never enters the result set.
 *
 *   2. A BY-ID route must answer 404, never 403. A 403 confirms the id names a
 *      real client, so a scoped administrator could enumerate the client base
 *      they were specifically denied by trying uuids and reading status codes.
 *      Every by-id assertion below therefore checks BOTH that it is 404 and
 *      that it is not 403 — the second is not redundant, it is the property.
 *
 * The MASTER control runs beside every case. Without it, "the scoped admin sees
 * nothing" would pass just as well against a system that is simply broken.
 */

const MASTER = { email: 'scope-enf-master@oxshare.com', password: 'admin-password-123' };
const SCOPED = { email: 'scope-enf-scoped@oxshare.com', password: 'admin-password-123' };

let ctx: HttpTestContext;
let mineId: string;
let theirsId: string;

interface Listish {
  items?: { id?: string; userId?: string }[];
}

/** Ids in a list response, whichever key the endpoint uses for the client. */
const clientIdsIn = (body: unknown): string[] =>
  ((body as Listish).items ?? []).map((row) => row.userId ?? row.id ?? '');

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const passwords = new PasswordService();
  const db = ctx.db.db;

  const [masterRole] = await db
    .insert(roles)
    .values({ name: 'Scope Enf Master', permissions: ALL_PERMISSIONS, isSystem: true })
    .returning();
  await db.insert(admins).values({
    email: MASTER.email,
    passwordHash: await passwords.hash(MASTER.password),
    name: 'Scope Enf Master',
    role: 'master_admin',
    roleId: masterRole.id,
    permissions: ALL_PERMISSIONS,
    status: 'active',
  });

  /*
   * The scoped admin holds EVERY permission the routes under test require.
   *
   * Deliberate: if any assertion below failed because of a missing permission
   * rather than a missing scope, this file would be reporting that scoping
   * works when it does not. The only thing constraining this admin is territory.
   */
  const [scopedRole] = await db
    .insert(roles)
    .values({
      name: 'Scope Enf Scoped',
      permissions: [
        'clients.view',
        'clients.suspend',
        'tags.view',
        'clients.tag',
        'kyc.review',
        'kyc.documents.view',
        'kyc.view',
        'kyc.review',
        'kyc.review',
        'ib.view',
        /*
         * The holdings keys. Without them `/admin/wallets` and
         * `/admin/trading-accounts` 403 and the assertions below would report
         * scoping as working when what they actually proved is that the admin
         * cannot reach the routes at all — the failure this comment predicted,
         * which then happened when the rework split holdings out of
         * `withdrawals.view` and the fixture kept the old key.
         */
        'wallets.view',
        'trading.view',
        // Granted so the reconciliation case below proves the refusal is about
        // the reader's TERRITORY, not a missing permission.
        'reconciliation.view',
      ],
    })
    .returning();
  const [scopedAdmin] = await db
    .insert(admins)
    .values({
      email: SCOPED.email,
      passwordHash: await passwords.hash(SCOPED.password),
      name: 'Scope Enf Scoped',
      role: 'sub_admin',
      roleId: scopedRole.id,
      permissions: [],
      // Explicitly restricted from intake (the 0058 default is TRUE): this
      // file proves TERRITORY isolation, and untagged fixture clients would
      // otherwise be visible through the intake branch.
      seesUntriaged: false,
      status: 'active',
    })
    .returning();

  const [mineTag] = await db
    .insert(clientTags)
    .values({ slug: 'scope-enf-mine', label: 'Scope Enf Mine' })
    .returning();

  const [mine] = await db
    .insert(users)
    .values({
      email: 'scope-enf-mine@oxshare-e2e.test',
      passwordHash: 'x',
      firstName: 'Mine',
      lastName: 'Client',
    })
    .returning();
  const [theirs] = await db
    .insert(users)
    .values({
      email: 'scope-enf-theirs@oxshare-e2e.test',
      passwordHash: 'x',
      firstName: 'Theirs',
      lastName: 'Client',
    })
    .returning();
  mineId = mine.id;
  theirsId = theirs.id;

  // Only `mine` carries the tag; `theirs` carries nothing, which is the
  // ordinary shape — most clients are not in any one desk's territory.
  await db.insert(clientTagAssignments).values({ userId: mineId, tagId: mineTag.id });
  await db.insert(adminClientTagScopes).values({
    adminId: scopedAdmin.id,
    tagId: mineTag.id,
    createdBy: scopedAdmin.id,
  });

  /*
   * A KYC submission on BOTH sides of the boundary.
   *
   * Without these the queue is empty for everyone, and the count assertions
   * below pass on 0 === 0 — a test that proves the boundary holds by proving
   * there is nothing to hold back. Two rows, one in the territory and one
   * outside it, are the smallest fixture that can tell a working count from a
   * silent one.
   */
  await db.insert(kycSubmissions).values([
    { userId: mineId, status: 'submitted', submittedAt: new Date() },
    { userId: theirsId, status: 'submitted', submittedAt: new Date() },
  ]);
});

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('list routes omit out-of-scope clients', () => {
  /*
   * `withdrawals` and `ledger` were the other two entries and left with the
   * money teardown. Every scoped LIST route belongs in this table — a route
   * that omits itself is one whose scoping nobody proves — so add the IB
   * application queue here when it lands, and the money lists when they return.
   */
  const LISTS = [
    { name: 'clients', path: '/v1/admin/clients?q=oxshare-e2e.test' },
    { name: 'kyc queue', path: '/v1/admin/kyc' },
    /*
     * The two holdings lists. Both are client-OWNED money/config rows, which is
     * exactly the shape this file exists to police — and both apply the
     * predicate to their own `user_id` column rather than to `users.id`, so
     * they are a genuinely different code path from the two above.
     *
     * The out-of-scope client carries no wallet or trading account in this
     * fixture, so these assert the weaker half here (the row is not present)
     * and `admin-wallets.spec.ts` / `admin-trading-accounts.spec.ts` assert the
     * strong half against seeded out-of-scope rows, with master controls.
     */
    { name: 'wallets', path: '/v1/admin/wallets?limit=100' },
    { name: 'trading accounts', path: '/v1/admin/trading-accounts?limit=100' },
  ];

  for (const list of LISTS) {
    it(`${list.name}: excludes a client outside the actor's territory`, async () => {
      const session = await actingAs(ctx, 'admin', SCOPED);
      const res = await session.get(list.path);

      expect(res.status, `${list.path} did not answer`).toBe(200);
      expect(clientIdsIn(res.body)).not.toContain(theirsId);
    });
  }

  it("clients: DOES include a client inside the actor's territory", async () => {
    // The control. "Excludes theirs" would pass against a list that excludes
    // everyone, which is a broken screen rather than a working control.
    const session = await actingAs(ctx, 'admin', SCOPED);
    const res = await session.get('/v1/admin/clients?q=oxshare-e2e.test');
    expect(clientIdsIn(res.body)).toContain(mineId);
  });

  it('kyc: the TAB COUNTS stay inside the territory too, not just the rows', async () => {
    /*
     * Reported from the running console: a reviewer scoped to two tags, with no
     * intake grant, saw a sidebar badge of 15 and tabs reading 12 / 3 / 89 /
     * 111 above a queue with nothing in it.
     *
     * The rows and the total were scoped; the status-count query carried no
     * predicate at all, on the reasoning that tab counts should span every
     * STATUS. They did — and every CLIENT with them.
     *
     * Two harms, in rising order. The badge is a promise about the reader's own
     * work and it was counting somebody else's, on the one control that exists
     * to say "there is something to do". And it disclosed platform-wide volumes
     * to an admin whose whole configuration says they may not see them: RBAC-08
     * territory bounds what a reviewer LEARNS, not only what they can open.
     *
     * Asserted as an identity — counts must agree with the rows the same
     * request returned — because that is the property a reader relies on, and
     * it cannot be satisfied by a count that is merely smaller.
     */
    const session = await actingAs(ctx, 'admin', SCOPED);
    const res = await session.get('/v1/admin/kyc?limit=100');
    expect(res.status).toBe(200);

    const body = res.body as {
      items: unknown[];
      total: number;
      counts: Record<string, number>;
    };
    expect(body.counts['all'], 'the tab counts reach past the territory').toBe(body.total);
    expect(body.total).toBe(body.items.length);
    // Non-vacuous: there IS a submission outside the territory to have leaked.
    expect(body.total, 'the fixture has nothing to count').toBe(1);
    expect(clientIdsIn(res.body)).not.toContain(theirsId);
  });

  it('kyc: a MASTER admin still counts the whole platform', async () => {
    // The control. A scoped count that is right because NOBODY sees anything
    // is a broken screen, not a working boundary.
    const scoped = await actingAs(ctx, 'admin', SCOPED);
    const master = await actingAs(ctx, 'admin', MASTER);
    const mine = (await scoped.get('/v1/admin/kyc?limit=100')).body as {
      counts: Record<string, number>;
    };
    const all = (await master.get('/v1/admin/kyc?limit=100')).body as {
      counts: Record<string, number>;
    };
    expect(mine.counts['all'], 'the scoped reviewer sees only their own').toBe(1);
    expect(all.counts['all'], 'the master counts both sides of the boundary').toBe(2);
  });

  it('clients: a MASTER admin still sees both', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/clients?q=oxshare-e2e.test');
    const ids = clientIdsIn(res.body);
    expect(ids).toContain(mineId);
    expect(ids).toContain(theirsId);
  });
});

describe('by-id routes answer 404 for an out-of-scope client, never 403', () => {
  /**
   * Every scoped route that names a client in its path.
   *
   * Kept in step with the `@ScopedToClients` declarations by
   * `client-scope-coverage.spec.ts`, which fails if a route joins that set —
   * so a new scoped by-id route cannot ship without either appearing here or
   * making that spec red.
   */
  const BY_ID = [
    { name: 'client tags', run: (s: Session, id: string) => s.get(`/v1/admin/clients/${id}/tags`) },
    { name: 'kyc detail', run: (s: Session, id: string) => s.get(`/v1/admin/kyc/${id}`) },
    { name: 'kyc history', run: (s: Session, id: string) => s.get(`/v1/admin/kyc/${id}/history`) },
    {
      name: 'suspend client',
      run: (s: Session, id: string) =>
        s.patch(`/v1/admin/clients/${id}/status`, { status: 'suspended' }),
    },
    {
      name: 'kyc claim',
      run: (s: Session, id: string) => s.patch(`/v1/admin/kyc/${id}/claim`, {}),
    },
    {
      name: 'kyc approve',
      run: (s: Session, id: string) => s.patch(`/v1/admin/kyc/${id}/approve`, {}),
    },
    {
      name: 'kyc reject',
      run: (s: Session, id: string) =>
        s.patch(`/v1/admin/kyc/${id}/reject`, { reason: 'scope enforcement probe' }),
    },
  ];

  for (const route of BY_ID) {
    it(`${route.name}: 404 for an out-of-scope client`, async () => {
      const session = await actingAs(ctx, 'admin', SCOPED);
      const res = await route.run(session, theirsId);

      expect(res.status, `${route.name} answered ${res.status}`).toBe(404);
      // Not redundant with the line above — THIS is the property. A 403 tells a
      // scoped admin the id names a real client, which is the enumeration the
      // whole 404 convention exists to prevent.
      expect(res.status).not.toBe(403);
    });
  }

  it('a route reachable for an IN-scope client proves the 404s are about scope', async () => {
    // Without this, every 404 above would also be produced by a system where
    // these routes are simply broken for sub-admins.
    const session = await actingAs(ctx, 'admin', SCOPED);
    const res = await session.get(`/v1/admin/clients/${mineId}/tags`);
    expect(res.status).toBe(200);
  });

  it('a MASTER admin reaches the same client the scoped admin cannot', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get(`/v1/admin/clients/${theirsId}/tags`);
    expect(res.status).toBe(200);
  });
});

describe('reconciliation is a whole-platform control, refused to a scoped admin (#2)', () => {
  /*
   * `GET /admin/reconciliation` names every client with a wallet discrepancy.
   * There is no coherent scoped version — "balanced over your territory" does
   * not answer whether the ledger balances — so a scoped admin holding
   * `reconciliation.view` is refused rather than shown a slice or the whole
   * client list. The refusal is about the READER'S territory, not any client,
   * so it is a 403 that names no one (not the 404 the per-client routes use).
   */
  it('refuses a scoped admin who holds reconciliation.view — 403, not a slice', async () => {
    const session = await actingAs(ctx, 'admin', SCOPED);
    const res = await session.get('/v1/admin/reconciliation');
    expect(res.status, `reconciliation answered ${res.status} for a scoped admin`).toBe(403);
    // The body must not carry a discrepancy list — refused before the report runs.
    expect(res.body).not.toHaveProperty('walletDiscrepancies');
  });

  it('runs the whole report for an unrestricted admin', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get('/v1/admin/reconciliation');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('walletDiscrepancies');
    expect(res.body).toHaveProperty('balanced');
  });
});

type Session = Awaited<ReturnType<typeof actingAs>>;
