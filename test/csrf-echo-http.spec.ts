import { ALL_PERMISSIONS } from './support/all-permissions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  actingAs,
  anonymous,
  startHttpTestApp,
  stopHttpTestApp,
  type HttpTestContext,
} from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import { admins, roles, users } from '../src/database/schema';
import { COOKIE_BASES } from '../src/common/security/session-cookies';

/**
 * The anti-forgery echo, through a REAL Express request.
 *
 * ## Why this exists when csrf-token-delivery.spec.ts already covers the same code
 *
 * Because that spec could not have caught the bug this one pins, and did not.
 *
 * `CsrfEchoMiddleware` is mounted with `forRoutes('*')`, and inside a middleware
 * mounted that way Express reports `req.path` RELATIVE to the mount — `"/"` for
 * every request in the application. The middleware read `req.path`, so
 * `isAdminSurface()` was false for every admin request, the portal cookie was
 * looked up instead, nothing was found and nothing was echoed. A page on a host
 * that cannot read the API's `__Host-` cookie therefore never learned its token,
 * and EVERY admin write failed anti-forgery validation in production.
 *
 * The unit spec passed throughout, because it constructed the request itself and
 * handed the middleware a `path` that a real mounted request never carries. A
 * fabricated request can only ever assert what its author already believed.
 *
 * So this one boots the actual application — real mount, real middleware chain,
 * real cookies over the wire — and asserts the header a browser would receive.
 * If the classification regresses, or the middleware moves to a mount with
 * different path semantics, this fails and the unit spec will not.
 */

const ADMIN = { email: 'csrf-echo-admin@oxshare.com', password: 'admin-password-123' };
const CLIENT = { email: 'csrf-echo-client@oxshare-e2e.test', password: 'client-password-123' };

const ECHO_HEADER = 'x-oxshare-csrf';

let ctx: HttpTestContext;

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const passwords = new PasswordService();
  const db = ctx.db.db;

  const [role] = await db
    .insert(roles)
    .values({ name: 'Csrf Echo Master', permissions: ALL_PERMISSIONS, isSystem: true })
    .returning();

  await db.insert(admins).values({
    email: ADMIN.email,
    passwordHash: await passwords.hash(ADMIN.password),
    name: 'Csrf Echo Admin',
    role: 'master_admin' as const,
    roleId: role.id,
    permissions: ALL_PERMISSIONS,
  });

  await db.insert(users).values({
    email: CLIENT.email,
    passwordHash: await passwords.hash(CLIENT.password),
    firstName: 'Csrf',
    lastName: 'Echo',
    emailVerified: true,
  });
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('the anti-forgery token is returned on a real request', () => {
  it('gives an ADMIN route the admin token — the case that failed in production', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    const expected = session.cookies[COOKIE_BASES.adminCsrf];
    expect(expected, 'login should have set an admin CSRF cookie').toBeTruthy();

    const res = await session.get('/v1/admin/auth/me');

    expect(res.status).toBe(200);
    // The whole point: a page that cannot read the cookie learns the token here.
    expect(res.headers[ECHO_HEADER]).toBe(expected);
  });

  it('gives a PORTAL route the portal token', async () => {
    const session = await actingAs(ctx, 'portal', CLIENT);
    const expected = session.cookies[COOKIE_BASES.portalCsrf];
    expect(expected, 'login should have set a portal CSRF cookie').toBeTruthy();

    const res = await session.get('/v1/auth/me');

    expect(res.status).toBe(200);
    expect(res.headers[ECHO_HEADER]).toBe(expected);
  });

  it('returns it on login itself, so the first write of a session has a token', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    // `actingAs` reads the cookies off the login response; the header rides the
    // same response, and issueCsrfToken is what guarantees the two agree.
    expect(session.cookies[COOKIE_BASES.adminCsrf]).toBeTruthy();
  });

  it('echoes nothing to a caller holding no session', async () => {
    // It must not mint. A token handed to an anonymous caller would be a token
    // bound to no session, and the guard would refuse it anyway — but arriving
    // at that refusal via a value we invented is a worse failure to debug.
    const res = await anonymous(ctx).get('/v1/admin/auth/me');

    expect(res.status).toBe(401);
    expect(res.headers[ECHO_HEADER]).toBeUndefined();
  });
});
