import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  actingAs,
  anonymous,
  parseSetCookies,
  sessionFrom,
  startHttpTestApp,
  stopHttpTestApp,
  SURFACES,
  type HttpTestContext,
} from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import { admins, roles, users } from '../src/database/schema';
import { COOKIE_BASES } from '../src/common/security/session-cookies';

/**
 * Authentication, over HTTP, through the real chain.
 *
 * THE HOLE THIS FILLS. Guards were tested well, but only ever in isolation:
 * `rbac.spec.ts` and `csrf.spec.ts` build `ExecutionContext` by hand, and
 * `route-authorization.spec.ts` reads Nest metadata to prove a guard is
 * ATTACHED. Nothing anywhere authenticated over HTTP and then hit a protected
 * endpoint — so nothing proved the assembled chain admits a legitimate request
 * and refuses an illegitimate one.
 *
 * That distinction is not theoretical in this codebase. `CsrfGuard` matched a
 * literal `'/admin'` against `req.path`; introducing the `/v1` prefix moved
 * every path, the match went false, the guard took the portal branch, found no
 * portal cookie and concluded there was nothing to protect — disarming
 * anti-forgery on every admin write. Every unit test still passed. Only a
 * request through the assembled stack could have caught it.
 *
 * Every credential here is obtained by logging in through the real route. None
 * is minted by the spec, so no assertion can pass against a token the
 * application would never have issued.
 */

const ADMIN = { email: 'http-admin@oxshare.com', password: 'admin-password-123' };
const CLIENT = { email: 'http-client@oxshare.com', password: 'client-password-123' };
const UNVERIFIED = { email: 'http-unverified@oxshare.com', password: 'client-password-123' };

/** Protected, side-effect free, one per surface. */
const ADMIN_ME = '/v1/admin/auth/me';
const PORTAL_ME = '/v1/auth/me';
/** Behind JwtAuthGuard *and* EmailVerifiedGuard. */
const PORTAL_KYC_STATUS = '/v1/kyc/status';

let ctx: HttpTestContext;

beforeAll(async () => {
  ctx = await startHttpTestApp();

  const passwords = new PasswordService();
  const [adminHash, clientHash] = await Promise.all([
    passwords.hash(ADMIN.password),
    passwords.hash(CLIENT.password),
  ]);

  const [masterRole] = await ctx.db.db
    .insert(roles)
    .values({
      name: 'Master Admin',
      description: 'Full access.',
      permissions: ['*'],
      isSystem: true,
    })
    .returning();

  await ctx.db.db.insert(admins).values({
    email: ADMIN.email,
    passwordHash: adminHash,
    name: 'HTTP Test Admin',
    role: 'master_admin',
    roleId: masterRole.id,
    permissions: ['*'],
  });

  await ctx.db.db.insert(users).values([
    {
      email: CLIENT.email,
      passwordHash: clientHash,
      firstName: 'Http',
      lastName: 'Client',
      type: 'individual',
      status: 'active',
      emailVerified: true,
    },
    {
      email: UNVERIFIED.email,
      passwordHash: clientHash,
      firstName: 'Not',
      lastName: 'Verified',
      type: 'individual',
      status: 'active',
      emailVerified: false,
    },
  ]);
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('the session a login actually produces', () => {
  it('refuses a protected admin route with no cookie', async () => {
    await anonymous(ctx).get(ADMIN_ME).expect(401);
  });

  it('admits the same route once signed in', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    const res = await session.get(ADMIN_ME).expect(200);
    expect(res.body).toMatchObject({ email: ADMIN.email });
  });

  it('sets an access cookie, a refresh cookie and a readable CSRF token', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    expect(session.cookies[COOKIE_BASES.adminAccess]).toBeTruthy();
    expect(session.cookies[COOKIE_BASES.adminRefresh]).toBeTruthy();
    // Readable on purpose — it is an anti-forgery token, not a credential.
    expect(session.csrfToken).toBeTruthy();
  });

  it('never returns the password hash on the profile route', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    const res = await session.get(ADMIN_ME).expect(200);
    expect(res.body).not.toHaveProperty('passwordHash');
    expect(res.body).not.toHaveProperty('refreshToken');
  });

  it('refuses the wrong password without saying which half was wrong', async () => {
    const res = await anonymous(ctx)
      .post(SURFACES.admin.loginPath)
      .set('Origin', SURFACES.admin.origin)
      .send({ email: ADMIN.email, password: 'not-the-password' })
      .expect(401);
    expect(JSON.stringify(res.body)).not.toMatch(/password is|no such|unknown user/i);
  });

  it('answers an unknown email the same way as a wrong password', async () => {
    // Different answers here are a user-enumeration oracle.
    const unknown = await anonymous(ctx)
      .post(SURFACES.admin.loginPath)
      .set('Origin', SURFACES.admin.origin)
      .send({ email: 'nobody@oxshare.com', password: 'not-the-password' })
      .expect(401);
    const wrongPassword = await anonymous(ctx)
      .post(SURFACES.admin.loginPath)
      .set('Origin', SURFACES.admin.origin)
      .send({ email: ADMIN.email, password: 'not-the-password' })
      .expect(401);
    expect(unknown.body.message).toBe(wrongPassword.body.message);
  });
});

