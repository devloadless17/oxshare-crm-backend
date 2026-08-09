import { ALL_PERMISSIONS } from './support/all-permissions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JwtService } from '@nestjs/jwt';
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
import { adminClientTagScopes, admins, clientTags, roles, users } from '../src/database/schema';
import { COOKIE_BASES } from '../src/common/security/session-cookies';
import { TOKEN_AUDIENCE, TOKEN_ISSUER, TOKEN_KIND } from '../src/common/security/token-audience';

/**
 * The auth-correctness regressions — `docs/AUTH-CORRECTNESS-oxshare-crm-backend.md`.
 *
 * Every test here fails on the code as it stood on 6 Aug 2026 and passes with
 * the fix beside it. They run over HTTP through the assembled chain, because
 * four of these defects lived in the seam between a guard, a service and a
 * cookie, and every one of them passed the unit suite it sat next to.
 *
 * The rotation tests present the SAME refresh token twice on purpose. That is
 * not an artificial condition: two browser tabs share one cookie jar, so it is
 * what a laptop waking with two tabs open actually does.
 */

const ADMIN = { email: 'sc-admin@oxshare.com', password: 'admin-password-123' };
const CLIENT = { email: 'sc-client@oxshare.com', password: 'client-password-123' };

const ADMIN_ME = '/v1/admin/auth/me';
const ADMIN_REFRESH = '/v1/admin/auth/refresh';
const ADMIN_LOGOUT = '/v1/admin/auth/logout';
const PORTAL_REFRESH = '/v1/auth/refresh';
const PORTAL_LOGOUT = '/v1/auth/logout';

let ctx: HttpTestContext;
let adminId: string;

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
      name: 'SC Master Admin',
      description: 'Full access.',
      permissions: ALL_PERMISSIONS,
      isSystem: true,
    })
    .returning();

  const [row] = await ctx.db.db
    .insert(admins)
    .values({
      email: ADMIN.email,
      passwordHash: adminHash,
      name: 'Session Correctness Admin',
      role: 'master_admin',
      roleId: masterRole.id,
      permissions: ALL_PERMISSIONS,
    })
    .returning();
  adminId = row.id;

  await ctx.db.db.insert(users).values({
    email: CLIENT.email,
    passwordHash: clientHash,
    firstName: 'Session',
    lastName: 'Correctness',
    type: 'individual',
    status: 'active',
    emailVerified: true,
  });
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

/** Signs an admin ACCESS token directly, to reach states a login cannot produce. */
function signAdminAccess(
  claims: { sub: string; role: string; fam?: string },
  /*
   * A literal, not `string`. `JwtSignOptions.expiresIn` is a template-literal
   * type from `ms`, so a widened `string` fails EVERY overload of `sign()` — and
   * the error TypeScript prints names the payload rather than this, which sends
   * you looking in the wrong place.
   */
  expiresIn: '15m' | '-5s' | '-10m',
): string {
  // Assigned to a variable first: `sign()`'s object overload does not accept an
  // inline literal built with a spread, which is why token-kind.spec.ts does the
  // same thing.
  const payload: Record<string, unknown> = { typ: TOKEN_KIND.access, ...claims };
  return new JwtService({}).sign(payload, {
    secret: process.env['ADMIN_JWT_SECRET'] as string,
    audience: TOKEN_AUDIENCE.admin,
    issuer: TOKEN_ISSUER,
    expiresIn,
  });
}

const adminOrigin = () => SURFACES.admin.origin;
const portalOrigin = () => SURFACES.portal.origin;

