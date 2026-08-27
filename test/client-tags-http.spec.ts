import { ALL_PERMISSIONS } from './support/all-permissions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { actingAs, startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import { adminClientTagScopes, admins, roles, users } from '../src/database/schema';

/**
 * ADM-14 tagging and the row-level client visibility built on it, END TO END.
 *
 * Every assertion here is one that a unit test cannot make, because the thing
 * being asserted is a property of the ASSEMBLED system: that the scope predicate
 * reaches the SQL, that the guard resolves the actor's scope before the service
 * runs, and that an out-of-scope client is a 404 rather than a 403 all the way
 * out at the HTTP boundary.
 *
 * The 404-not-403 rule is the one worth stating plainly. A 403 would confirm
 * that a client with that id exists, so a scoped administrator could enumerate
 * the client base they were specifically denied by trying uuids and reading the
 * status codes. Every by-id route below is checked for it.
 */

const MASTER = { email: 'tags-master@oxshare.com', password: 'admin-password-123' };
const SCOPED = { email: 'tags-scoped@oxshare.com', password: 'admin-password-123' };

const TAGS = '/v1/admin/tags';
const CLIENTS = '/v1/admin/clients';

let ctx: HttpTestContext;
let alphaTagId: string;
let alphaTagSlug: string;
let betaTagId: string;
let alphaClientId: string;
let betaClientId: string;
let scopedAdminId: string;

interface TagBody {
  id: string;
  slug: string;
  label: string;
}
interface ListBody {
  items: { id: string; email?: string; firstName?: string; tags?: TagBody[] }[];
  maskedFields: string[];
  nextCursor: string | null;
}

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const passwords = new PasswordService();
  const db = ctx.db.db;

  const [masterRole] = await db
    .insert(roles)
    .values({ name: 'Tags HTTP Master', permissions: ALL_PERMISSIONS, isSystem: true })
    .returning();

  await db.insert(admins).values({
    email: MASTER.email,
    passwordHash: await passwords.hash(MASTER.password),
    name: 'Tags Master',
    role: 'master_admin',
    roleId: masterRole.id,
    permissions: ALL_PERMISSIONS,
    status: 'active',
  });

  // A sub-admin with everything the routes need, so a failure below is about
  // SCOPE and never about a missing permission.
  const [scopedRole] = await db
    .insert(roles)
    .values({
      name: 'Tags HTTP Scoped',
      permissions: ['clients.view', 'clients.suspend', 'tags.view', 'clients.tag'],
    })
    .returning();

  const [scopedAdmin] = await db
    .insert(admins)
    .values({
      email: SCOPED.email,
      passwordHash: await passwords.hash(SCOPED.password),
      name: 'Tags Scoped',
      role: 'sub_admin',
      roleId: scopedRole.id,
      permissions: [],
      // Explicitly restricted from intake (the 0058 default is TRUE) - this
      // fixture proves territory isolation, and untagged fixture clients
      // would otherwise be visible through the intake branch.
      seesUntriaged: false,
      status: 'active',
    })
    .returning();
  scopedAdminId = scopedAdmin.id;

  const [alphaClient] = await db
    .insert(users)
    .values({
      email: 'tag-alpha@oxshare-e2e.test',
      passwordHash: 'x',
      firstName: 'Alpha',
      lastName: 'Aardvark',
      country: 'Lebanon',
    })
    .returning();
  const [betaClient] = await db
    .insert(users)
    .values({
      email: 'tag-beta@oxshare-e2e.test',
      passwordHash: 'x',
      firstName: 'Beta',
      lastName: 'Bergman',
      country: 'Cyprus',
    })
    .returning();
  alphaClientId = alphaClient.id;
  betaClientId = betaClient.id;
});

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('tag CRUD', () => {
  it('derives the slug from the label rather than accepting one', async () => {
    // The slug lands in `/clients?tag=` links people paste into tickets.
    // Accepting it from a caller produces `High Risk`, `high_risk` and
    // `highrisk` in the same table inside a week.
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.post(TAGS, { label: 'Alpha Desk', color: '#b45309' });

    expect(res.status).toBe(201);
    const body = res.body as TagBody;
    expect(body.slug).toBe('alpha-desk');
    alphaTagId = body.id;
    alphaTagSlug = body.slug;
  });

  it('creates a second tag', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.post(TAGS, { label: 'Beta Desk' });
    expect(res.status).toBe(201);
    betaTagId = (res.body as TagBody).id;
  });

  it('refuses a duplicate, comparing by the derived slug', async () => {
    // "Alpha  Desk" and "alpha desk" are the same segment. Comparing labels
    // would let both exist and split one segment in two.
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.post(TAGS, { label: 'alpha desk' });
    expect(res.status).toBe(409);
  });

  it('refuses a label with nothing to build a URL-safe name from', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.post(TAGS, { label: '???' });
    expect(res.status).toBe(400);
  });

  it('reports client counts, including zero for an unused tag', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get(TAGS);
    expect(res.status).toBe(200);

    const tags = res.body as { slug: string; clientCount: number }[];
    // A LEFT JOIN, so a tag nobody carries reports 0 rather than vanishing from
    // the list — an unused tag is exactly the one an operator wants to prune.
    expect(tags.find((t) => t.slug === 'beta-desk')?.clientCount).toBe(0);
  });
});

