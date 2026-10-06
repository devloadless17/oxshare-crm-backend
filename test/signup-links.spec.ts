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
 * ONE SIGN-UP LINK PER ADMINISTRATOR (0198) — the owner's ruling, from the
 * buyer's old CRM: every administrator has a link, `/join/<their word>`, and a
 * client who signs up through it arrives with that administrator's tags AS THEY
 * ARE AT THAT MOMENT. A tag is a territory, so this decides who sees the client.
 *
 * Pinned:
 *   - every administrator HAS a link word, made from their name, unique;
 *   - a sign-up gets the administrator's territory tags read LIVE — change the
 *     territory and the next sign-up follows it (0195's copied tags drifted);
 *     never a country (the client has their own);
 *   - a suspended administrator's, a retired or an unknown word tags nobody and
 *     never refuses the sign-up;
 *   - a partner's assigned tags come along too (never the partner's country);
 *   - who brought a client is recorded once and cannot be rewritten;
 *   - your own link you rename freely; another administrator's needs
 *     admins.edit; a taken word is a 409 under the field.
 */

let ctx: HttpTestContext;
const REGISTER = '/v1/auth/register';
const ORIGIN = process.env['PORTAL_URL'] ?? 'http://localhost:3000';
const PASSWORD = 'admin-password-123';
const DESK = { email: 'signup-desk@oxshare.com', password: PASSWORD };
const OTHER = { email: 'signup-other@oxshare.com', password: PASSWORD };

let bookTag: string;
let laterTag: string;
let partnerTag: string;
let lebanon: string;
let deskId: string;
let otherId: string;
let deskSlug: string;
const partnerCode = 'SGNPART1';

async function register(label: string, extra: Record<string, unknown>) {
  const email = `signup-${label}-${Date.now()}@oxshare-e2e.test`;
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
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return email;
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

  [bookTag, laterTag, partnerTag] = (
    await db
      .insert(clientTags)
      .values([
        { slug: 'signup-o-f', label: 'O_F' },
        { slug: 'signup-later', label: 'Later book' },
        { slug: 'signup-partner', label: 'Partner book' },
      ])
      .returning()
  ).map((tag) => tag.id);
  [{ id: lebanon }] = await db
    .select({ id: clientTags.id })
    .from(clientTags)
    .where(eq(clientTags.countryCode, 'LB'));

  const [role] = await db
    .insert(roles)
    .values({ name: 'Signup Desk', permissions: ['clients.view', 'admins.view'] })
    .returning();
  const make = async (who: { email: string }, name: string) =>
    (
      await db
        .insert(admins)
        .values({
          email: who.email,
          passwordHash: hash,
          name,
          role: 'sub_admin',
          roleId: role.id,
          permissions: [],
          seesAllClients: false,
          status: 'active',
        })
        .returning()
    )[0];
  const desk = await make(DESK, 'Omar Farah');
  const other = await make(OTHER, 'Omar Farah');
  deskId = desk.id;
  otherId = other.id;
  deskSlug = desk.signupSlug;
  // A country in the territory: a desk AND a book. The link gives the book only.
  await db.insert(adminClientTagScopes).values([
    { adminId: desk.id, tagId: bookTag, createdBy: desk.id },
    { adminId: desk.id, tagId: lebanon, createdBy: desk.id },
  ]);

  const [partner] = await db
    .insert(users)
    .values({
      email: `signup-partner-${Date.now()}@oxshare-e2e.test`,
      passwordHash: 'x',
      firstName: 'Partner',
      lastName: 'Egypt',
      country: 'Egypt',
    })
    .returning();
  await db.insert(clientTagAssignments).values({ userId: partner.id, tagId: partnerTag });
  await db.insert(ibAccounts).values({ userId: partner.id, referralCode: partnerCode, level: 1 });
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('every administrator has a link word', () => {
  it('is made from the name, and a second "Omar Farah" gets a different one', () => {
    expect(deskSlug).toBe('omar-farah');
    expect(otherId).not.toBe(deskId);
  });

  it('a second administrator of the same name is suffixed, never refused', async () => {
    const [other] = await ctx.db.db.select().from(admins).where(eq(admins.id, otherId));
    expect(other.signupSlug).toBe('omar-farah-2');
  });
});

describe('a sign-up through an administrator’s link', () => {
  it('gets their territory tags — never the country in it — and records who brought them', async () => {
    const email = await register('desk', { acquisitionCode: ` ${deskSlug.toUpperCase()}/ ` });
    const { user, tagIds } = await arrivedWith(email);
    expect(tagIds).toEqual([bookTag]);
    expect(user.signedUpViaAdminId).toBe(deskId);
    const [row] = await ctx.db.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'client.acquired'), eq(auditLog.subjectId, String(user.id))));
    expect(row.details).toMatchObject({ adminId: deskId, tagIds: [bookTag] });
  });

  it('follows the territory LIVE: change it, and the next sign-up lands in the new book', async () => {
    await ctx.db.db
      .update(adminClientTagScopes)
      .set({ tagId: laterTag })
      .where(
        and(eq(adminClientTagScopes.adminId, deskId), eq(adminClientTagScopes.tagId, bookTag)),
      );
    try {
      const email = await register('moved', { acquisitionCode: deskSlug });
      expect((await arrivedWith(email)).tagIds).toEqual([laterTag]);
    } finally {
      await ctx.db.db
        .update(adminClientTagScopes)
        .set({ tagId: bookTag })
        .where(
          and(eq(adminClientTagScopes.adminId, deskId), eq(adminClientTagScopes.tagId, laterTag)),
        );
    }
  });

  it('a suspended administrator’s link tags nobody and brings nobody', async () => {
    await ctx.db.db.update(admins).set({ status: 'suspended' }).where(eq(admins.id, deskId));
    try {
      const email = await register('suspended', { acquisitionCode: deskSlug });
      const { user, tagIds } = await arrivedWith(email);
      expect(tagIds).toEqual([]);
      expect(user.signedUpViaAdminId).toBeNull();
    } finally {
      await ctx.db.db.update(admins).set({ status: 'active' }).where(eq(admins.id, deskId));
    }
  });

  it('an unknown word never refuses the sign-up', async () => {
    const email = await register('unknown', { acquisitionCode: 'nobody-has-this' });
    expect((await arrivedWith(email)).tagIds).toEqual([]);
  });

  it('under a partner too: both books, never the partner’s country', async () => {
    const email = await register('partner', {
      acquisitionCode: deskSlug,
      referralCode: partnerCode,
    });
    const { user, tagIds } = await arrivedWith(email);
    expect(tagIds).toEqual([bookTag, partnerTag].sort());
    expect(user.country).toBe('Lebanon');
  });

  it('who brought a client can never be rewritten', async () => {
    const [someone] = await ctx.db.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.signedUpViaAdminId, deskId))
      .limit(1);
    await expect(
      ctx.db.db.execute(
        sql`UPDATE users SET signed_up_via_admin_id = NULL WHERE id = ${someone.id}`,
      ),
    ).rejects.toThrow();
  });
});