describe('B-C6 — a 401 says WHY, so a client can tell renew from sign-out', () => {
  /*
   * The root cause behind three frontend defects. Every authentication failure
   * arrived as `UNAUTHENTICATED`, so a client could not distinguish "your
   * fifteen-minute token lapsed, renew" from "this session is over, sign in" —
   * and had to guess. Both frontends guessed, and both guessed wrong somewhere.
   */

  it('answers SESSION_REVOKED when no refresh cookie is presented', async () => {
    const res = await anonymous(ctx).post(ADMIN_REFRESH).set('Origin', adminOrigin()).expect(401);

    expect(res.body.code).toBe('SESSION_REVOKED');
  });

  it('answers TOKEN_EXPIRED for a merely stale access token', async () => {
    // The distinction that matters most: this means RENEW. Rendering it as "you
    // were signed out" is precisely the defect the console carried.
    const expired = signAdminAccess(
      { sub: adminId, role: 'master_admin', fam: '00000000-0000-4000-8000-000000000000' },
      // Well past both the expiry and the 30-second tolerance.
      '-10m',
    );

    const res = await anonymous(ctx)
      .get(ADMIN_ME)
      .set('Cookie', `${COOKIE_BASES.adminAccess}=${expired}`)
      .expect(401);

    expect(res.body.code).toBe('TOKEN_EXPIRED');
  });

  it('answers SESSION_REVOKED for a token that is malformed rather than expired', async () => {
    const res = await anonymous(ctx)
      .get(ADMIN_ME)
      .set('Cookie', `${COOKIE_BASES.adminAccess}=not-a-jwt-at-all`)
      .expect(401);

    expect(res.body.code).toBe('SESSION_REVOKED');
  });
});

describe('B-C1 / B-C2 — a retried or raced refresh does not destroy the session', () => {
  it('rotates the unused successor when a refresh is retried', async () => {
    /*
     * The lost-response case: the server rotated, the reply never reached the
     * browser, and the client retried with the only token it still has. That was
     * answered by revoking every token in the family AND raising a
     * credential-theft alert that pages somebody.
     *
     * What separates it from theft is that the SUCCESSOR WAS NEVER USED —
     * nobody received it. That is exactly the state here.
     */
    const session = await actingAs(ctx, 'admin', ADMIN);
    const rt = session.cookies[COOKIE_BASES.adminRefresh];
    expect(rt, 'no refresh cookie was issued — this test would prove nothing').toBeDefined();

    // Rotation #1. Its response is discarded, standing in for a reply that never
    // arrived.
    await anonymous(ctx)
      .post(ADMIN_REFRESH)
      .set('Origin', adminOrigin())
      .set('Cookie', `${COOKIE_BASES.adminRefresh}=${rt}`)
      .expect(200);

    // The retry, with the same now-consumed token.
    const retry = await anonymous(ctx)
      .post(ADMIN_REFRESH)
      .set('Origin', adminOrigin())
      .set('Cookie', `${COOKIE_BASES.adminRefresh}=${rt}`);

    expect(retry.status, 'a retried refresh was treated as theft').toBe(200);

    // And the session handed back genuinely works, rather than merely answering 200.
    const rotated = sessionFrom(ctx, 'admin', parseSetCookies(retry));
    const me = await rotated.get(ADMIN_ME).expect(200);
    expect(me.body.email).toBe(ADMIN.email);
  });

  it('never answers SESSION_REVOKED to a caller whose session is alive', async () => {
    /*
     * Two tabs. The loser used to be told "Session has been revoked", so it
     * hard-navigated to the sign-in screen while holding a valid thirty-day
     * session.
     *
     * TWO requests, which is what two tabs actually produce — they hold one
     * cookie between them, so the second presents what the first just consumed.
     * A third would be a different thing: by then the chain has genuinely moved
     * on, and reuse detection firing is correct rather than a regression (the
     * next test pins that).
     *
     * The property asserted is the one the frontend depends on: the loser is
     * never told SESSION_REVOKED, which is the code that made it sign a live
     * session out.
     */
    const session = await actingAs(ctx, 'admin', ADMIN);
    const rt = session.cookies[COOKIE_BASES.adminRefresh];

    for (let round = 0; round < 2; round++) {
      const res = await anonymous(ctx)
        .post(ADMIN_REFRESH)
        .set('Origin', adminOrigin())
        .set('Cookie', `${COOKIE_BASES.adminRefresh}=${rt}`);

      if (res.status !== 200) {
        expect(res.status).toBe(401);
        expect(res.body.code, `round ${round}: a live session was reported as revoked`).not.toBe(
          'SESSION_REVOKED',
        );
      }
    }
  });

  it('still destroys the family when a token is replayed after the successor was used', async () => {
    /*
     * The other half, and the one that must NOT regress: the grace window is
     * narrowed by the successor test, not by time alone.
     *
     * Here the successor IS used — a legitimate client carried on — so replaying
     * the predecessor is theft, and reuse detection must fire exactly as before.
     */
    const session = await actingAs(ctx, 'admin', ADMIN);
    const first = session.cookies[COOKIE_BASES.adminRefresh];

    const second = await anonymous(ctx)
      .post(ADMIN_REFRESH)
      .set('Origin', adminOrigin())
      .set('Cookie', `${COOKIE_BASES.adminRefresh}=${first}`)
      .expect(200);
    const secondRt = parseSetCookies(second)[COOKIE_BASES.adminRefresh];

    // The legitimate client uses its replacement — so the successor is consumed.
    await anonymous(ctx)
      .post(ADMIN_REFRESH)
      .set('Origin', adminOrigin())
      .set('Cookie', `${COOKIE_BASES.adminRefresh}=${secondRt}`)
      .expect(200);

    // Now the ORIGINAL token comes back. This is the theft signature.
    const replay = await anonymous(ctx)
      .post(ADMIN_REFRESH)
      .set('Origin', adminOrigin())
      .set('Cookie', `${COOKIE_BASES.adminRefresh}=${first}`)
      .expect(401);

    expect(replay.body.code).toBe('SESSION_REPLAYED');

    // And the whole family is dead, including the token the attacker would hold.
    await anonymous(ctx)
      .post(ADMIN_REFRESH)
      .set('Origin', adminOrigin())
      .set('Cookie', `${COOKIE_BASES.adminRefresh}=${secondRt}`)
      .expect(401);
  });
});

