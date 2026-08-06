import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  actingAs,
  anonymous,
  startHttpTestApp,
  stopHttpTestApp,
  SURFACES,
  type HttpTestContext,
} from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import { adminInvites, admins, roles } from '../src/database/schema';
import { eq } from 'drizzle-orm';

/**
 * The whole invite journey, over HTTP: invite with a role → accept → log in
 * holding exactly that role.
 *
 * `test/invite-lifecycle.spec.ts` covers the service thoroughly against fakes.
 * What it cannot show is the part an operator actually cares about: that the
 * person at the other end of the email can SIGN IN AFTERWARDS, with the
 * permissions they were promised and no others. That needs a real database and
 * the real login route, because the failure found here lives in the seam
 * between how the email is stored and how it is looked up.
 */

const MASTER = { email: 'journey-master@oxshare.com', password: 'admin-password-123' };

const NEW_ADMIN_PASSWORD = 'invitee-password-123';

let ctx: HttpTestContext;
let reviewerRoleId: string;

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const passwords = new PasswordService();

  const [masterRole] = await ctx.db.db
    .insert(roles)
    .values({ name: 'Journey Master', permissions: ['*'], isSystem: true })
    .returning();

  const [reviewerRole] = await ctx.db.db
    .insert(roles)
    .values({
      name: 'Journey Reviewer',
      description: 'KYC only.',
      permissions: ['kyc.review', 'users.view'],
      isSystem: false,
    })
    .returning();
  reviewerRoleId = reviewerRole.id;

  await ctx.db.db.insert(admins).values({
    email: MASTER.email,
    passwordHash: await passwords.hash(MASTER.password),
    name: 'Journey Master',
    role: 'master_admin',
    roleId: masterRole.id,
    permissions: ['*'],
    status: 'active',
  });
});

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