describe('the console', () => {
  it('shows you your own link, the book it gives, and what it has brought', async () => {
    const desk = await actingAs(ctx, 'admin', DESK);
    const res = await desk.get('/v1/admin/signup-links/me').expect(200);
    expect(res.body).toMatchObject({
      slug: deskSlug,
      addsNoTag: false,
      tags: [{ id: bookTag, label: 'O_F' }],
    });
    expect(res.body.url).toMatch(new RegExp(`/join/${deskSlug}$`));
    expect(res.body.signups).toBeGreaterThanOrEqual(3);
  });

  it('lets you rename your own link; the old word then brings nobody', async () => {
    const desk = await actingAs(ctx, 'admin', DESK);
    const res = await desk
      .patch(`/v1/admin/signup-links/${deskId}`)
      .send({ slug: 'o_f' })
      .expect(200);
    expect(res.body.slug).toBe('o_f');
    const email = await register('retired', { acquisitionCode: deskSlug });
    expect((await arrivedWith(email)).user.signedUpViaAdminId).toBeNull();
    deskSlug = 'o_f';
  });

  it('refuses a taken word under the field, and a malformed one', async () => {
    const other = await actingAs(ctx, 'admin', OTHER);
    const taken = await other.patch(`/v1/admin/signup-links/${otherId}`).send({ slug: 'o_f' });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe('SIGNUP_LINK_TAKEN');
    expect(taken.body.fields?.slug).toBeTruthy();
    const bad = await other.patch(`/v1/admin/signup-links/${otherId}`).send({ slug: 'No Spaces!' });
    expect(bad.status).toBe(400);
  });

  it('gives your link a random word made by the SERVER; someone else’s needs admins.edit', async () => {
    const other = await actingAs(ctx, 'admin', OTHER);
    const res = await other.post(`/v1/admin/signup-links/${otherId}/random`).expect(200);
    expect(res.body.slug).toMatch(/^[a-km-np-z2-9]{8}$/);
    expect(res.body.url).toMatch(new RegExp(`/join/${res.body.slug}$`));
    const [stored] = await ctx.db.db.select().from(admins).where(eq(admins.id, otherId));
    expect(stored.signupSlug).toBe(res.body.slug);
    // The word it had is retired: a sign-up through it is brought by nobody.
    const email = await register('random-retired', { acquisitionCode: 'omar-farah-2' });
    expect((await arrivedWith(email)).user.signedUpViaAdminId).toBeNull();
    await other.post(`/v1/admin/signup-links/${deskId}/random`).expect(403);
  });

  it('refuses renaming ANOTHER administrator’s link without admins.edit', async () => {
    const other = await actingAs(ctx, 'admin', OTHER);
    const res = await other.patch(`/v1/admin/signup-links/${deskId}`).send({ slug: 'stolen' });
    expect(res.status).toBe(403);
    // …and the refusal is on the record (written after the answer, so wait for it).
    await expect
      .poll(
        async () =>
          (
            await ctx.db.db
              .select({ id: auditLog.id })
              .from(auditLog)
              .where(and(eq(auditLog.action, 'security.denied'), eq(auditLog.actorId, otherId)))
          ).length,
        { timeout: 3000 },
      )
      .toBeGreaterThan(0);
  });
});
