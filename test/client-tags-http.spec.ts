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
let alphaClientId: number;
let betaClientId: number;
let scopedAdminId: string;

interface TagBody {
  id: string;
  slug: string;
  label: string;
}
/** What a tag change answers (`ClientTagChangeResultDto`). */
interface ChangeBody {
  assignments: TagBody[];
  stillVisible: boolean;
}
interface ListBody {
  items: { id: number; email?: string; firstName?: string; tags?: TagBody[] }[];
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
    const body = res.body as ChangeBody;
    expect(body.assignments.map((t) => t.id)).toContain(alphaTagId);
    expect(body.stillVisible).toBe(true);
  });

  it('is idempotent — assigning twice is not an error', async () => {
    // The composite primary key plus ON CONFLICT DO NOTHING (ARCHITECTURE
    // §6.3). Two admins tagging the same client in the same second is ordinary,
    // and a check-then-insert would 500 the second one.
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.post(`${CLIENTS}/${alphaClientId}/tags/${alphaTagId}`);
    expect(res.status).toBe(201);
    expect((res.body as ChangeBody).assignments.filter((t) => t.id === alphaTagId)).toHaveLength(1);
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

  it('the tag COUNT follows the territory — a cohort size is a disclosure', async () => {
    /*
     * `clientCount` was a platform-wide aggregate, defended on the grounds that
     * the rows are tags rather than clients and a number is "not a way to reach
     * anybody's record". True, and beside the point: `admin-stats.service.ts`
     * opens "A COUNT IS A DISCLOSURE", and a desk restricted to one tag could
     * read the size of every cohort in the business off this one screen.
     */
    const scoped = await actingAs(ctx, 'admin', SCOPED);
    const master = await actingAs(ctx, 'admin', MASTER);

    const asScoped = (await scoped.get(TAGS).expect(200)).body as {
      slug: string;
      clientCount: number;
    }[];
    const asMaster = (await master.get(TAGS).expect(200)).body as {
      slug: string;
      clientCount: number;
    }[];

    const betaFor = (rows: { slug: string; clientCount: number }[]) =>
      rows.find((t) => t.slug === 'beta-desk')?.clientCount;
    const alphaFor = (rows: { slug: string; clientCount: number }[]) =>
      rows.find((t) => t.slug === 'alpha-desk')?.clientCount;

    // The reader's own cohort is counted normally — this is not "scoped to nothing".
    expect(alphaFor(asScoped), 'the reader cannot count their OWN cohort').toBeGreaterThan(0);
    expect(alphaFor(asScoped)).toBe(alphaFor(asMaster));

    // A cohort entirely outside the territory reports 0 to them, and its real
    // size to a master. Without the master half this would pass against a
    // system that had simply stopped counting.
    expect(betaFor(asScoped), 'an out-of-territory cohort reported its size').toBe(0);
    expect(betaFor(asMaster), 'the master lost a count they are entitled to').toBeGreaterThan(0);
  });

  it('but the VOCABULARY is not filtered — a label you cannot count is still assignable', async () => {
    /*
     * The deliberate half, pinned so a later "fix" cannot quietly turn the
     * scoped count into a scoped list. An operator has to see a label to assign
     * it, and the label is the business's taxonomy rather than a fact about any
     * client. The predicate therefore rides in the JOIN, not a WHERE — a WHERE
     * drops the tag row itself once no visible client carries it.
     */
    const scoped = await actingAs(ctx, 'admin', SCOPED);
    const slugs = ((await scoped.get(TAGS).expect(200)).body as { slug: string }[]).map(
      (t) => t.slug,
    );

    expect(slugs, 'the scoped count became a scoped list').toContain('beta-desk');
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

  it('lets a scoped admin put a tag from OUTSIDE their territory on a client they can see', async () => {
    /*
     * REVERSED on the owner's instruction, 28 Sep 2026: "an admin can put any
     * tags on the client that is in his territory even if the tags are not in
     * his territory". This used to answer 400 "only apply tags within your own
     * client scope", which made handing a client to another desk impossible.
     *
     * The client keeps the actor's own tag, so it stays in their view and no
     * confirmation is asked for — `client-tags-handoff.spec.ts` covers the
     * change that does take a client out of view.
     */
    const session = await actingAs(ctx, 'admin', SCOPED);
    const res = await session.post(`${CLIENTS}/${alphaClientId}/tags/${betaTagId}`);
    expect(res.status).toBe(201);
    const body = res.body as ChangeBody;
    expect(body.stillVisible).toBe(true);
    expect(body.assignments.map((t) => t.id)).toEqual(
      expect.arrayContaining([alphaTagId, betaTagId]),
    );

    // Leave the fixture as the blocks below expect it.
    const master = await actingAs(ctx, 'admin', MASTER);
    await master.del(`${CLIENTS}/${alphaClientId}/tags/${betaTagId}`).expect(200);
  });

  it('asks before removing the LAST tag keeping a client in the actor’s view', async () => {
    /*
     * This used to be a flat refusal (400 "the only tag putting this client in
     * your view"). The risk it guarded is real — an irreversible action that
     * removes the screen you would undo it from, the client vanishing mid-task
     * like a bug — and it is now met by a CONFIRMATION instead: 409
     * TAG_CHANGE_LEAVES_SCOPE until the change is resent with
     * `confirmLeavesScope=true`. A hand-off is legitimate; an accidental one is
     * what this stops.
     *
     * This fixture admin has no "new clients" grant, so an untagged client
     * really would leave their view.
     */
    const session = await actingAs(ctx, 'admin', SCOPED);
    const res = await session.del(`${CLIENTS}/${alphaClientId}/tags/${alphaTagId}`);
    expect(res.status).toBe(409);
    expect((res.body as { code?: string }).code).toBe('TAG_CHANGE_LEAVES_SCOPE');

    // Refused means NOT written: the tag is still there.
    const master = await actingAs(ctx, 'admin', MASTER);
    const tags = (await master.get(`${CLIENTS}/${alphaClientId}/tags`).expect(200))
      .body as TagBody[];
    expect(tags.map((t) => t.id)).toContain(alphaTagId);
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
  it('is refused, naming the consequence', async () => {
    /*
     * Cascading this delete would silently change what the scoped admin sees.
     * Before 0154 it was an escalation — an empty territory meant every client,
     * so removing their only scope row PROMOTED them to everyone.
     *
     * The FK is ON DELETE RESTRICT and is the real guarantee; this turns its
     * raw 23503 into a sentence that says what would have happened.
     */
    const session = await actingAs(ctx, 'admin', MASTER);
    const res = await session.del(`${TAGS}/${alphaTagId}`);

    expect(res.status).toBe(409);
    expect((res.body as { message?: string }).message).toMatch(/in their territory/i);
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

describe('a client’s OWN tag list is not filtered to the reader’s territory — decided, not overlooked', () => {
  /*
   * `AdminTagsService.tagsForClient` returns every tag on a client the reader
   * may see, including tags belonging to other desks' territories. That reads
   * like an oversight beside `unassign`, which DOES intersect the client's tags
   * against `actor.clientScope.tagIds` a few lines down — so this pins it as a
   * decision and records why the two differ.
   *
   * ── Why it is not a leak ────────────────────────────────────────────────────
   *
   * The tag VOCABULARY is already global by design: `AdminTagsService.list`
   * returns every tag with its counts to any holder of `tags.view` OR
   * `clients.view`, because "the vocabulary names how the business sees its
   * clients". So no label here is one the reader could not already enumerate.
   * What filtering would hide is only the ASSOCIATION between a client they
   * legitimately manage and another desk — which is operational context, not
   * client-owned data, and is the sort of thing a second desk handling the same
   * person usually needs to know.
   *
   * ── Why filtering would be actively worse ───────────────────────────────────
   *
   * A partial list is indistinguishable from a complete one. An operator seeing
   * two tags cannot tell that a third exists, and this endpoint is what the
   * profile renders — so they would reason about a client's segmentation from a
   * view silently missing part of it. That is the same failure `lib/masking.ts`
   * exists to prevent on the frontend: "hidden from you" and "there is none" are
   * different answers, and collapsing them is how somebody acts on the wrong
   * belief. The scoped alternatives elsewhere in this codebase all publish what
   * they withheld — `referredShown`/`referredTotal`,
   * `directPartnersShown`/`directPartnersTotal` — and there is nothing to
   * publish here that the reader cannot already see.
   *
   * ── And acting on it ─────────────────────────────────────────────────────────
   *
   * Since 28 Sep 2026 (owner) an admin may add or remove ANY tag on a client
   * they can see, foreign ones included — that is how a client moves between
   * desks. The one question asked about an action is "does it take the client
   * out of YOUR view?", and that is answered by a confirmation, not a refusal.
   * Every such change is audited with the actor's name.
   *
   * If this ever needs to change, the honest shape is the one used above: filter
   * AND report the count withheld. Do not filter silently.
   */
  /*
   * Its OWN foreign tag, minted here rather than reusing `betaTagId` — an
   * earlier block deletes that one, and a 404 from a tag that no longer exists
   * would look exactly like the filtering this asserts is absent.
   */
  let foreignTagId: string;

  beforeAll(async () => {
    const master = await actingAs(ctx, 'admin', MASTER);
    const created = await master.post(TAGS, { label: 'Other Desk Territory' }).expect(201);
    foreignTagId = (created.body as { id: string }).id;
    await master.post(`${CLIENTS}/${alphaClientId}/tags/${foreignTagId}`, {}).expect(201);
  });

  it('shows a scoped reader every tag on a client they may see, including another desk’s', async () => {
    const scoped = await actingAs(ctx, 'admin', SCOPED);
    const res = await scoped.get(`${CLIENTS}/${alphaClientId}/tags`).expect(200);

    const ids = (res.body as { id: string }[]).map((t) => t.id);
    expect(ids, 'the reader’s own territory tag is missing').toContain(alphaTagId);
    expect(
      ids,
      'a foreign tag was filtered out — see the note above before changing this',
    ).toContain(foreignTagId);
  });

  it('and lets them remove the foreign tag, since the client stays in their view', async () => {
    /*
     * Flipped with the owner's rule (28 Sep 2026). It used to answer 400 "within
     * your own client scope". The client keeps the reader's own territory tag,
     * so they still see it afterwards and nothing needs confirming.
     */
    const scoped = await actingAs(ctx, 'admin', SCOPED);
    const res = await scoped.del(`${CLIENTS}/${alphaClientId}/tags/${foreignTagId}`);

    expect(res.status).toBe(200);
    const body = res.body as ChangeBody;
    expect(body.stillVisible).toBe(true);
    expect(body.assignments.map((t) => t.id)).not.toContain(foreignTagId);
    expect(body.assignments.map((t) => t.id)).toContain(alphaTagId);
  });
});