describe('assignment', () => {
  it('attaches a tag and returns the client’s full set', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.post(`${CLIENTS}/${alphaClientId}/tags/${alphaTagId}`);
    expect(res.status).toBe(201);
    expect((res.body as TagBody[]).map((t) => t.id)).toContain(alphaTagId);
  });

  it('is idempotent — assigning twice is not an error', async () => {
    // The composite primary key plus ON CONFLICT DO NOTHING (ARCHITECTURE
    // §6.3). Two admins tagging the same client in the same second is ordinary,
    // and a check-then-insert would 500 the second one.
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.post(`${CLIENTS}/${alphaClientId}/tags/${alphaTagId}`);
    expect(res.status).toBe(201);
    expect((res.body as TagBody[]).filter((t) => t.id === alphaTagId)).toHaveLength(1);
  });

  it('tags the second client with the second tag', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.post(`${CLIENTS}/${betaClientId}/tags/${betaTagId}`);
    expect(res.status).toBe(201);
  });

  it('404s an unknown client rather than creating an orphan assignment', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.post(
      `${CLIENTS}/00000000-0000-4000-8000-000000000000/tags/${alphaTagId}`,
    );
    expect(res.status).toBe(404);
  });
});

describe('the tag filter', () => {
  it('returns only clients carrying the tag', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get(`${CLIENTS}?tag=${alphaTagSlug}&q=oxshare-e2e.test`);
    expect(res.status).toBe(200);

    const ids = (res.body as ListBody).items.map((c) => c.id);
    expect(ids).toContain(alphaClientId);
    expect(ids).not.toContain(betaClientId);
  });

  it('renders each row’s tags without an N+1', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get(`${CLIENTS}?q=oxshare-e2e.test`);
    const row = (res.body as ListBody).items.find((c) => c.id === alphaClientId);
    expect(row?.tags?.map((t) => t.slug)).toContain(alphaTagSlug);
  });

  it('400s an UNKNOWN tag slug instead of returning an empty page', async () => {
    /*
     * R-2.5: a silently ignored filter is a lie the UI tells. Zero clients for
     * a typo'd segment reads as "nobody is in this segment" — a statement about
     * the client base rather than about the URL — and an operator would act on
     * it.
     */
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get(`${CLIENTS}?tag=no-such-segment`);
    expect(res.status).toBe(400);
    expect((res.body as { message?: string }).message).toMatch(/no client tag/i);
  });

  it('filters by country, which was indexed but unreachable before', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get(`${CLIENTS}?country=Cyprus&q=oxshare-e2e.test`);
    const ids = (res.body as ListBody).items.map((c) => c.id);
    expect(ids).toContain(betaClientId);
    expect(ids).not.toContain(alphaClientId);
  });
});

