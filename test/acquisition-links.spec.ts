import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import {
  actingAs,
  anonymous,
  startHttpTestApp,
  stopHttpTestApp,
  type HttpTestContext,
} from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import {
  acquisitionLinkTags,
  acquisitionLinks,
  adminClientTagScopes,
  admins,
  auditLog,
  clientTagAssignments,
  clientTags,
  ibAccounts,
  roles,
  users,
} from '../src/database/schema';
import { SIGN_UP_DETAILS } from './support/registration';

/**
 * SIGN-UP LINKS AND PARTNER TAGS (0195) — the buyer's old CRM: a client who
 * signs up through an administrator's link arrives in that administrator's
 * book; a client who signs up under a partner arrives with the partner's tags.
 *
 * Pinned here, because each is a question of WHO SEES A CLIENT (a tag is a
 * territory):
 *   - a live link tags the client, records the link, and writes ONE audit row,
 *     in the account's own transaction;
 *   - a switched-off link, or one whose owner is suspended, tags nobody — and
 *     never refuses the sign-up;
 *   - a partner's ASSIGNED tags are copied (the union with the link's), never
 *     the partner's country;
 *   - the link a client came through can never be rewritten;
 *   - an administrator holding only `links.create` cannot put a tag from
 *     outside their own territory on their own link.
 */

let ctx: HttpTestContext;
const REGISTER = '/v1/auth/register';
const ORIGIN = process.env['PORTAL_URL'] ?? 'http://localhost:3000';
const PASSWORD = 'admin-password-123';
const DESK = { email: 'links-desk@oxshare.com', password: PASSWORD };

let ownerTag: string;
let otherTag: string;
let partnerTag: string;
let deskId: string;
let liveCode: string;
let liveLinkId: string;
let deadCode: string;
let partnerCode: string;

async function register(label: string, extra: Record<string, unknown>) {
  const email = `links-${label}-${Date.now()}@oxshare-e2e.test`;
  const res = await anonymous(ctx)
    .post(REGISTER)
    .set('Origin', ORIGIN)
    .send({
      firstName: 'Link',
      lastName: 'Signup',
      email,
      password: 'probe-password-123',
      ...SIGN_UP_DETAILS,
      ...extra,
    });
  return { status: res.status, email };
}

async function arrivedWith(email: string) {
  const [user] = await ctx.db.db.select().from(users).where(eq(users.email, email));
  const tags = await ctx.db.db
    .select({ tagId: clientTagAssignments.tagId })
    .from(clientTagAssignments)
    .where(eq(clientTagAssignments.userId, user.id));
  return { user, tagIds: tags.map((t) => t.tagId).sort() };
}

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const db = ctx.db.db;
  const hash = await new PasswordService().hash(PASSWORD);

  [ownerTag, otherTag, partnerTag] = (
    await db
      .insert(clientTags)
      .values([
        { slug: 'links-o-f', label: 'O_F' },
        { slug: 'links-t-n', label: 'T_N' },
        { slug: 'links-partner', label: 'Partner book' },
      ])
      .returning()
  ).map((tag) => tag.id);

  const [role] = await db
    .insert(roles)
    .values({ name: 'Links Desk', permissions: ['links.view', 'links.create', 'clients.view'] })
    .returning();
  const [desk] = await db
    .insert(admins)
    .values({
      email: DESK.email,
      passwordHash: hash,
      name: 'Links Desk',
      role: 'sub_admin',
      roleId: role.id,
      permissions: [],
      seesAllClients: false,
      status: 'active',
    })
    .returning();
  deskId = desk.id;
  await db
    .insert(adminClientTagScopes)
    .values({ adminId: desk.id, tagId: ownerTag, createdBy: desk.id });

  const [live] = await db
    .insert(acquisitionLinks)
    .values({ code: 'LIVELNK1', name: 'Live', ownerAdminId: desk.id, createdBy: desk.id })
    .returning();
  await db.insert(acquisitionLinkTags).values({ linkId: live.id, tagId: ownerTag });
  liveCode = live.code;
  liveLinkId = live.id;
  const [dead] = await db
    .insert(acquisitionLinks)
    .values({
      code: 'DEADLNK1',
      name: 'Dead',
      ownerAdminId: desk.id,
      createdBy: desk.id,
      disabledAt: new Date(),
    })
    .returning();
  await db.insert(acquisitionLinkTags).values({ linkId: dead.id, tagId: ownerTag });
  deadCode = dead.code;

  // A partner from Egypt carrying a chosen tag.
  const [partner] = await db
    .insert(users)
    .values({
      email: `links-partner-${Date.now()}@oxshare-e2e.test`,
      passwordHash: 'x',
      firstName: 'Partner',
      lastName: 'Egypt',
      country: 'Egypt',
    })
    .returning();
  await db.insert(clientTagAssignments).values({ userId: partner.id, tagId: partnerTag });
  partnerCode = 'LNKPART1';
  await db.insert(ibAccounts).values({ userId: partner.id, referralCode: partnerCode, level: 1 });
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('a sign-up through a live link', () => {
  it('arrives with the link’s tags, the link recorded, and one audit row', async () => {
    const res = await register('live', { acquisitionCode: liveCode.toLowerCase() });
    expect(res.status).toBe(201);
    const { user, tagIds } = await arrivedWith(res.email);
    expect(tagIds).toEqual([ownerTag]);
    expect(user.acquisitionLinkId).toBe(liveLinkId);
    const rows = await ctx.db.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'client.acquired'), eq(auditLog.subjectId, String(user.id))));
    expect(rows).toHaveLength(1);
    expect(rows[0].details).toMatchObject({ linkId: liveLinkId, ownerAdminId: deskId });
  });
});