describe('B-C3 — revoking an admin session reaches the access token', () => {
  it('stops honouring a live access token once the session is ended elsewhere', async () => {
    /*
     * The parity gap. The portal has carried the `fam` claim since 6 Aug; the
     * admin surface did not, so "sign out that device" left the other browser
     * fully working for up to fifteen minutes — on the console that approves
     * payouts. DECISIONS D-44 records this as closed; it was closed on one
     * surface only.
     */
    const first = await actingAs(ctx, 'admin', ADMIN);
    const second = await actingAs(ctx, 'admin', ADMIN);

    await first.get(ADMIN_ME).expect(200);

    await second.post(ADMIN_LOGOUT).expect(200);

    const after = await first.get(ADMIN_ME);
    expect(after.status, 'a revoked admin session kept authenticating').toBe(401);
    expect(after.body.code).toBe('SESSION_REVOKED');
  });

  it('refuses an access token that names no login at all', async () => {
    // Tokens minted before `fam` existed cannot be checked against a family, so
    // they are refused rather than trusted — otherwise the control would not
    // exist for exactly the sessions issued before it shipped.
    const noFam = signAdminAccess({ sub: adminId, role: 'master_admin' }, '15m');

    const res = await anonymous(ctx)
      .get(ADMIN_ME)
      .set('Cookie', `${COOKIE_BASES.adminAccess}=${noFam}`)
      .expect(401);

    expect(res.body.code).toBe('SESSION_REVOKED');
  });
});

describe('B-C4 — a suspended admin cannot refresh', () => {
  it('refuses to rotate, and revokes what is left', async () => {
    /*
     * The portal has checked this on refresh since it was written; the admin
     * surface did not — so suspending an administrator stopped them at the guard
     * and then handed them a fresh fifteen-minute token every time they
     * refreshed, for thirty days.
     */
    const passwords = new PasswordService();
    const [victim] = await ctx.db.db
      .insert(admins)
      .values({
        email: 'sc-suspended@oxshare.com',
        passwordHash: await passwords.hash('admin-password-123'),
        name: 'Suspended Admin',
        role: 'master_admin',
        permissions: ALL_PERMISSIONS,
      })
      .returning();

    const session = await actingAs(ctx, 'admin', {
      email: 'sc-suspended@oxshare.com',
      password: 'admin-password-123',
    });
    const rt = session.cookies[COOKIE_BASES.adminRefresh];

    const { eq } = await import('drizzle-orm');
    await ctx.db.db.update(admins).set({ status: 'suspended' }).where(eq(admins.id, victim.id));

    const res = await anonymous(ctx)
      .post(ADMIN_REFRESH)
      .set('Origin', adminOrigin())
      .set('Cookie', `${COOKIE_BASES.adminRefresh}=${rt}`)
      .expect(401);

    expect(res.body.code).toBe('SESSION_REVOKED');
  });
});

