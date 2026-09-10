import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS } from './support/all-permissions';
import { actingAs, startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import {
  adminClientTagScopes,
  admins,
  clientTagAssignments,
  clientTags,
  ibAccounts,
  roles,
  users,
} from '../src/database/schema';

/**
 * A PARTNER'S DOWNLINE IS ROWS, AND ROWS FOLLOW THE READER'S TERRITORY.
 *
 * ⚠️ THIS REVERSES A DELIBERATE DECISION, on 11 Sep 2026, and the decision it
 * reverses was argued rather than forgotten. `UsersStore.listReferredBy` and
 * `countReferredBy` both said "unscoped by design ... the subject has already
 * been checked visible, and a count filtered by the reader's own tags would
 * under-report a partner's book without saying so."
 *
 * Two documents governed this and they disagreed:
 *
 *   client-scope.ts   "The predicate goes in the WHERE CLAUSE. Never
 *                      fetch-then-filter... a new export endpoint, A COUNT, a
 *                      join, a findById reached from somewhere unexpected"
 *   users.store.ts    "unscoped by design" (above)
 *
 * The first governs, for three reasons the second does not answer. "The subject
 * has already been checked visible" is true about the PARTNER and says nothing
 * about their CLIENTS — each downline row IS a client, and client scope is
 * row-level visibility over clients. FIELD MASKING DOES NOT COVER IT: masking
 * hides fields by role, scope hides rows by territory, so an unscoped downline
 * hands over the ids of up to fifty clients the reader is specifically denied —
 * a larger oracle than the 403-versus-404 distinction `client-scope.ts` refuses
 * to give away. And the "would under-report without saying so" worry argues for
 * SAYING SO: `referredShown` and `referredTotal` now state exactly what is
 * shown and out of how many.
 *
 * THE DECIDING PRECEDENT is that the client LIST's own total is already scoped.
 * Leaving these two unscoped made the profile disagree with the screen it links
 * into — "50 of 213" above a filtered list of 60.
 *
 * ## What each case would let through if it were absent
 *
 * The two halves are asserted separately because they are two queries, and one
 * being scoped says nothing about the other — the same reason the KYC money
 * gates drive both doors.
 */

const MASTER = { email: 'ref-scope-master@oxshare.com', password: 'admin-password-123' };
const SCOPED = { email: 'ref-scope-scoped@oxshare.com', password: 'admin-password-123' };

const CLIENTS = '/v1/admin/clients';

let ctx: HttpTestContext;
let partnerId: string;
let mineId: string;
let theirsId: string;

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const db = ctx.db.db;
  const passwords = new PasswordService();

  const [masterRole] = await db
    .insert(roles)
    .values({ name: 'Ref Scope Master', permissions: ALL_PERMISSIONS })
    .returning();
  await db.insert(admins).values({
    email: MASTER.email,
    passwordHash: await passwords.hash(MASTER.password),
    name: 'Ref Scope Master',
    role: 'master_admin',
    roleId: masterRole.id,
    permissions: ['*'],
    status: 'active',
  });

  /*
   * The scoped reader holds EVERY permission these routes need, `ib.view`
   * included. Without that, a withheld downline could be a missing permission
   * rather than a territory boundary, and this file would be proving the wrong
   * thing.
   */
  const [scopedRole] = await db
    .insert(roles)
    .values({ name: 'Ref Scope Scoped', permissions: ALL_PERMISSIONS })
    .returning();
  const [scopedAdmin] = await db
    .insert(admins)
    .values({
      email: SCOPED.email,
      passwordHash: await passwords.hash(SCOPED.password),
      name: 'Ref Scope Scoped',
      role: 'sub_admin',
      roleId: scopedRole.id,
      permissions: [],
      // The 0058 default is TRUE, and an untagged fixture client would then be
      // visible through the intake branch — which would hide the very boundary
      // this file exists to prove.
      seesUntriaged: false,
      status: 'active',
    })
    .returning();

  const [tag] = await db
    .insert(clientTags)
    .values({ slug: 'ref-scope-mine', label: 'Ref Scope Mine' })
    .returning();
  await db.insert(adminClientTagScopes).values({
    adminId: scopedAdmin.id,
    tagId: tag.id,
    createdBy: scopedAdmin.id,
  });

  // The PARTNER is inside the reader's territory: they may legitimately open
  // this profile. Everything below is about what the profile then contains.
  const [partner] = await db
    .insert(users)
    .values({
      email: 'ref-scope-partner@oxshare-e2e.test',
      passwordHash: 'x',
      firstName: 'Ref',
      lastName: 'Partner',
    })
    .returning();
  partnerId = partner.id;
  await db
    .insert(ibAccounts)
    .values({ userId: partnerId, level: 1, active: true, referralCode: 'REFSCOPE1' });

  // Two referred clients: one in the reader's territory, one outside it.
  const [mine] = await db
    .insert(users)
    .values({
      email: 'ref-scope-mine@oxshare-e2e.test',
      passwordHash: 'x',
      firstName: 'Mine',
      lastName: 'Referred',
      referredByIbUserId: partnerId,
    })
    .returning();
  const [theirs] = await db
    .insert(users)
    .values({
      email: 'ref-scope-theirs@oxshare-e2e.test',
      passwordHash: 'x',
      firstName: 'Theirs',
      lastName: 'Referred',
      referredByIbUserId: partnerId,
    })
    .returning();
  mineId = mine.id;
  theirsId = theirs.id;

  await db.insert(clientTagAssignments).values([
    { userId: partnerId, tagId: tag.id },
    { userId: mineId, tagId: tag.id },
  ]);
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

type Profile = {
  referredClients?: { clientUserId: string }[];
  referredShown?: number;
  referredTotal?: number;
};

describe("the profile's downline follows the reader's territory", () => {
  it('MASTER sees both referred clients, and the total agrees', async () => {
    /*
     * The control, and it runs first. Without it every "the scoped admin does
     * not see them" assertion below is satisfied by a system where nobody sees
     * them — a downline that is empty for everyone would pass the whole file.
     */
    const master = await actingAs(ctx, 'admin', MASTER);
    const res = await master.get(`${CLIENTS}/${partnerId}`).expect(200);
    const body = res.body as Profile;

    const ids = (body.referredClients ?? []).map((c) => c.clientUserId);
    expect(ids).toContain(mineId);
    expect(ids, 'the fixture never attributed the second client').toContain(theirsId);
    expect(body.referredShown).toBe(2);
    expect(
      body.referredTotal,
      'the total disagrees with the list an unrestricted reader gets',
    ).toBe(2);
  });

  it('a SCOPED reader gets only the referred client in their own territory', async () => {
    const scoped = await actingAs(ctx, 'admin', SCOPED);
    const res = await scoped.get(`${CLIENTS}/${partnerId}`).expect(200);
    const body = res.body as Profile;

    const ids = (body.referredClients ?? []).map((c) => c.clientUserId);
    expect(ids, 'the reader may see this one — a withheld downline proves nothing').toContain(
      mineId,
    );
    expect(
      ids,
      'a scoped admin was handed the id of a client outside their territory. Masking hides ' +
        'FIELDS by role; this is a ROW, and rows follow the scope.',
    ).not.toContain(theirsId);
  });

  it('and the TOTAL is the scoped one, or the screen contradicts the list it links to', async () => {
    /*
     * Asserted separately from the list above because it is a SECOND QUERY.
     * `countReferredBy` and `listReferredBy` are two methods, and one being
     * scoped says nothing about the other — the same reason the KYC money gates
     * drive both doors rather than trusting that one implies the other.
     *
     * An unscoped total here would read "1 of 2" for a reader whose filtered
     * client list can only ever return 1.
     */
    const scoped = await actingAs(ctx, 'admin', SCOPED);
    const res = await scoped.get(`${CLIENTS}/${partnerId}`).expect(200);
    const body = res.body as Profile;

    expect(body.referredShown).toBe(1);
    expect(
      body.referredTotal,
      'the total counts clients this reader may not see, so the profile says "1 of 2" ' +
        'above a filtered list that returns 1',
    ).toBe(1);
  });

  it('withholds the total too, when it withholds the sections', async () => {
    /*
     * The absent-versus-empty rule, extended to the new field. "May not see"
     * must not arrive as ZERO — a reader without `ib.view` reading
     * `referredTotal: 0` would be told this partner introduced nobody.
     */
    const passwords = new PasswordService();
    const db = ctx.db.db;
    const [noIb] = await db
      .insert(roles)
      .values({ name: 'Ref Scope No IB', permissions: ['clients.view'] })
      .returning();
    const who = { email: 'ref-scope-no-ib@oxshare.com', password: 'admin-password-123' };
    await db.insert(admins).values({
      email: who.email,
      passwordHash: await passwords.hash(who.password),
      name: 'Ref Scope No IB',
      role: 'sub_admin',
      roleId: noIb.id,
      permissions: [],
      status: 'active',
    });

    const session = await actingAs(ctx, 'admin', who);
    const res = await session.get(`${CLIENTS}/${partnerId}`).expect(200);
    const body = res.body as Record<string, unknown>;

    expect('referredClients' in body).toBe(false);
    expect(
      'referredTotal' in body,
      'a reader without ib.view was told the partner has 0 referrals, which is a fact ' +
        'about their permissions wearing the shape of a fact about the client',
    ).toBe(false);
  });
});

describe('GET /admin/clients?referredBy=', () => {
  it('filters to that partner’s clients — the route the 50-cap was justified by', async () => {
    const master = await actingAs(ctx, 'admin', MASTER);
    const res = await master.get(`${CLIENTS}?referredBy=${partnerId}&withTotal=true`).expect(200);
    const body = res.body as { items: { id: string }[]; total?: number };
    const ids = body.items.map((r) => r.id);

    expect(ids).toContain(mineId);
    expect(ids).toContain(theirsId);
    expect(ids, 'the partner themselves was not introduced by themselves').not.toContain(partnerId);
  });

  it('is SCOPED — a filter must never be a way around the territory', async () => {
    /*
     * The one way this feature could have made things WORSE. A reader filtering
     * by a partner they can see is still only entitled to clients in their own
     * territory; a filter applied without the scope predicate beside it is a
     * scope bypass wearing a filter.
     */
    const scoped = await actingAs(ctx, 'admin', SCOPED);
    const res = await scoped.get(`${CLIENTS}?referredBy=${partnerId}&withTotal=true`).expect(200);
    const body = res.body as { items: { id: string }[]; total?: number };
    const ids = body.items.map((r) => r.id);

    expect(ids, 'the reader may see this one').toContain(mineId);
    expect(ids, 'the referrer filter returned a client outside the reader territory').not.toContain(
      theirsId,
    );
    expect(body.total, 'the filtered total counts rows the reader cannot see').toBe(1);
  });

  it('REFUSES a malformed value rather than ignoring it', async () => {
    /*
     * THE PROPERTY THE SCREEN ABOVE IT DEPENDS ON.
     *
     * These are individual `@Query('name')` bindings, not a DTO, so
     * `forbidNonWhitelisted` has nothing to reflect on and an unrecognised KEY
     * is silently dropped — measured on the wire, `?directoin=` on the
     * transactions desk returns the full set. A filter that silently does
     * nothing is what would put "Showing only the clients introduced by this
     * partner" over every client in the system.
     *
     * So a value that cannot be a client id fails LOUDLY. 400, and the response
     * must not be a list.
     */
    const master = await actingAs(ctx, 'admin', MASTER);
    const res = await master.get(`${CLIENTS}?referredBy=not-a-uuid`);

    expect(
      res.status,
      `a malformed referredBy answered ${res.status}. A 200 here is an unfiltered list ` +
        'presented as a filtered one.',
    ).toBe(400);
    expect(res.body).not.toHaveProperty('items');
  });

  it('answers an EMPTY list for a well-formed id that introduced nobody', async () => {
    /*
     * Not a 404. "No such partner" and "that partner has no clients" must look
     * identical from outside, or the endpoint becomes an oracle over the client
     * base — the same reason an out-of-scope client is 404 rather than 403.
     */
    const master = await actingAs(ctx, 'admin', MASTER);
    const res = await master
      .get(`${CLIENTS}?referredBy=00000000-0000-0000-0000-000000000000&withTotal=true`)
      .expect(200);
    const body = res.body as { items: unknown[]; total?: number };

    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
  });
});