/** Invite someone and return the accept token from the dev-echoed link. */
async function invite(email: string, name: string, roleId?: string) {
  const master = await actingAs(ctx, 'admin', MASTER);
  const res = await master.post('/v1/admin/invite', { email, name, roleId });
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(`invite failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  const url = (res.body as { inviteUrl?: string }).inviteUrl;
  if (!url) throw new Error('no inviteUrl echoed — this spec relies on the non-production echo');
  return { token: new URL(url).searchParams.get('token')!, master };
}

function acceptInvite(token: string, password: string) {
  return anonymous(ctx)
    .post('/v1/admin/invite/accept')
    .set('Origin', SURFACES.admin.origin)
    .send({ token, password });
}

describe('invite → accept → sign in with the granted role', () => {
  it('carries the role through to what the new admin may do', async () => {
    const email = 'journey-reviewer@oxshare.com';
    const { token } = await invite(email, 'Journey Reviewer', reviewerRoleId);

    await acceptInvite(token, NEW_ADMIN_PASSWORD).expect(200);

    // The point of the whole flow: they can sign in on their own afterwards.
    const invitee = await actingAs(ctx, 'admin', { email, password: NEW_ADMIN_PASSWORD });
    const me = await invitee.get('/v1/admin/auth/me').expect(200);
    const profile = me.body as { role: string; permissions: string[]; status: string };

    expect(profile.role).toBe('sub_admin');
    expect(profile.status).toBe('active');
    expect(profile.permissions.sort()).toEqual(['kyc.review', 'users.view']);
  });

  it('grants ONLY the role — anything else is 403, not 401', async () => {
    const email = 'journey-scoped@oxshare.com';
    const { token } = await invite(email, 'Journey Scoped', reviewerRoleId);
    await acceptInvite(token, NEW_ADMIN_PASSWORD).expect(200);

    const invitee = await actingAs(ctx, 'admin', { email, password: NEW_ADMIN_PASSWORD });
    // users.view is granted, so the directory is readable...
    await invitee.get('/v1/admin/users').expect(200);
    // ...but roles.manage is not, and the refusal must be FORBIDDEN. A 401 would
    // send the admin app into a refresh-and-retry loop it can never win.
    await invitee.post('/v1/admin/roles', { name: 'Nope', permissions: [] }).expect(403);
  });

  it('signs the invitee in immediately on accept, without a second login', async () => {
    const email = 'journey-autologin@oxshare.com';
    const { token } = await invite(email, 'Journey Auto', reviewerRoleId);

    const res = await acceptInvite(token, NEW_ADMIN_PASSWORD).expect(200);
    // The accept response sets the session cookies itself.
    const setCookie = res.headers['set-cookie'] as unknown as string[] | undefined;
    expect(setCookie?.join(';')).toMatch(/admin/i);
  });

  it('an invite email with CAPITALS still lets its owner log in', async () => {
    /*
     * The regression this file exists for.
     *
     * `AdminsStore.findByEmail` lowercases its ARGUMENT and compares it against a
     * plain case-sensitive varchar. The portal normalises on write
     * (auth.service.ts register: `dto.email.toLowerCase()`); the admin invite
     * path did not. So inviting "Sam@Oxshare.com" stored that verbatim, and every
     * later lookup searched for "sam@oxshare.com" and found nothing.
     *
     * The cruel part is the timing: accept auto-signs them in, so onboarding
     * looks like it worked. The failure surfaces the next morning, when they try
     * to log in with the password they just chose and are told it is wrong.
     */
    const email = 'Journey.Mixed@Oxshare.com';
    const { token } = await invite(email, 'Journey Mixed', reviewerRoleId);
    await acceptInvite(token, NEW_ADMIN_PASSWORD).expect(200);

    // As typed on the invite...
    const asInvited = await actingAs(ctx, 'admin', { email, password: NEW_ADMIN_PASSWORD });
    await asInvited.get('/v1/admin/auth/me').expect(200);

    // ...and as they will actually type it, which is rarely the same thing.
    const asTyped = await actingAs(ctx, 'admin', {
      email: email.toLowerCase(),
      password: NEW_ADMIN_PASSWORD,
    });
    await asTyped.get('/v1/admin/auth/me').expect(200);
  });
});

describe('outstanding invites are visible and cancellable', () => {
  it('lists an invite that has been sent and not accepted', async () => {
    // Without this an invite vanished on send: the directory lists accepted
    // admins only, so "did you invite Sam?" was answerable only from sent mail.
    const email = 'journey-pending@oxshare.com';
    const { master } = await invite(email, 'Journey Pending', reviewerRoleId);

    const res = await master.get('/v1/admin/invites').expect(200);
    const rows = res.body as Array<{ email: string; tokenHash?: string; expiresAt: string }>;
    const row = rows.find((r) => r.email === email);

    expect(row).toBeDefined();
    expect(new Date(row!.expiresAt).getTime()).toBeGreaterThan(Date.now());
    // The list is for deciding, not a second delivery channel for the credential.
    expect(row).not.toHaveProperty('tokenHash');
    expect(row).not.toHaveProperty('token');
  });

  it('revoking kills the accept link immediately', async () => {
    const email = 'journey-revoked@oxshare.com';
    const { token, master } = await invite(email, 'Journey Revoked', reviewerRoleId);

    const list = await master.get('/v1/admin/invites').expect(200);
    const row = (list.body as Array<{ id: string; email: string }>).find((r) => r.email === email)!;

    await master.del(`/v1/admin/invites/${row.id}`).expect(200);

    // The 48-hour bearer credential that creates an admin account is now dead.
    await acceptInvite(token, NEW_ADMIN_PASSWORD).expect(404);
    await anonymous(ctx).get(`/v1/admin/invite/validate?token=${token}`).expect(400);
  });

  it('drops a revoked invite from the list', async () => {
    const email = 'journey-gone@oxshare.com';
    const { master } = await invite(email, 'Journey Gone', reviewerRoleId);
    const list = await master.get('/v1/admin/invites').expect(200);
    const row = (list.body as Array<{ id: string; email: string }>).find((r) => r.email === email)!;

    await master.del(`/v1/admin/invites/${row.id}`).expect(200);

    const after = await master.get('/v1/admin/invites').expect(200);
    expect((after.body as Array<{ email: string }>).some((r) => r.email === email)).toBe(false);
  });

  it('refuses a SECOND outstanding invite to the same address', async () => {
    // Two live tokens for one email meant the first accept created the account
    // and the second hit the unique constraint on admins.email — a 500 at the
    // last step of onboarding, for someone who did nothing wrong.
    const email = 'journey-dup@oxshare.com';
    const { master } = await invite(email, 'Journey Dup', reviewerRoleId);

    const second = await master.post('/v1/admin/invite', {
      email,
      name: 'Journey Dup Again',
      roleId: reviewerRoleId,
    });
    expect(second.status).toBe(409);
  });

  it('allows a fresh invite once the previous one is revoked', async () => {
    // Revoke DELETES the row, so the re-invite path is not blocked by a tombstone.
    const email = 'journey-reinvite@oxshare.com';
    const { master } = await invite(email, 'Journey Reinvite', reviewerRoleId);
    const list = await master.get('/v1/admin/invites').expect(200);
    const row = (list.body as Array<{ id: string; email: string }>).find((r) => r.email === email)!;
    await master.del(`/v1/admin/invites/${row.id}`).expect(200);

    const again = await master.post('/v1/admin/invite', {
      email,
      name: 'Journey Reinvite',
      roleId: reviewerRoleId,
    });
    expect([200, 201]).toContain(again.status);
  });

  it('hides an invite whose address already has an admin', async () => {
    /*
     * Found in the live dev database: one address held TWO invite rows — one
     * accepted, one not — plus the admin account. The unaccepted one sat under
     * "Outstanding Invites" describing a link that can never be accepted, since
     * `acceptInvite` re-checks `findByEmail` and refuses.
     *
     * `createInvite` now refuses the duplicate that created it, so this asserts
     * the other half: the rows already in the table, and the paths that will
     * never go through `createInvite` at all — an admin seeded or created
     * directly while an invite was outstanding lands in the same state.
     *
     * The second row is inserted directly BECAUSE the service-level guard would
     * refuse it. That is the point: this is about data the guard cannot reach.
     */
    const email = 'journey-orphan@oxshare.com';
    const { token, master } = await invite(email, 'Journey Orphan', reviewerRoleId);

    const [inviter] = await ctx.db.db.select().from(admins).where(eq(admins.email, MASTER.email));
    await ctx.db.db.insert(adminInvites).values({
      email,
      name: 'Journey Orphan Duplicate',
      tokenHash: 'orphaned-duplicate-invite-hash',
      role: 'sub_admin',
      roleId: reviewerRoleId,
      invitedBy: inviter.id,
      expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
      accepted: false,
    });

    // Both rows are live and unaccepted at this point.
    const before = await master.get('/v1/admin/invites').expect(200);
    expect((before.body as Array<{ email: string }>).filter((r) => r.email === email)).toHaveLength(
      2,
    );

    await acceptInvite(token, NEW_ADMIN_PASSWORD).expect(200);

    // The duplicate is still unaccepted and still unexpired — and must not be
    // offered as outstanding, because the account it would create exists.
    const after = await master.get('/v1/admin/invites').expect(200);
    expect((after.body as Array<{ email: string }>).filter((r) => r.email === email)).toEqual([]);
  });

  it('lets a role be deleted when only a dead invite still references it', async () => {
    /*
     * The second symptom of the same stale row.
     *
     * Role deletion refuses while a pending invite references the role, which is
     * right — the invite would otherwise be accepted with its `role_id` nulled
     * and no permissions at all. But an invite whose address already has an admin
     * can never be accepted, so it is holding a role hostage on behalf of a grant
     * that cannot happen, and the refusal even advises "wait for expiry".
     */
    const master = await actingAs(ctx, 'admin', MASTER);
    const created = await master.post('/v1/admin/roles', {
      name: 'Journey Disposable',
      permissions: ['users.view'],
    });
    const roleId = (created.body as { id: string }).id;

    const email = 'journey-hostage@oxshare.com';
    const { token } = await invite(email, 'Journey Hostage', roleId);

    // Held, correctly, while the invite is genuinely outstanding.
    await master.del(`/v1/admin/roles/${roleId}`).expect(409);

    await acceptInvite(token, NEW_ADMIN_PASSWORD).expect(200);
    // The new admin holds the role directly now, so clear that reference too —
    // this test is about the INVITE, not about deleting a role in use.
    const [holder] = await ctx.db.db.select().from(admins).where(eq(admins.email, email));
    await ctx.db.db.update(admins).set({ roleId: null }).where(eq(admins.id, holder.id));

    // Insert the orphan: unaccepted, unexpired, and unacceptable.
    await ctx.db.db.insert(adminInvites).values({
      email,
      name: 'Journey Hostage Duplicate',
      tokenHash: 'hostage-duplicate-invite-hash',
      role: 'sub_admin',
      roleId,
      invitedBy: holder.id,
      expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
      accepted: false,
    });

    await master.del(`/v1/admin/roles/${roleId}`).expect(200);
  });

  it('refuses to revoke an invite that has already been accepted', async () => {
    const email = 'journey-accepted@oxshare.com';
    const { token, master } = await invite(email, 'Journey Accepted', reviewerRoleId);
    const list = await master.get('/v1/admin/invites').expect(200);
    const row = (list.body as Array<{ id: string; email: string }>).find((r) => r.email === email)!;

    await acceptInvite(token, NEW_ADMIN_PASSWORD).expect(200);

    // The account exists now; revoking would change nothing and imply it had.
    await master.del(`/v1/admin/invites/${row.id}`).expect(400);
  });
});