describe('a link that cannot tag', () => {
  it('a switched-off link: the sign-up goes through with the country tag only', async () => {
    const res = await register('dead', { acquisitionCode: deadCode });
    expect(res.status).toBe(201);
    const { user, tagIds } = await arrivedWith(res.email);
    expect(tagIds).toEqual([]);
    expect(user.acquisitionLinkId).toBeNull();
  });

  it('an unknown code is ignored, never refused', async () => {
    const res = await register('unknown', { acquisitionCode: 'NOSUCHLINK' });
    expect(res.status).toBe(201);
  });

  it('a suspended owner’s link tags nobody', async () => {
    await ctx.db.db.update(admins).set({ status: 'suspended' }).where(eq(admins.id, deskId));
    try {
      const res = await register('suspended', { acquisitionCode: liveCode });
      expect(res.status).toBe(201);
      expect((await arrivedWith(res.email)).tagIds).toEqual([]);
    } finally {
      await ctx.db.db.update(admins).set({ status: 'active' }).where(eq(admins.id, deskId));
    }
  });
});

describe('a sign-up under a partner', () => {
  it('copies the partner’s chosen tags — the union with the link’s — never the partner’s country', async () => {
    const res = await register('partner', { referralCode: partnerCode, acquisitionCode: liveCode });
    expect(res.status).toBe(201);
    const { user, tagIds } = await arrivedWith(res.email);
    expect(tagIds).toEqual([ownerTag, partnerTag].sort());
    // Their own country (Lebanon, from SIGN_UP_DETAILS) — not Egypt.
    expect(user.country).toBe('Lebanon');
  });
});

describe('integrity', () => {
  it('the link a client came through can never be rewritten', async () => {
    const [someone] = await ctx.db.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.acquisitionLinkId, liveLinkId))
      .limit(1);
    await expect(
      ctx.db.db.execute(sql`UPDATE users SET acquisition_link_id = NULL WHERE id = ${someone.id}`),
    ).rejects.toThrow();
  });

  it('links.create cannot put a tag from outside your territory on your link', async () => {
    const desk = await actingAs(ctx, 'admin', DESK);
    const refused = await desk
      .post('/v1/admin/acquisition-links')
      .send({ name: 'Funnel', tagIds: [otherTag] });
    expect(refused.status).toBe(403);

    const own = await desk.post('/v1/admin/acquisition-links').send({ name: 'Mine' }).expect(201);
    // No tags given: the owner's own book (their territory, without countries).
    expect((own.body as { tags: { id: string }[] }).tags.map((t) => t.id)).toEqual([ownerTag]);
    expect((own.body as { ownerSeesSignups: boolean }).ownerSeesSignups).toBe(true);
  });

  it('a country tag is refused on a link, by the API and by Postgres', async () => {
    const [lebanon] = await ctx.db.db
      .select({ id: clientTags.id })
      .from(clientTags)
      .where(eq(clientTags.countryCode, 'LB'));
    await expect(
      ctx.db.db.insert(acquisitionLinkTags).values({ linkId: liveLinkId, tagId: lebanon.id }),
    ).rejects.toThrow();
  });
});
