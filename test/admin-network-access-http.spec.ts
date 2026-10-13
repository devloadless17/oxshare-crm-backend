import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  actingAs,
  anonymous,
  SURFACES,
  startHttpTestApp,
  stopHttpTestApp,
  type HttpTestContext,
  type Session,
} from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import { hashInviteToken } from '../src/store/admins.store';
import { adminInvites, admins, loginAttempts, roles } from '../src/database/schema';
import { ALL_PERMISSIONS } from './support/all-permissions';
import { OUTSIDE_SIGN_IN_REFUSED } from '../src/common/security/admin-network';

/**
 * RBAC-08 per person (0224), through the REAL assembly.
 *
 * Every request here comes from this machine, and the restricted administrator
 * is limited to 203.0.113.0/24 — so they are always OUTSIDE their networks. The
 * owner may connect from anywhere. "Back inside" is modelled by switching the
 * restricted administrator to anywhere in the table, since the loopback address
 * a test connects from is not something to pin a rule on.
 */

const OWNER = { email: 'net-owner@oxshare.com', password: 'owner-password-123' };
const STAFF = { email: 'net-staff@oxshare.com', password: 'staff-password-123' };
const ME = '/v1/admin/auth/me';
const LOGIN = SURFACES.admin.loginPath;
const REFRESH = '/v1/admin/auth/refresh';
const OFFICE = '203.0.113.0/24';

let ctx: HttpTestContext;
let owner: Session;
let staffId: string;
let ownerId: string;

const login = (creds: { email: string; password: string }) =>
  anonymous(ctx).post(LOGIN).set('Origin', SURFACES.admin.origin).send(creds);

const restrictStaff = () =>
  ctx.db.db
    .update(admins)
    .set({ accessAnywhere: false, allowedIps: [OFFICE] })
    .where(eq(admins.id, staffId));

const freeStaff = () =>
  ctx.db.db
    .update(admins)
    .set({ accessAnywhere: true, allowedIps: [] })
    .where(eq(admins.id, staffId));

/** A staff session started while they could connect from anywhere. */
const staffSessionThenRestrict = async () => {
  await freeStaff();
  const s = await actingAs(ctx, 'admin', STAFF);
  await restrictStaff();
  return s;
};

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const passwords = new PasswordService();
  const [full] = await ctx.db.db
    .insert(roles)
    .values({
      name: 'Network Full',
      description: 'Everything.',
      permissions: ALL_PERMISSIONS,
      isSystem: false,
    })
    .returning();
  const rows = await ctx.db.db
    .insert(admins)
    .values([
      {
        email: OWNER.email,
        passwordHash: await passwords.hash(OWNER.password),
        name: 'Owner',
        role: 'sub_admin',
        roleId: full.id,
        permissions: ALL_PERMISSIONS,
      },
      {
        email: STAFF.email,
        passwordHash: await passwords.hash(STAFF.password),
        name: 'Staff',
        role: 'sub_admin',
        roleId: full.id,
        permissions: ALL_PERMISSIONS,
      },
    ])
    .returning();
  ownerId = rows.find((r) => r.email === OWNER.email)!.id;
  staffId = rows.find((r) => r.email === STAFF.email)!.id;
  owner = await actingAs(ctx, 'admin', OWNER);
  await restrictStaff();
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('a session', () => {
  it('admits the anywhere administrator and refuses the restricted one outside their networks', async () => {
    const staff = await staffSessionThenRestrict();
    await owner.get(ME).expect(200);
    const res = await staff.get(ME);
    expect(res.status).toBe(403);
  });

  it('does not refuse an anonymous caller for the network — it is simply unauthenticated', async () => {
    await anonymous(ctx).get('/v1/admin/clients').expect(401);
  });

  it('lets a restricted administrator sign out from outside — ending a session grants nothing', async () => {
    const staff = await staffSessionThenRestrict();
    const res = await staff.post('/v1/admin/auth/logout');
    expect(res.status).not.toBe(403);
  });
});

describe('sign-in', () => {
  it('signs the anywhere administrator in from any network', async () => {
    const res = await login(OWNER);
    expect(res.status).toBe(200);
    expect((res.body as { challengeToken?: string }).challengeToken).toBeTruthy();
  });

  it('answers a refused network exactly as a wrong password, confirming nothing', async () => {
    await restrictStaff();
    const outcomes = await Promise.all([
      login(STAFF),
      login({ ...STAFF, password: 'wrong-password-1' }),
      login({ ...OWNER, password: 'wrong-password-1' }),
      login({ email: 'nobody@oxshare.com', password: 'whatever-123' }),
    ]);
    const shapes = outcomes.map((r) => ({
      status: r.status,
      code: (r.body as { code: string }).code,
      message: (r.body as { message: string }).message,
    }));
    expect(new Set(shapes.map((s) => JSON.stringify(s))).size).toBe(1);
    expect(shapes[0].message).toBe(OUTSIDE_SIGN_IN_REFUSED);
  });

  it('does not count a right password from the wrong network as a failure', async () => {
    await ctx.db.db.delete(loginAttempts).where(eq(loginAttempts.identifier, STAFF.email));
    await restrictStaff();
    for (let i = 0; i < 3; i++) await login(STAFF);
    const [row] = await ctx.db.db
      .select()
      .from(loginAttempts)
      .where(eq(loginAttempts.identifier, STAFF.email));
    expect(row?.failures ?? 0).toBe(0);
  });

  it('will not finish outside a sign-in begun while the account could connect from anywhere', async () => {
    await freeStaff();
    const { challengeToken } = (await login(STAFF)).body as { challengeToken: string };
    await restrictStaff();
    const res = await anonymous(ctx)
      .post('/v1/admin/auth/totp/setup')
      .set('Origin', SURFACES.admin.origin)
      .send({ challengeToken });
    expect(res.status).toBe(403);
    expect((res.body as { code: string }).code).toBe('NETWORK_NOT_PERMITTED');
  });
});