describe('B-C5 — logout works when the access token has already expired', () => {
  it('signs an admin out on nothing but the refresh cookie', async () => {
    /*
     * The path a person hits: a laptop sleeps past fifteen minutes so the
     * proactive timer never ran, and the first thing they do on waking is click
     * Log out. Behind the guard that answered 401 and cleared no cookies — they
     * were still signed in, on the machine they were walking away from.
     */
    const session = await actingAs(ctx, 'admin', ADMIN);
    const rt = session.cookies[COOKIE_BASES.adminRefresh];

    const res = await anonymous(ctx)
      .post(ADMIN_LOGOUT)
      .set('Origin', adminOrigin())
      // The refresh cookie ONLY — the access cookie is gone, as it would be.
      .set('Cookie', `${COOKIE_BASES.adminRefresh}=${rt}`)
      .expect(200);

    // Asserted on the RAW header: `parseSetCookies` deliberately records a
    // cleared cookie as absent, so it cannot express "this was actively removed"
    // as distinct from "was never set".
    const raw = res.headers['set-cookie'] as unknown as string[];
    expect(
      raw.some((c) => c.startsWith(`${COOKIE_BASES.adminRefresh}=;`)),
      'logout did not clear the refresh cookie',
    ).toBe(true);

    // Dead server-side, not merely forgotten by the browser.
    await anonymous(ctx)
      .post(ADMIN_REFRESH)
      .set('Origin', adminOrigin())
      .set('Cookie', `${COOKIE_BASES.adminRefresh}=${rt}`)
      .expect(401);
  });

  it('clears cookies even for a caller it cannot identify', async () => {
    // Clearing a cookie is not a privileged act. Refusing to do it for someone
    // whose credential is already worthless only leaves rubbish in their browser.
    const res = await anonymous(ctx)
      .post(ADMIN_LOGOUT)
      .set('Origin', adminOrigin())
      .set('Cookie', `${COOKIE_BASES.adminRefresh}=complete-nonsense`)
      .expect(200);

    const raw = res.headers['set-cookie'] as unknown as string[];
    expect(raw.some((c) => c.startsWith(`${COOKIE_BASES.adminRefresh}=;`))).toBe(true);
  });

  it('does the same on the portal', async () => {
    const session = await actingAs(ctx, 'portal', CLIENT);
    const rt = session.cookies[COOKIE_BASES.clientRefresh];

    await anonymous(ctx)
      .post(PORTAL_LOGOUT)
      .set('Origin', portalOrigin())
      .set('Cookie', `${COOKIE_BASES.clientRefresh}=${rt}`)
      .expect(200);

    await anonymous(ctx)
      .post(PORTAL_REFRESH)
      .set('Origin', portalOrigin())
      .set('Cookie', `${COOKIE_BASES.clientRefresh}=${rt}`)
      .expect(401);
  });

  it('cannot be used to sign somebody else out', async () => {
    /*
     * The property that makes removing the guard safe: identity comes from a
     * FULLY VERIFIED refresh token. If this ever regresses to decoding without
     * verifying, anyone could end anyone's sessions by writing a cookie.
     */
    const victim = await actingAs(ctx, 'admin', ADMIN);

    const forged = new JwtService({}).sign(
      { sub: adminId, jti: 'made-up', typ: TOKEN_KIND.refresh },
      { secret: 'a-completely-different-secret-that-is-long-enough', expiresIn: '30d' },
    );

    await anonymous(ctx)
      .post(ADMIN_LOGOUT)
      .set('Origin', adminOrigin())
      .set('Cookie', `${COOKIE_BASES.adminRefresh}=${forged}`)
      .expect(200);

    await victim.get(ADMIN_ME).expect(200);
  });

  it('is still refused from another origin', async () => {
    // Removing the auth guard did not remove the origin check: `@NoCsrf` waives
    // the anti-forgery token, not the Origin comparison. Without this, a
    // cross-site page could sign an operator out at will.
    const session = await actingAs(ctx, 'admin', ADMIN);

    await anonymous(ctx)
      .post(ADMIN_LOGOUT)
      .set('Origin', 'https://evil.example')
      .set('Cookie', session.cookieHeader())
      .expect(403);
  });
});

