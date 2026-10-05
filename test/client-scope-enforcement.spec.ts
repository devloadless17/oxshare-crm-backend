import { ALL_PERMISSIONS } from './support/all-permissions';
import { scopedByIdRoutes } from './support/scope-facts';
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
let mineId: number;
let theirsId: number;

interface Listish {
  items?: { id?: number; userId?: number }[];
}

/** Ids in a list response, whichever key the endpoint uses for the client. */
const clientIdsIn = (body: unknown): number[] =>
  ((body as Listish).items ?? []).map((row) => row.userId ?? row.id ?? -1);

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
        /*
         * The rest of what the by-id census below drives. Same reasoning as the
         * block above and as this fixture's own header: an assertion that 404s
         * because the admin lacks the KEY proves nothing about territory, and
         * reads as scoping working when it has not been tested at all.
         */
        'clients.edit',
        'clients.email',
        'clients.referrer.set',
        'kyc.identity.correct',
        'ib.partners.edit',
        'ib.partners.suspend',
        'transactions.view',
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
   * Every scoped route that names a CLIENT in its path.
   *
   * ⚠️ THIS COMMENT USED TO CLAIM THE LIST WAS DERIVED, AND IT WAS NOT.
   *
   * It said the list was "kept in step with the `@ScopedToClients` declarations
   * by `client-scope-coverage.spec.ts`, which fails if a route joins that set —
   * so a new scoped by-id route cannot ship without either appearing here or
   * making that spec red". `client-scope.decorator.ts` said the same thing in
   * stronger words: a route "cannot enter the declared-scoped set without also
   * being exercised".
   *
   * Neither was true. That spec asserts only that a route DECLARES a stance; it
   * has never looked at this file. `scopeFacts()` was exported for the purpose
   * and nothing imported it — nothing could have, because it read module-level
   * state only its own `beforeAll` assigns. So seven routes were exercised
   * against thirty-seven declarations, and the only numeric guard was
   * `toBeGreaterThanOrEqual(10)` one file over.
   *
   * The linkage is real now: `the by-id census` below reads the live metadata
   * through `test/support/scope-facts.ts` and fails when a scoped by-id route
   * appears in neither this list nor `PARAM_IS_NOT_A_CLIENT`.
   */
  const BY_ID = [
    {
      signature: 'GET /admin/clients/:id/tags',
      run: (s: Session, id: number) => s.get(`/v1/admin/clients/${id}/tags`),
    },
    {
      signature: 'GET /admin/kyc/:userId',
      run: (s: Session, id: number) => s.get(`/v1/admin/kyc/${id}`),
    },
    {
      signature: 'GET /admin/kyc/:userId/history',
      run: (s: Session, id: number) => s.get(`/v1/admin/kyc/${id}/history`),
    },
    {
      signature: 'PATCH /admin/clients/:id/status',
      run: (s: Session, id: number) =>
        s.patch(`/v1/admin/clients/${id}/status`, { status: 'suspended' }),
    },
    {
      signature: 'PATCH /admin/kyc/:userId/claim',
      run: (s: Session, id: number) => s.patch(`/v1/admin/kyc/${id}/claim`, {}),
    },
    {
      signature: 'PATCH /admin/kyc/:userId/approve',
      run: (s: Session, id: number) => s.patch(`/v1/admin/kyc/${id}/approve`, {}),
    },
    {
      signature: 'PATCH /admin/kyc/:userId/reject',
      run: (s: Session, id: number) =>
        s.patch(`/v1/admin/kyc/${id}/reject`, { reason: 'scope enforcement probe' }),
    },
    /*
     * Added when the census below turned the claim above into a fact. Each one
     * was a scoped route naming a client that nothing had ever driven against an
     * out-of-scope id.
     *
     * The write routes are safe to point at somebody else's client precisely
     * because of the property under test: the visibility check runs before the
     * write, so a 404 means nothing happened. If one of them ever performs its
     * change first, this file goes red AND the fixture's data changes — which is
     * the loudest way for that bug to announce itself.
     */
    {
      signature: 'GET /admin/clients/:id',
      run: (s: Session, id: number) => s.get(`/v1/admin/clients/${id}`),
    },
    {
      // The identity record: documents and every verification decision.
      signature: 'GET /admin/clients/:id/identity',
      run: (s: Session, id: number) => s.get(`/v1/admin/clients/${id}/identity`),
    },
    {
      // Every document — KYC versions and deposit receipts — in one list.
      signature: 'GET /admin/clients/:id/documents',
      run: (s: Session, id: number) => s.get(`/v1/admin/clients/${id}/documents`),
    },
    {
      signature: 'GET /admin/clients/:id/closed-positions',
      run: (s: Session, id: number) => s.get(`/v1/admin/clients/${id}/closed-positions`),
    },
    {
      signature: 'GET /admin/clients/:id/transactions',
      run: (s: Session, id: number) => s.get(`/v1/admin/clients/${id}/transactions`),
    },
    {
      signature: 'GET /admin/ib/partners/:userId',
      run: (s: Session, id: number) => s.get(`/v1/admin/ib/partners/${id}`),
    },
    {
      signature: 'PATCH /admin/clients/:id',
      run: (s: Session, id: number) => s.patch(`/v1/admin/clients/${id}`, { firstName: 'Probe' }),
    },
    {
      signature: 'PATCH /admin/clients/:id/email',
      run: (s: Session, id: number) =>
        s.patch(`/v1/admin/clients/${id}/email`, { email: 'scope-probe@oxshare-e2e.test' }),
    },
    {
      signature: 'PATCH /admin/clients/:id/referrer',
      run: (s: Session, id: number) =>
        s.patch(`/v1/admin/clients/${id}/referrer`, { referralCode: 'SCOPEPROBE' }),
    },
    {
      signature: 'PATCH /admin/kyc/:userId/release',
      run: (s: Session, id: number) => s.patch(`/v1/admin/kyc/${id}/release`, {}),
    },
    {
      signature: 'PATCH /admin/kyc/:userId/personal-info',
      run: (s: Session, id: number) =>
        s.patch(`/v1/admin/kyc/${id}/personal-info`, {
          reason: 'scope enforcement probe — a correction',
          dateOfBirth: '1985-04-12',
        }),
    },
    {
      signature: 'POST /admin/kyc/:userId/reverify',
      run: (s: Session, id: number) =>
        s.post(`/v1/admin/kyc/${id}/reverify`, {
          reason: 'scope enforcement probe — a re-verification',
          items: ['passport'],
        }),
    },
    {
      signature: 'PATCH /admin/ib/partners/:userId/active',
      run: (s: Session, id: number) =>
        s.patch(`/v1/admin/ib/partners/${id}/active`, { active: false }),
    },
    {
      signature: 'PATCH /admin/ib/partners/:userId/level',
      run: (s: Session, id: number) => s.patch(`/v1/admin/ib/partners/${id}/level`, { level: 2 }),
    },
    {
      signature: 'PATCH /admin/ib/partners/:userId/parent',
      run: (s: Session, id: number) =>
        s.patch(`/v1/admin/ib/partners/${id}/parent`, { parentIbUserId: null }),
    },
    {
      signature: 'POST /admin/clients/:id/tags/:tagId',
      run: (s: Session, id: number) =>
        s.post(`/v1/admin/clients/${id}/tags/00000000-0000-4000-8000-000000000000`, {}),
    },
    {
      signature: 'DELETE /admin/clients/:id/tags/:tagId',
      run: (s: Session, id: number) =>
        s.del(`/v1/admin/clients/${id}/tags/00000000-0000-4000-8000-000000000000`),
    },
  ];

  for (const route of BY_ID) {
    it(`${route.signature}: 404 for an out-of-scope client`, async () => {
      const session = await actingAs(ctx, 'admin', SCOPED);
      const res = await route.run(session, theirsId);

      expect(res.status, `${route.signature} answered ${res.status}`).toBe(404);
      // Not redundant with the line above — THIS is the property. A 403 tells a
      // scoped admin the id names a real client, which is the enumeration the
      // whole 404 convention exists to prevent.
      expect(res.status).not.toBe(403);
    });
  }

  /**
   * Scoped by-id routes whose path parameter names something OTHER than a client.
   *
   * They are scoped, and they are tested — but not by driving a client id at
   * them, because the id in the path is a wallet, a transaction, an application,
   * an accrual, a trading account, a transfer or a filename. Handing one of
   * those `theirsId` produces a 404 that says "no such wallet", which would pass
   * this suite while proving nothing about territory.
   *
   * Listing them is the point: the census below refuses a scoped by-id route
   * that is in neither set, so a new one has to be either exercised above or
   * argued for here.
   */
  const PARAM_IS_NOT_A_CLIENT: Record<string, string> = {
    'DELETE /admin/wallets/:id': 'a wallet id — holdings scope is covered by admin-wallets.spec.ts',
    'PATCH /admin/trading-accounts/:id/product':
      "a trading-account id — the service joins the account's owner under the scope, see mt5-account-link.spec.ts",
    'GET /admin/trading-accounts/:id/live':
      'a trading-account id — see admin-trading-accounts.spec.ts',
    'POST /admin/trading-accounts/:id/fund':
      'a trading-account id; the money path is admin-holdings',
    'GET /uploads/kyc/:file': 'a stored filename, resolved to its owner — uploads.controller.ts',
    'GET /uploads/deposit-proofs/:file': 'a stored filename, resolved to its deposit’s owner',
    'PATCH /admin/deposits/:id/approve': 'a transaction id — withdrawal-desk-scope.spec.ts',
    'PATCH /admin/deposits/:id/reject': 'a transaction id — withdrawal-desk-scope.spec.ts',
    'PATCH /admin/withdrawals/:id/approve': 'a transaction id — withdrawal-desk-scope.spec.ts',
    'PATCH /admin/withdrawals/:id/reject': 'a transaction id — withdrawal-desk-scope.spec.ts',
    'PATCH /admin/withdrawals/:id/settle': 'a transaction id — withdrawal-desk-scope.spec.ts',
    'PATCH /admin/transactions/:id/attention/resolve':
      'a transaction id, resolved to its owner — attention-resolve.spec.ts',
    'POST /admin/notifications/:id/read':
      'a notification id; scope is the row’s subject client — notifications-admin-tasks.spec.ts',
    'POST /admin/notifications/:id/close':
      'a notification id; scope is the row’s subject client — notifications-admin-tasks.spec.ts',
    'PATCH /admin/withdrawals/:id/cancel': 'a transaction id — withdrawal-desk-scope.spec.ts',
    'POST /admin/withdrawals/:id/provider-submit':
      'a transaction id — withdrawal-desk-scope.spec.ts',
    'PATCH /admin/transactions/:id/attention/finish-deposit':
      'a transaction id, resolved to its owner — attention-resolve.spec.ts drives it out of scope',
    'PATCH /admin/transactions/:id/attention/finish-payout':
      'a transaction id, resolved to its owner — attention-resolve.spec.ts drives it out of scope',
    'POST /admin/transfers/:id/abandon': 'a transfer id',
    'PATCH /admin/ib/applications/:id/approve': 'an application id — ib-applications.spec.ts',
    'PATCH /admin/ib/applications/:id/reject': 'an application id — ib-applications.spec.ts',
    'POST /admin/ib/accruals/:id/reverse':
      'an accrual id; the beneficiary check is ib-accrual-reversal.spec.ts',
  };

  it('the by-id census: every scoped route naming an id is exercised or argued for', () => {
    /*
     * THE ASSERTION THAT MAKES THE HEADER TRUE.
     *
     * Read from the running application's own metadata — the same source
     * `client-scope-coverage.spec.ts` uses — so a route joins this set by being
     * decorated, not by anybody remembering. Before this existed, seven routes
     * were driven against thirty-seven declarations and the gap was invisible.
     */
    const declared = scopedByIdRoutes(ctx.app);
    const exercised = new Set(BY_ID.map((r) => r.signature));

    const unaccounted = declared.filter(
      (signature) => !exercised.has(signature) && !(signature in PARAM_IS_NOT_A_CLIENT),
    );

    expect(
      unaccounted,
      'These routes declare @ScopedToClients and name an id in their path, and nothing ' +
        'drives an out-of-scope id at them. Add a case to BY_ID, or say in ' +
        'PARAM_IS_NOT_A_CLIENT why the parameter is not a client:\n' +
        unaccounted.map((r) => `  ${r}`).join('\n'),
    ).toEqual([]);
  });

  it('keeps both lists honest — no entry outlives its route', () => {
    /*
     * The other direction, and the reason it matters: an entry for a route that
     * no longer exists is a line that looks like diligence and protects nothing,
     * which is how the list this replaces decayed in the first place.
     */
    const declared = new Set(scopedByIdRoutes(ctx.app));
    const claimed = [...BY_ID.map((r) => r.signature), ...Object.keys(PARAM_IS_NOT_A_CLIENT)];
    const stale = claimed.filter((signature) => !declared.has(signature));

    expect(
      stale,
      `These are listed but no longer declare @ScopedToClients with an id in the path:\n${stale
        .map((r) => `  ${r}`)
        .join('\n')}`,
    ).toEqual([]);
  });

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