describe('logout', () => {
  it('clears the session so the next request is refused', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    await session.get(ADMIN_ME).expect(200);

    const res = await session.post('/v1/admin/auth/logout').expect(200);

    // The cookie is cleared server-side...
    const after = parseSetCookies(res);
    expect(after[COOKIE_BASES.adminAccess]).toBeUndefined();

    // ...and the credential it held is dead, which is the part that matters.
    // Clearing a cookie only asks the browser to forget; revocation is what
    // stops a copy someone already took.
    await sessionFrom(ctx, 'admin', session.cookies).post('/v1/admin/auth/refresh').expect(401);
  });
});

describe('refresh, over the wire', () => {
  it('rotates the pair and keeps the session usable', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    const res = await session.post('/v1/admin/auth/refresh').expect(200);

    const rotated = parseSetCookies(res);
    expect(rotated[COOKIE_BASES.adminRefresh]).toBeTruthy();
    expect(rotated[COOKIE_BASES.adminRefresh]).not.toBe(session.cookies[COOKIE_BASES.adminRefresh]);

    await sessionFrom(ctx, 'admin', rotated).get(ADMIN_ME).expect(200);
  });

  it('REGRESSION: refuses a refresh token used as an access token', async () => {
    // The whole point of a 15-minute access token, on a surface where both
    // kinds were signed with one secret. See token-audience.ts.
    const session = await actingAs(ctx, 'admin', ADMIN);
    const refreshAsAccess = {
      [COOKIE_BASES.adminAccess]: session.cookies[COOKIE_BASES.adminRefresh],
    };
    await sessionFrom(ctx, 'admin', refreshAsAccess).get(ADMIN_ME).expect(401);
  });

  it('kills the whole family when a rotated token is replayed', async () => {
    /*
     * UPDATED 6 Aug 2026, and the change is the point rather than an
     * accommodation.
     *
     * This used to replay the original token IMMEDIATELY after one rotation and
     * expect the family to die. That state is now read as a RETRY, because it is
     * indistinguishable from one: the successor sits unused, which is exactly
     * what a rotation whose response was lost in transit leaves behind — a
     * dropped connection, a closed tab, a mobile handoff. Answering it by
     * destroying the session and paging somebody was the defect
     * (AUTH-CORRECTNESS B-C1).
     *
     * So the test now establishes the state that genuinely means theft: the
     * legitimate client went on and CONSUMED the replacement, and only then does
     * an older token come back. Nothing about the assertion is weaker — the
     * family must still die, including the token the attacker holds.
     */
    const session = await actingAs(ctx, 'admin', ADMIN);
    const first = await session.post('/v1/admin/auth/refresh').expect(200);
    const rotated = parseSetCookies(first);

    // The legitimate client uses its replacement. From here on, the original
    // token can only be a copy somebody kept.
    const second = await sessionFrom(ctx, 'admin', rotated)
      .post('/v1/admin/auth/refresh')
      .expect(200);
    const current = parseSetCookies(second);

    // Replaying the ORIGINAL refresh token is the signature of a stolen one:
    // either the thief or the victim is presenting a token already spent.
    await session.post('/v1/admin/auth/refresh').expect(401);

    // So the token that legitimately replaced it must die too — otherwise
    // detection is a log line rather than a defence.
    await sessionFrom(ctx, 'admin', current).post('/v1/admin/auth/refresh').expect(401);
  });
});