describe('B-C10 — a few seconds of clock skew is not a dead session', () => {
  it('gets a barely-expired token past the expiry check', async () => {
    /*
     * There was no leeway at any of the six verification sites. With a
     * fifteen-minute access token, seconds of drift between replicas produce
     * intermittent 401s that reproduce for nobody.
     *
     * Five seconds past expiry, against a thirty-second tolerance. It must fail
     * on the FAMILY check instead — a different code — which proves it got past
     * the expiry one.
     */
    const barelyExpired = signAdminAccess(
      { sub: adminId, role: 'master_admin', fam: '00000000-0000-4000-8000-000000000000' },
      '-5s',
    );

    const res = await anonymous(ctx)
      .get(ADMIN_ME)
      .set('Cookie', `${COOKIE_BASES.adminAccess}=${barelyExpired}`)
      .expect(401);

    expect(res.body.code, 'the tolerance did not apply — this read as expired').toBe(
      'SESSION_REVOKED',
    );
  });
});

describe('B-C7 — a declared permission is actually enforced', () => {
  it('refuses a sub-admin the platform download links', async () => {
    /*
     * `@RequirePermissions('settings.edit')` was paired with
     * `@UseGuards(AdminGuard)`, and only `PermissionsGuard` reads
     * `PERMISSIONS_KEY` — so the decorator was decoration. Any authenticated
     * admin could rewrite the executable download URL handed to every client.
     *
     * It looked right in review, and `route-authorization.spec.ts` passed,
     * because that asserts a permission was DECLARED rather than that anything
     * reads it. There is now a second assertion there for the same class.
     */
    const passwords = new PasswordService();
    await ctx.db.db.insert(admins).values({
      email: 'sc-restricted@oxshare.com',
      passwordHash: await passwords.hash('admin-password-123'),
      name: 'Restricted',
      role: 'sub_admin',
      permissions: ['kyc.review'],
    });

    const restricted = await actingAs(ctx, 'admin', {
      email: 'sc-restricted@oxshare.com',
      password: 'admin-password-123',
    });

    await restricted.get('/v1/admin/platforms').expect(403);
    await restricted
      .put('/v1/admin/platforms/mt5-windows', { url: 'https://example.test/x.exe' })
      .expect(403);
  });

  it('still admits an admin who holds it', async () => {
    // The other half: the fix must not have made the route unreachable.
    const master = await actingAs(ctx, 'admin', ADMIN);
    await master.get('/v1/admin/platforms').expect(200);
  });
});

describe('B-C8 — an invite carries the territory and mask it was sent with', () => {
  it('applies scoped tags and masked fields on acceptance', async () => {
    /*
     * Both columns existed on `admin_invites` and were written by nothing and
     * read by nothing. An EMPTY scope means unrestricted, so every newly
     * accepted sub-admin could see every client in the system between clicking
     * the emailed link and somebody remembering to configure them — the window
     * `schema.ts` describes in words, open in practice.
     */
    const master = await actingAs(ctx, 'admin', ADMIN);

    const [tag] = await ctx.db.db
      .insert(clientTags)
      .values({ slug: 'sc-territory', label: 'SC Territory' })
      .returning();

    const invited = await master
      .post('/v1/admin/invite', {
        email: 'sc-invitee@oxshare.com',
        name: 'Invitee',
        permissions: ['clients.view'],
        maskedFields: ['client.email'],
        scopedTagIds: [tag.id],
      })
      .expect(201);

    const url: string = invited.body.inviteUrl;
    const token = new URL(url).searchParams.get('token');
    expect(token, 'no invite token was returned outside production').toBeTruthy();

    await anonymous(ctx)
      .post('/v1/admin/invite/accept')
      .set('Origin', adminOrigin())
      .send({ token, password: 'invitee-password-123' })
      .expect(200);

    const { eq } = await import('drizzle-orm');
    const [created] = await ctx.db.db
      .select()
      .from(admins)
      .where(eq(admins.email, 'sc-invitee@oxshare.com'));

    expect(created.maskedFields, 'the invite mask was discarded').toEqual(['client.email']);

    const [scope] = await ctx.db.db
      .select()
      .from(adminClientTagScopes)
      .where(eq(adminClientTagScopes.adminId, created.id));

    expect(scope, 'the invited admin landed unrestricted — the window is still open').toBeDefined();
    expect(scope.tagId).toBe(tag.id);
  });
});
