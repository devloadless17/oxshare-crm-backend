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
import { adminIpAllowlist, admins, loginAttempts, roles } from '../src/database/schema';
import { ALL_PERMISSIONS } from './support/all-permissions';

/**
 * RBAC-08 through the REAL assembly, with one administrator exempt (0192).
 *
 * Every request here comes from 127.0.0.1, and the one rule configured is
 * 203.0.113.0/24 — so every request is from OUTSIDE the listed networks. The
 * unit spec (`ip-allowlist.spec.ts`) builds the guard by hand; only this file
 * proves the guard is registered, runs before authentication, and that the
 * sign-in doors agree with it.
 *
 * The property that matters most is the sign-in door: it had to open to every
 * network so the exempt administrator can sign in from anywhere, and it must
 * tell an outside caller nothing except "signed in" — not whether a password
 * was right, nor whether an address is an administrator's — and must not let
 * the internet lock out the administrators who are NOT exempt.
 */

const OWNER = { email: 'exempt-owner@oxshare.com', password: 'owner-password-123' };
const STAFF = { email: 'office-staff@oxshare.com', password: 'staff-password-123' };
const ME = '/v1/admin/auth/me';
const LOGIN = SURFACES.admin.loginPath;
const REFRESH = '/v1/admin/auth/refresh';
const EXEMPTIONS = '/v1/admin/ip-allowlist/exemptions';

let ctx: HttpTestContext;
let owner: Session;
let staff: Session;
let ownerId: string;

const login = (creds: { email: string; password: string }) =>
  anonymous(ctx).post(LOGIN).set('Origin', SURFACES.admin.origin).send(creds);

const enforceOutsideList = () =>
  ctx.db.db
    .insert(adminIpAllowlist)
    .values({ cidr: '203.0.113.0/24', label: 'Office (not this machine)', createdBy: ownerId });

