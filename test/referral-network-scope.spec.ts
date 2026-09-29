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
/** Sub-partners of `partnerId`: one inside the reader's territory, one outside. */
let subMineId: string;
let subTheirsId: string;
/** A partner the reader CAN open, whose PARENT sits outside their territory. */
let childPartnerId: string;
let outsideParentId: string;
/** In the reader's territory, but INTRODUCED by a partner who is not. */
let introducedFromOutsideId: string;

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

  /*
   * A SUB-PARTNER LINE, one rung down, split across the territory boundary.
   *
   * `findDirectPartners` was unscoped on the same "it would under-report the
   * line" reasoning this file's header overturns for referred clients — and it
   * projected each sub-partner's email and full name, so the roster leaked
   * exactly what the counts beside it were careful not to.
   */
  const [subMine] = await db
    .insert(users)
    .values({
      email: 'ref-scope-sub-mine@oxshare-e2e.test',
      passwordHash: 'x',
      firstName: 'SubMine',
      lastName: 'Partner',
    })
    .returning();
  const [subTheirs] = await db
    .insert(users)
    .values({
      email: 'ref-scope-sub-theirs@oxshare-e2e.test',
      passwordHash: 'x',
      firstName: 'SubTheirs',
      lastName: 'Partner',
    })
    .returning();
  subMineId = subMine.id;
  subTheirsId = subTheirs.id;
  await db.insert(ibAccounts).values([
    {
      userId: subMineId,
      level: 2,
      active: true,
      referralCode: 'REFSUB1',
      parentIbUserId: partnerId,
    },
    {
      userId: subTheirsId,
      level: 2,
      active: true,
      referralCode: 'REFSUB2',
      parentIbUserId: partnerId,
    },
  ]);

  /*
   * A partner whose PARENT is outside the reader's territory.
   *
   * Separate from the pair above because it exercises the opposite direction:
   * looking UP the tree rather than down. The parent was resolved with the
   * deliberately-unscoped `findById`, so their address arrived whoever asked.
   */
  const [outsideParent] = await db
    .insert(users)
    .values({
      email: 'ref-scope-parent-theirs@oxshare-e2e.test',
      passwordHash: 'x',
      firstName: 'Outside',
      lastName: 'Parent',
    })
    .returning();
  const [childPartner] = await db
    .insert(users)
    .values({
      email: 'ref-scope-child@oxshare-e2e.test',
      passwordHash: 'x',
      firstName: 'Child',
      lastName: 'Partner',
    })
    .returning();
  outsideParentId = outsideParent.id;
  childPartnerId = childPartner.id;

  await db.insert(ibAccounts).values([
    { userId: outsideParentId, level: 1, active: true, referralCode: 'REFPARENT1' },
    {
      userId: childPartnerId,
      level: 2,
      active: true,
      referralCode: 'REFCHILD1',
      parentIbUserId: outsideParentId,
    },
  ]);

  /*
   * The case the referrer card is about: a client the scoped desk OWNS, whose
   * introducer sits outside their territory. Without this fixture the referrer
   * assertions pass trivially — `partnerId` is tagged INTO the territory below,
   * so every other referred client in this file has a visible introducer.
   *
   * Created AFTER the `ib_accounts` insert above: `users.referred_by_ib_user_id`
   * is a foreign key onto `ib_accounts.user_id`, not onto `users.id`, so the
   * introducer must already hold a partner row.
   */
  const [introducedFromOutside] = await db
    .insert(users)
    .values({
      email: 'ref-scope-introduced-outside@oxshare-e2e.test',
      passwordHash: 'x',
      firstName: 'Introduced',
      lastName: 'FromOutside',
      referredByIbUserId: outsideParentId,
    })
    .returning();
  introducedFromOutsideId = introducedFromOutside.id;

  await db.insert(clientTagAssignments).values([
    { userId: partnerId, tagId: tag.id },
    { userId: mineId, tagId: tag.id },
    // The sub-partner the reader may see, and the child partner whose profile
    // they may open. `subTheirs` and `outsideParent` are deliberately untagged.
    { userId: subMineId, tagId: tag.id },
    { userId: childPartnerId, tagId: tag.id },
    // In the territory; their INTRODUCER (outsideParent) is not.
    { userId: introducedFromOutsideId, tagId: tag.id },
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

describe("a partner's SUB-PARTNERS follow the reader's territory too", () => {
  /*
   * The same rule as the referred-client block above, one rung down, and it was
   * decided the other way until now: `findDirectPartners` was unscoped, on the
   * argument that scoping "would silently under-report a partner's line".
   *
   * That argument is about the COUNT, and this file's header is the precedent
   * for answering it by SAYING SO rather than by handing over the rows — a
   * sub-partner IS a client of this platform, and an unscoped roster gives away
   * their id, name and email. `directPartnersShown` / `directPartnersTotal` are
   * the `referredShown` / `referredTotal` of the line below.
   */
  type Detail = {
    parent: { userId: string; email: string } | null;
    parentOutsideTerritory: boolean;
    directPartners: { userId: string; email?: string }[];
  };

  const detailFor = async (who: typeof MASTER, userId: string): Promise<Detail> => {
    const session = await actingAs(ctx, 'admin', who);
    const res = await session.get(`/v1/admin/ib/partners/${userId}`).expect(200);
    return res.body as Detail;
  };

  it('MASTER sees the whole line', async () => {
    const body = await detailFor(MASTER, partnerId);

    expect(body.directPartners.map((p) => p.userId).sort()).toEqual(
      [subMineId, subTheirsId].sort(),
    );
  });

  it('a SCOPED reader gets only the sub-partner in their own territory', async () => {
    const body = await detailFor(SCOPED, partnerId);

    expect(body.directPartners.map((p) => p.userId)).toEqual([subMineId]);
  });

  it('says how many it withheld — a count, never who (R2)', async () => {
    /*
     * This case used to pin the opposite: NO out-of-territory count, on the
     * argument that "a count is a disclosure". The owner weighed that on
     * 28 Sep 2026 and ruled "a count, no identity" everywhere a relation
     * crosses a territory: a line that silently drops people reads as a
     * partner with nobody beneath them. The profile's `referredOutsideScope`
     * already said so for referred clients; this is the same for sub-partners.
     */
    const scoped = (await detailFor(SCOPED, partnerId)) as unknown as Record<string, unknown>;
    expect(scoped['directPartnersOutsideScope']).toBe(1);
    expect(typeof scoped['referredClientsOutsideScope']).toBe('number');

    const master = (await detailFor(MASTER, partnerId)) as unknown as Record<string, unknown>;
    expect(master['directPartnersOutsideScope']).toBe(0);
    expect(master['referredClientsOutsideScope']).toBe(0);
  });

  it('leaks NOTHING about the sub-partner outside the territory — not even the id', async () => {
    /*
     * The id specifically, because that is what this file's header calls "a
     * larger oracle than the 403-versus-404 distinction client-scope.ts refuses
     * to give away". Serialised whole so a value nested anywhere is caught.
     */
    const body = await detailFor(SCOPED, partnerId);
    const serialised = JSON.stringify(body);

    expect(serialised).not.toContain(subTheirsId);
    expect(serialised).not.toContain('ref-scope-sub-theirs@oxshare-e2e.test');
    expect(serialised).not.toContain('SubTheirs');
  });
});

describe("a partner's PARENT follows the reader's territory", () => {
  type Detail = {
    parent: { userId: string; email: string } | null;
    parentOutsideTerritory: boolean;
  };

  const detailFor = async (who: typeof MASTER, userId: string): Promise<Detail> => {
    const session = await actingAs(ctx, 'admin', who);
    const res = await session.get(`/v1/admin/ib/partners/${userId}`).expect(200);
    return res.body as Detail;
  };

  it('MASTER sees the parent in full', async () => {
    const body = await detailFor(MASTER, childPartnerId);

    expect(body.parent?.userId).toBe(outsideParentId);
    expect(body.parent?.email).toBe('ref-scope-parent-theirs@oxshare-e2e.test');
    expect(body.parentOutsideTerritory).toBe(false);
  });

  it('a SCOPED reader gets no parent identity at all — not the id, not the address', async () => {
    const body = await detailFor(SCOPED, childPartnerId);
    const serialised = JSON.stringify(body);

    expect(body.parent).toBeNull();
    expect(serialised).not.toContain(outsideParentId);
    expect(serialised).not.toContain('ref-scope-parent-theirs@oxshare-e2e.test');
  });

  it('but IS told a parent exists — "direct with the broker" is a different fact', async () => {
    /*
     * The one assertion that stops this fix creating a worse bug than it closes.
     * `parent: null` already meant "deals with the broker directly", which is
     * what a level 1 partner does, and that decides their terms. Without this
     * flag a scoped reader would read every out-of-territory parent as its
     * absence and misjudge the rung the partner is paid on.
     */
    const scopedView = await detailFor(SCOPED, childPartnerId);
    expect(scopedView.parentOutsideTerritory).toBe(true);

    // And a partner who genuinely has none reports the opposite, or the flag
    // would be indistinguishable from "always true when parent is null".
    const rootView = await detailFor(MASTER, partnerId);
    expect(rootView.parent).toBeNull();
    expect(rootView.parentOutsideTerritory).toBe(false);
  });
});

describe("the client profile's REFERRER follows the reader's territory", () => {
  /*
   * The same fix as the partner PARENT above, on the other surface that names
   * an introducer. This one was built unscoped on a recorded argument: hiding
   * the introducer would render the false sentence "not introduced by a
   * partner". True, and it treated "all" and "nothing" as the only options —
   * while `parentOutsideTerritory`, a few hundred lines away in the same
   * codebase, was already the third.
   *
   * The FIELD MASK never covered this. Masking hides COLUMNS by role; scope
   * hides ROWS by territory. A scoped-desk admin holding every field permission
   * was shown an out-of-territory person's address and full name.
   */
  type Profile = {
    referrer?: {
      ibUserId: string;
      email?: string;
      firstName?: string;
      lastName?: string;
      outsideTerritory: boolean;
    };
  };

  const profileFor = async (who: typeof MASTER, clientId: string): Promise<Profile> => {
    const session = await actingAs(ctx, 'admin', who);
    const res = await session.get(`/v1/admin/clients/${clientId}`).expect(200);
    return res.body as Profile;
  };

  it('MASTER reads the introducer in full', async () => {
    const body = await profileFor(MASTER, mineId);

    expect(body.referrer?.ibUserId).toBe(partnerId);
    expect(body.referrer?.email).toBe('ref-scope-partner@oxshare-e2e.test');
    expect(body.referrer?.outsideTerritory).toBe(false);
  });

  it('a SCOPED reader gets no introducer IDENTITY — not the address, not the name', async () => {
    const body = await profileFor(SCOPED, introducedFromOutsideId);
    const serialised = JSON.stringify(body.referrer ?? {});

    expect(
      body.referrer,
      'the card vanished entirely — that is the false sentence this fix exists to avoid',
    ).toBeDefined();
    expect(serialised).not.toContain('ref-scope-parent-theirs@oxshare-e2e.test');
    expect(serialised).not.toContain('Outside');
    expect(body.referrer?.email).toBeUndefined();
    expect(body.referrer?.firstName).toBeUndefined();
    expect(body.referrer?.lastName).toBeUndefined();
  });

  it('but IS told the client was introduced — the fact survives, the identity does not', async () => {
    // Without this the fix would be a worse bug than the one it closes: a
    // scoped desk would read every out-of-territory introducer as "walked in
    // off the street", which is a different commercial fact.
    const body = await profileFor(SCOPED, introducedFromOutsideId);
    expect(body.referrer?.outsideTerritory).toBe(true);
    // …and nothing else about them: no uuid, not even whether they are suspended.
    expect(body.referrer).toEqual({ since: expect.any(String), outsideTerritory: true });

    // And an in-territory introducer reports the opposite, or the flag would be
    // indistinguishable from "always true".
    const visible = await profileFor(SCOPED, mineId);
    expect(visible.referrer?.outsideTerritory).toBe(false);
    expect(visible.referrer?.email).toBe('ref-scope-partner@oxshare-e2e.test');
  });
});