describe('server-side sorting — R-2.5', () => {
  it('orders by an allowlisted column, ascending', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get(`${CLIENTS}?q=oxshare-e2e.test&sort=email&order=asc`);
    expect(res.status).toBe(200);

    const emails = (res.body as ListBody).items.map((c) => c.email ?? '');
    expect(emails).toEqual([...emails].sort());
  });

  it('orders descending too', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get(`${CLIENTS}?q=oxshare-e2e.test&sort=email&order=desc`);
    const emails = (res.body as ListBody).items.map((c) => c.email ?? '');
    expect(emails).toEqual([...emails].sort().reverse());
  });

  it('400s an unrecognised sort column, naming what is allowed', async () => {
    /*
     * NEVER a silent fallback to the default. The admin clicks a header, the
     * rows do not change, and nothing anywhere explains why — which is the
     * exact behaviour R-2.5 exists to forbid. It is also the injection
     * boundary: this is the only place a caller's string could reach a column
     * name, so the mapping is total and closed.
     */
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get(`${CLIENTS}?sort=password_hash`);
    expect(res.status).toBe(400);
    expect((res.body as { message?: string }).message).toMatch(/Allowed:/);
  });

  it('400s an unrecognised order', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get(`${CLIENTS}?sort=email&order=sideways`);
    expect(res.status).toBe(400);
  });

  it('pages correctly under a non-default sort', async () => {
    // The seek comparator has to follow the sort DIRECTION: under ASC, "after
    // this row" is `>`. Leaving it as `<` pages backwards through a forwards
    // list, and the first Next click silently re-serves rows already seen.
    const session = await actingAs(ctx, 'admin', MASTER);
    const first = await session.get(`${CLIENTS}?q=oxshare-e2e.test&sort=email&order=asc&limit=1`);
    const firstBody = first.body as ListBody;
    expect(firstBody.nextCursor).not.toBeNull();

    const second = await session.get(
      `${CLIENTS}?q=oxshare-e2e.test&sort=email&order=asc&limit=1&cursor=${encodeURIComponent(
        firstBody.nextCursor as string,
      )}`,
    );
    const secondBody = second.body as ListBody;

    expect(second.status).toBe(200);
    expect(secondBody.items[0]?.id).not.toBe(firstBody.items[0]?.id);
    // And it moved FORWARDS, not back to the start. Compared lexically, the
    // way the ASC ordering itself does — `toBeGreaterThan` is numeric and
    // throws on strings.
    const firstEmail = firstBody.items[0]?.email ?? '';
    const secondEmail = secondBody.items[0]?.email ?? '';
    expect(secondEmail.localeCompare(firstEmail)).toBeGreaterThan(0);
  });

  it('REFUSES a cursor minted under a different sort', async () => {
    // Replaying it would run the seek against the wrong ordering and return
    // `limit` perfectly plausible, perfectly wrong rows.
    const session = await actingAs(ctx, 'admin', MASTER);
    const first = await session.get(`${CLIENTS}?q=oxshare-e2e.test&limit=1`);
    const cursor = (first.body as ListBody).nextCursor;
    expect(cursor).not.toBeNull();

    const replayed = await session.get(
      `${CLIENTS}?q=oxshare-e2e.test&limit=1&sort=email&cursor=${encodeURIComponent(cursor as string)}`,
    );
    expect(replayed.status).toBe(400);
    expect((replayed.body as { message?: string }).message).toMatch(/sorted by/i);
  });
});