const clearList = () => ctx.db.db.delete(adminIpAllowlist);

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const passwords = new PasswordService();
  const [full] = await ctx.db.db
    .insert(roles)
    .values({
      name: 'Exemption Full',
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

  // Signed in while the list is empty — the office, so to speak.
  owner = await actingAs(ctx, 'admin', OWNER);
  staff = await actingAs(ctx, 'admin', STAFF);
  await owner.post(EXEMPTIONS, { adminId: ownerId, reason: 'Owner, travels' }).expect(201);
  await enforceOutsideList();
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('a session from outside the listed networks', () => {
  it('admits the exempt administrator and refuses everyone else', async () => {
    await owner.get(ME).expect(200);
    await staff.get(ME).expect(403);
    await anonymous(ctx).get('/v1/admin/clients').expect(403);
  });

  it('serves the exempt administrator the status, saying they are exempt', async () => {
    const res = await owner.get('/v1/admin/ip-allowlist').expect(200);
    const body = res.body as { youAreExempt: boolean; exemptAdmins: { email: string }[] };
    expect(body.youAreExempt).toBe(true);
    expect(body.exemptAdmins.map((e) => e.email)).toEqual([OWNER.email]);
  });

  it('carries no API key past the network check, even beside an exempt cookie', async () => {
    const res = await owner.get(ME).set('X-API-Key', 'oxk_anything');
    expect(res.status).toBe(403);
  });

  it('refuses the exempt administrator removing their OWN exemption from outside', async () => {
    const res = await owner.del(`${EXEMPTIONS}/${ownerId}`);
    expect(res.status).toBe(400);
    await owner.get(ME).expect(200);
  });

  it('lets anyone sign out from outside — ending a session grants nothing', async () => {
    const throwaway = await (async () => {
      await clearList();
      const s = await actingAs(ctx, 'admin', STAFF);
      await enforceOutsideList();
      return s;
    })();
    const res = await throwaway.post('/v1/admin/auth/logout');
    expect(res.status).not.toBe(403);
  });
});

describe('the sign-in door from outside', () => {
  it('signs the exempt administrator in — password, then authenticator — from outside', async () => {
    const res = await login(OWNER);
    expect(res.status).toBe(200);
    expect((res.body as { challengeToken?: string }).challengeToken).toBeTruthy();
    // Both steps through the real routes, from outside the listed networks.
    const session = await actingAs(ctx, 'admin', OWNER);
    await session.get(ME).expect(200);
  });

  it('will not finish OUTSIDE a sign-in a non-exempt admin began inside', async () => {
    await clearList();
    const { challengeToken } = (await login(STAFF)).body as { challengeToken: string };
    await enforceOutsideList();
    const attempts = [
      anonymous(ctx)
        .post('/v1/admin/auth/totp/setup')
        .set('Origin', SURFACES.admin.origin)
        .send({ challengeToken }),
      anonymous(ctx)
        .post('/v1/admin/auth/totp/verify')
        .set('Origin', SURFACES.admin.origin)
        .send({ challengeToken, code: '000000' }),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.status).toBe(403);
      expect((res.body as { code: string }).code).toBe('NETWORK_NOT_PERMITTED');
    }
    // Refused before the code was judged: no failure counted against them.
    const [row] = await ctx.db.db
      .select()
      .from(loginAttempts)
      .where(eq(loginAttempts.identifier, STAFF.email));
    expect(row?.failures ?? 0).toBe(0);
  });

  it('answers every other outcome identically, confirming nothing', async () => {
    const outcomes = await Promise.all([
      login({ ...OWNER, password: 'wrong-password-1' }),
      login(STAFF),
      login({ ...STAFF, password: 'wrong-password-1' }),
      login({ email: 'nobody@oxshare.com', password: 'whatever-123' }),
    ]);
    const shapes = outcomes.map((r) => ({
      status: r.status,
      code: (r.body as { code: string }).code,
      message: (r.body as { message: string }).message,
    }));
    expect(new Set(shapes.map((s) => JSON.stringify(s))).size).toBe(1);
    expect(shapes[0]).toMatchObject({ status: 403, code: 'NETWORK_NOT_PERMITTED' });
  });

  it('cannot be used to lock out an administrator who is not exempt', async () => {
    for (let i = 0; i < 8; i++) await login({ ...STAFF, password: `wrong-${i}-password` });
    const [row] = await ctx.db.db
      .select()
      .from(loginAttempts)
      .where(eq(loginAttempts.identifier, STAFF.email));
    expect(row?.failures ?? 0).toBe(0);

    // Back inside, the staff member signs in as ever.
    await clearList();
    try {
      expect((await login(STAFF)).status).toBe(200);
    } finally {
      await enforceOutsideList();
    }
  });
});

describe('refresh from outside', () => {
  const refresh = (s: Session) =>
    anonymous(ctx)
      .post(REFRESH)
      .set('Cookie', s.cookieHeader())
      .set('Origin', SURFACES.admin.origin);

  it('renews the exempt administrator and refuses the rest without revoking', async () => {
    expect((await refresh(owner)).status).toBe(200);

    // A fresh staff session: the sign-out case above revoked every staff family.
    await clearList();
    const staffNow = await actingAs(ctx, 'admin', STAFF);
    await enforceOutsideList();

    const refused = await refresh(staffNow);
    expect(refused.status).toBe(403);
    expect((refused.body as { code: string }).code).toBe('NETWORK_NOT_PERMITTED');

    // Nothing was consumed: back inside, the same session renews.
    await clearList();
    try {
      expect((await refresh(staffNow)).status).toBe(200);
    } finally {
      await enforceOutsideList();
    }
  });
});

describe('withdrawing an exemption', () => {
  it('takes effect on the next request', async () => {
    await clearList();
    const fresh = await actingAs(ctx, 'admin', OWNER);
    // Revoked from inside (allowed), then enforcement resumes.
    await fresh.del(`${EXEMPTIONS}/${ownerId}`).expect(200);
    await enforceOutsideList();
    await fresh.get(ME).expect(403);
  });
});

describe('token routes from outside', () => {
  const RESET = '/v1/admin/password-reset/complete';
  const plantResetToken = async (email: string, token: string) => {
    await ctx.db.db
      .update(admins)
      .set({
        passwordResetTokenHash: hashInviteToken(token),
        passwordResetExpiry: new Date(Date.now() + 60 * 60_000),
      })
      .where(eq(admins.email, email));
  };
  const spend = (token: string, password: string) =>
    anonymous(ctx).post(RESET).set('Origin', SURFACES.admin.origin).send({ token, password });

  it("lets the exempt owner spend a reset link abroad, and refuses anyone else's", async () => {
    await clearList();
    const fresh = await actingAs(ctx, 'admin', OWNER);
    await fresh.post(EXEMPTIONS, { adminId: ownerId, reason: 'Owner, travels' }).expect(201);
    await enforceOutsideList();

    await plantResetToken(OWNER.email, 'owner-reset-token-1');
    expect((await spend('owner-reset-token-1', OWNER.password)).status).toBe(200);

    await plantResetToken(STAFF.email, 'staff-reset-token-1');
    const refused = await spend('staff-reset-token-1', STAFF.password);
    expect(refused.status).toBe(403);
    expect((refused.body as { code: string }).code).toBe('NETWORK_NOT_PERMITTED');

    // The refusal rolled the spend back: the same link works from a listed network.
    await clearList();
    try {
      expect((await spend('staff-reset-token-1', STAFF.password)).status).toBe(200);
    } finally {
      await enforceOutsideList();
    }
  });

  it("never admits an invite route from outside, even beside an exempt admin's cookie", async () => {
    await clearList();
    const exemptOwner = await actingAs(ctx, 'admin', OWNER);
    await enforceOutsideList();
    await exemptOwner.get(ME).expect(200);
    const res = await exemptOwner.get('/v1/admin/invite/validate?token=anything');
    expect(res.status).toBe(403);
  });
});