describe('refresh', () => {
  const refresh = (s: Session) =>
    anonymous(ctx)
      .post(REFRESH)
      .set('Cookie', s.cookieHeader())
      .set('Origin', SURFACES.admin.origin);

  it('refuses a restricted administrator outside their networks without revoking', async () => {
    const staff = await staffSessionThenRestrict();
    const refused = await refresh(staff);
    expect(refused.status).toBe(403);
    expect((refused.body as { code: string }).code).toBe('NETWORK_NOT_PERMITTED');

    // Nothing was consumed: allowed again, the same session renews.
    await freeStaff();
    try {
      expect((await refresh(staff)).status).toBe(200);
    } finally {
      await restrictStaff();
    }
  });
});

describe('a reset link', () => {
  it('is refused outside the administrator’s networks, and the refusal spends nothing', async () => {
    const token = 'staff-net-reset-token-1';
    await ctx.db.db
      .update(admins)
      .set({
        passwordResetTokenHash: hashInviteToken(token),
        passwordResetExpiry: new Date(Date.now() + 60 * 60_000),
      })
      .where(eq(admins.id, staffId));
    await restrictStaff();
    const spend = () =>
      anonymous(ctx)
        .post('/v1/admin/password-reset/complete')
        .set('Origin', SURFACES.admin.origin)
        .send({ token, password: STAFF.password });

    const refused = await spend();
    expect(refused.status).toBe(403);
    await freeStaff();
    try {
      expect((await spend()).status).toBe(200);
    } finally {
      await restrictStaff();
    }
  });
});

describe('editing an administrator', () => {
  const edit = (id: string, body: unknown) => owner.patch(`/v1/admin/users/${id}`, body);

  it('stores canonical addresses and takes effect on the next request', async () => {
    const res = await edit(staffId, {
      accessAnywhere: false,
      allowedIps: [' 198.51.100.7 ', '10.0.0.5/8', '198.51.100.7'],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      accessAnywhere: false,
      allowedIps: ['198.51.100.7/32', '10.0.0.0/8'],
    });

    await edit(staffId, { accessAnywhere: true }).expect(200);
    const [row] = await ctx.db.db.select().from(admins).where(eq(admins.id, staffId));
    // A stale list is cleared, so unticking the box later cannot revive it.
    expect(row).toMatchObject({ accessAnywhere: true, allowedIps: [] });
    await restrictStaff();
  });

  it('refuses a restricted administrator with no address, a bad address and a /0', async () => {
    for (const allowedIps of [[], ['not-an-ip'], ['0.0.0.0/0']]) {
      const res = await edit(staffId, { accessAnywhere: false, allowedIps });
      expect(res.status, JSON.stringify(allowedIps)).toBe(400);
    }
  });

  it('refuses changing your own network access', async () => {
    const res = await edit(ownerId, { accessAnywhere: false, allowedIps: [OFFICE] });
    expect(res.status).toBe(403);
    await owner.get(ME).expect(200);
  });

  it('reports each administrator’s network access in the directory row', async () => {
    const res = await owner.get(ME).expect(200);
    expect(res.body).toMatchObject({ accessAnywhere: true, allowedIps: [] });
  });
});

describe('inviting an administrator', () => {
  it('carries the chosen networks onto the invite, and onto the account', async () => {
    const email = 'net-invitee@oxshare.com';
    const res = await owner
      .post('/v1/admin/invite', {
        email,
        name: 'Invitee',
        permissions: ['admins.view'],
        accessAnywhere: false,
        allowedIps: ['198.51.100.7'],
      })
      .expect(201);
    const [invite] = await ctx.db.db
      .select()
      .from(adminInvites)
      .where(eq(adminInvites.email, email));
    expect(invite).toMatchObject({ accessAnywhere: false, allowedIps: ['198.51.100.7/32'] });

    // The link is echoed in the test environment.
    const token = new URL((res.body as { inviteUrl: string }).inviteUrl).searchParams.get('token');
    await anonymous(ctx)
      .post('/v1/admin/invite/accept')
      .set('Origin', SURFACES.admin.origin)
      .send({ token, password: 'invitee-password-123' })
      .expect(200);
    const [created] = await ctx.db.db.select().from(admins).where(eq(admins.email, email));
    expect(created).toMatchObject({ accessAnywhere: false, allowedIps: ['198.51.100.7/32'] });
  });

  it('gives a silent API invite the inviter’s own setting', async () => {
    const email = 'net-invitee-silent@oxshare.com';
    await owner
      .post('/v1/admin/invite', { email, name: 'Silent', permissions: ['admins.view'] })
      .expect(201);
    const [invite] = await ctx.db.db
      .select()
      .from(adminInvites)
      .where(eq(adminInvites.email, email));
    expect(invite).toMatchObject({ accessAnywhere: true, allowedIps: [] });
  });

  it('refuses an invite that could never sign in', async () => {
    const res = await owner.post('/v1/admin/invite', {
      email: 'net-invitee-2@oxshare.com',
      name: 'Invitee',
      permissions: ['admins.view'],
      accessAnywhere: false,
      allowedIps: [],
    });
    expect(res.status).toBe(400);
  });
});