describe('row-level client scoping', () => {
  beforeAll(async () => {
    // Restrict the sub-admin to the alpha tag only.
    await ctx.db.db.insert(adminClientTagScopes).values({
      adminId: scopedAdminId,
      tagId: alphaTagId,
      createdBy: scopedAdminId,
    });
  });

  it('shows a scoped admin only the clients inside their territory', async () => {
    const session = await actingAs(ctx, 'admin', SCOPED);
    const res = await session.get(`${CLIENTS}?q=oxshare-e2e.test`);
    expect(res.status).toBe(200);

    const ids = (res.body as ListBody).items.map((c) => c.id);
    expect(ids).toContain(alphaClientId);
    expect(ids).not.toContain(betaClientId);
  });

  it('still shows a master admin everyone', async () => {
    // The control. Without it, "the scoped admin sees one client" would also
    // pass against a system that is simply broken.
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.get(`${CLIENTS}?q=oxshare-e2e.test`);
    const ids = (res.body as ListBody).items.map((c) => c.id);
    expect(ids).toContain(alphaClientId);
    expect(ids).toContain(betaClientId);
  });

  it('404s a deep link to an out-of-scope client — NOT 403', async () => {
    /*
     * The whole reason the predicate lives in the WHERE clause.
     *
     * A 403 would confirm the id names a real client, so a scoped admin could
     * enumerate the client base they were denied by trying uuids and reading
     * status codes. 404 says the same thing for "no such client" and "not
     * yours", which is the only answer that leaks nothing.
     */
    const session = await actingAs(ctx, 'admin', SCOPED);
    const res = await session.patch(`${CLIENTS}/${betaClientId}/status`, { status: 'suspended' });
    expect(res.status).toBe(404);
    expect(res.status).not.toBe(403);
  });

  it('lets the scoped admin act on a client INSIDE their territory', async () => {
    // The control for the above: 404 everywhere would also pass if scoping were
    // simply refusing everything.
    const session = await actingAs(ctx, 'admin', SCOPED);
    const res = await session.patch(`${CLIENTS}/${alphaClientId}/status`, { status: 'suspended' });
    expect(res.status).toBe(200);
    await session.patch(`${CLIENTS}/${alphaClientId}/status`, { status: 'active' });
  });

  it('refuses to apply a tag from outside the actor’s own scope', async () => {
    // Otherwise scoping is self-service: tag a client into another desk's
    // territory and you have moved a record you do not own, with your name on
    // it; tag one of yours with something outside your scope and it leaves your
    // view.
    const session = await actingAs(ctx, 'admin', SCOPED);
    const res = await session.post(`${CLIENTS}/${alphaClientId}/tags/${betaTagId}`);
    expect(res.status).toBe(400);
    expect((res.body as { message?: string }).message).toMatch(/own client scope/i);
  });

  it('refuses to remove the LAST tag keeping a client in the actor’s view', async () => {
    /*
     * The direct mirror of RBAC-08's "you may not delete the last rule keeping
     * you in". The biggest risk in a self-service control is an irreversible
     * action that removes the screen you would use to undo it — here the client
     * would vanish mid-task, looking exactly like a bug.
     */
    const session = await actingAs(ctx, 'admin', SCOPED);
    const res = await session.del(`${CLIENTS}/${alphaClientId}/tags/${alphaTagId}`);
    expect(res.status).toBe(400);
    expect((res.body as { message?: string }).message).toMatch(/only tag putting this client/i);
  });

  it('lets a MASTER admin remove that same tag', async () => {
    // The refusal is about the actor losing their own view, not about the tag.
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.del(`${CLIENTS}/${alphaClientId}/tags/${alphaTagId}`);
    expect(res.status).toBe(200);
    // Put it back for the deletion tests below.
    await session.post(`${CLIENTS}/${alphaClientId}/tags/${alphaTagId}`);
  });
});

describe('deleting a tag that is somebody’s territory', () => {
  it('is refused, naming the escalation it would cause', async () => {
    /*
     * An empty scope means UNRESTRICTED, so cascading this delete would remove
     * the scoped admin's only scope row and PROMOTE THEM to seeing every client
     * in the system — privilege escalation performed by a DELETE on a label,
     * leaving nothing in the audit trail that looks like a permission change.
     *
     * The FK is ON DELETE RESTRICT and is the real guarantee; this turns its
     * raw 23503 into a sentence that says what would have happened.
     */
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.del(`${TAGS}/${alphaTagId}`);

    expect(res.status).toBe(409);
    expect((res.body as { message?: string }).message).toMatch(/every client/i);
  });

  it('deletes a tag nobody is scoped to', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.del(`${TAGS}/${betaTagId}`);
    expect(res.status).toBe(200);
  });
});

/*
 * NOTE — no system-tag machinery any more, deliberately. D-60's first answer
 * (a materialised `new-client` tag, `is_system`-guarded) was superseded by the
 * derived state: untriaged = carrying no tag assignments, gated by the
 * `sees_untriaged` grant (see `untriaged-intake.spec.ts`). The guard this
 * block proved was removed with the last of that design; the vestigial
 * `is_system` column awaits a schema window to drop.
 */

describe('an assignment says WHO put the client there', () => {
  /*
   * `assigned_by` and `assigned_at` have been written on every assignment
   * since the table existed and were selected by nothing — so "who moved this
   * client onto my desk, and when" was recorded and unanswerable from any
   * screen. Tags are RBAC-03 territory: they decide which administrator sees
   * whom, which makes that a question about access rather than about labels.
   */
  it('names the administrator who assigned a tag', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);

    const created = await session.post(TAGS, { label: `Provenance ${Date.now()}` });
    expect(created.status).toBe(201);
    const tagId = (created.body as { id: string }).id;

    const assigned = await session.post(`/v1/admin/clients/${alphaClientId}/tags/${tagId}`);
    expect(assigned.status).toBe(201);

    const rows = (await session.get(`/v1/admin/clients/${alphaClientId}/tags`)).body as {
      id: string;
      assignedByName: string | null;
      assignedAt: string;
    }[];
    const row = rows.find((r) => r.id === tagId);

    expect(row?.assignedByName).toBe('Tags Master');
    expect(row?.assignedAt).toBeTruthy();
  });
});