describe('CSRF, on the assembled stack', () => {
  /*
   * Deliberately NOT /admin/auth/refresh, which is `@NoCsrf` by design — a
   * refresh has to keep working after the CSRF token expires alongside the
   * access token, or a returning user is locked out rather than renewed.
   *
   * Worth recording because the first cut of this file did use it, and all
   * three assertions failed by returning 200. The tests were wrong, not the
   * code. A CSRF test aimed at an exempt route asserts nothing at all, and a
   * green one would have been worse than none.
   */
  const PROTECTED_MUTATION = '/v1/admin/roles';
  const newRole = () => ({ name: `csrf-probe-${Date.now()}`, permissions: ['users.view'] });

  it('refuses a state change with no anti-forgery header', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    await session.post(PROTECTED_MUTATION, newRole(), { omitCsrf: true }).expect(403);
  });

  it('refuses a forged anti-forgery token', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    await session.post(PROTECTED_MUTATION, newRole(), { csrfToken: 'forged.token' }).expect(403);
  });

  it('refuses a state change from an origin we do not serve', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    // Not a suffix match away from allowed: `evil-oxshare.com` is precisely the
    // origin `origin.endsWith('.oxshare.com')` would have admitted.
    await session
      .post(PROTECTED_MUTATION, newRole(), { origin: 'https://evil-oxshare.com' })
      .expect(403);
  });

  it('admits the same state change with cookie, token and origin all present', async () => {
    // The positive half. Without it, the three assertions above would also pass
    // against a route that rejects everything for some unrelated reason.
    const session = await actingAs(ctx, 'admin', ADMIN);
    const res = await session.post(PROTECTED_MUTATION, newRole());
    expect([200, 201]).toContain(res.status);
  });

  it('does not demand a token on a read', async () => {
    // GET carries no ambient authority to abuse, and requiring a token there
    // would push callers into sending one everywhere out of habit.
    const session = await actingAs(ctx, 'admin', ADMIN);
    await session.get(ADMIN_ME).expect(200);
  });
});

describe('the two surfaces are separate sessions (R-3.1)', () => {
  it('an admin cookie does not authenticate a portal route', async () => {
    const admin = await actingAs(ctx, 'admin', ADMIN);
    // Same value, moved into the portal's cookie name — the mistake a shared
    // localhost cookie jar makes easy.
    const asPortal = { [COOKIE_BASES.clientAccess]: admin.cookies[COOKIE_BASES.adminAccess] };
    await sessionFrom(ctx, 'portal', asPortal).get(PORTAL_ME).expect(401);
  });

  it('a portal cookie does not authenticate an admin route', async () => {
    const client = await actingAs(ctx, 'portal', CLIENT);
    const asAdmin = { [COOKIE_BASES.adminAccess]: client.cookies[COOKIE_BASES.clientAccess] };
    await sessionFrom(ctx, 'admin', asAdmin).get(ADMIN_ME).expect(401);
  });

  it('logging out of one surface leaves the other signed in', async () => {
    const admin = await actingAs(ctx, 'admin', ADMIN);
    const client = await actingAs(ctx, 'portal', CLIENT);

    await admin.post('/v1/admin/auth/logout').expect(200);

    await client.get(PORTAL_ME).expect(200);
  });
});

describe('EmailVerifiedGuard', () => {
  it('lets a verified client through', async () => {
    const session = await actingAs(ctx, 'portal', CLIENT);
    const res = await session.get(PORTAL_KYC_STATUS);
    expect(res.status).toBe(200);
  });

  it('holds an unverified client out', async () => {
    const session = await actingAs(ctx, 'portal', UNVERIFIED);
    // 403, not 401: the credential is valid, the account is not yet eligible.
    // A 401 would make the portal treat the session as dead and sign them out
    // of the very screen telling them to check their email.
    await session.get(PORTAL_KYC_STATUS).expect(403);
  });
});

describe('suspension takes effect on the next request', () => {
  it('refuses a live session once the account is suspended', async () => {
    const session = await actingAs(ctx, 'portal', CLIENT);
    await session.get(PORTAL_ME).expect(200);

    await ctx.db.db.update(users).set({ status: 'suspended' }).where(eq(users.email, CLIENT.email));

    // An unexpired token must not outlive the account's standing.
    await session.get(PORTAL_ME).expect(401);

    await ctx.db.db.update(users).set({ status: 'active' }).where(eq(users.email, CLIENT.email));
  });
});
