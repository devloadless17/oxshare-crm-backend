import { ALL_PERMISSIONS } from './support/all-permissions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { actingAs, startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import {
  adminClientTagScopes,
  admins,
  clientTagAssignments,
  clientTags,
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

type Session = Awaited<ReturnType<typeof actingAs>>;
