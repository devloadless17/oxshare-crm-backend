import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';

/**
 * The ADMIN SURFACE as assembled — who reaches it, and by which spellings.
 *
 * WHY THIS FILE EXISTS. RBAC-08 shipped marked complete with 249 lines of unit
 * tests and one uncovered fact: nothing asserted the guard was REGISTERED.
 * `ip-allowlist.spec.ts` constructs `new IpAllowlistGuard(store)` by hand, so
 * deleting the `APP_GUARD` provider from `admin.module.ts` broke zero tests and
 * turned the feature off silently. Every guard in this system is only as real
 * as its wiring, and wiring is not visible from a unit test by construction.
 *
 * THE BUG THAT PROMPTED IT. Express matches routes case-insensitively while
 * `req.path` preserves the caller's casing, so `GET /v1/Admin/clients` reached
 * the admin controller and returned 200 while both `IpAllowlistGuard` and the
 * admin branch of `CsrfGuard` decided their surface with a case-sensitive
 * `startsWith('/admin')` and concluded this was not an admin request. Session
 * cookies are `path: '/'`, so authentication still succeeded. One uppercase
 * letter returned the full admin surface from a denied network.
 *
 * These assertions are therefore about the ASSEMBLY — the router, the global
 * guards and their order — and are deliberately not expressible against a
 * hand-built ExecutionContext.
 */
describe('admin surface (HTTP)', () => {
  let ctx: HttpTestContext;

  beforeAll(async () => {
    ctx = await startHttpTestApp();
  }, 180_000);

  afterAll(async () => {
    await stopHttpTestApp(ctx);
  });

  /**
   * The router half of the fix: `applyApiPrefix` turns on case-sensitive
   * routing, so a case-varied path is not a route at all and never reaches a
   * guard to be mis-classified.
   */
  describe('case-varied paths are not routes', () => {
    it.each([
      '/V1/ADMIN/clients',
      '/v1/Admin/clients',
      '/v1/ADMIN/auth/login',
      '/V1/admin/clients',
    ])('404s %s instead of serving it', async (path) => {
      const res = await request(ctx.server).get(path);
      expect(res.status).toBe(404);
    });

    it('still serves the canonical spelling', async () => {
      // The control. Without it, "everything 404s" would pass the block above
      // while meaning the app is simply broken.
      const res = await request(ctx.server).get('/v1/admin/clients');
      // 401/403 — unauthenticated, which is the point: it is a real route.
      expect(res.status).not.toBe(404);
      expect([401, 403]).toContain(res.status);
    });

    it('leaves the unversioned health probe reachable', async () => {
      const res = await request(ctx.server).get('/health');
      expect(res.status).toBe(200);
    });
  });
  /*
   * RBAC-08's assembly — the guard registered, running before authentication,
   * the sign-in doors agreeing with it, exempt administrators (0192) — is
   * proved over HTTP in `ip-allowlist-exemptions-http.spec.ts`.
   */
});
