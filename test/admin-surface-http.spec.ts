import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { adminIpAllowlist } from '../src/database/schema';

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

  /**
   * The guard half. These run against a real allowlist row, so they prove
   * registration, ordering and live reads at once.
   *
   * Every request here originates from 127.0.0.1 (supertest talks to the
   * in-process server), so a rule covering only 203.0.113.0/24 denies the
   * suite itself — which is exactly the condition worth asserting.
   */
  describe('IpAllowlistGuard is registered and runs before authentication', () => {
    const OFF_LIST = '203.0.113.0/24';

    async function withRule<T>(run: () => Promise<T>): Promise<T> {
      await ctx.db.db.insert(adminIpAllowlist).values({
        cidr: OFF_LIST,
        label: 'admin-surface-http.spec fixture',
        createdBy: '00000000-0000-0000-0000-000000000000',
      });
      try {
        return await run();
      } finally {
        // Torn down inside the spec rather than in afterAll: a rule left behind
        // denies every later admin request in this database, and the failures it
        // causes look like anything but "a test forgot to clean up".
        await ctx.db.db.execute(sql`DELETE FROM admin_ip_allowlist WHERE cidr = ${OFF_LIST}`);
      }
    }

    it('refuses an off-list caller on an admin route', async () => {
      await withRule(async () => {
        const res = await request(ctx.server).get('/v1/admin/clients');
        expect(res.status).toBe(403);
      });
    });

    it('refuses an off-list caller at LOGIN, before any credential is checked', async () => {
      // The strongest property of this guard: an attacker off-list cannot even
      // attempt credential stuffing. A 401 here would mean the allowlist runs
      // after authentication and the login endpoint is exposed regardless.
      await withRule(async () => {
        const res = await request(ctx.server)
          .post('/v1/admin/auth/login')
          .set('Origin', 'http://localhost:3002')
          .send({ email: 'admin@oxshare.com', password: 'admin123' });
        expect(res.status).toBe(403);
      });
    });

    it('leaves the client portal reachable while the admin surface is denied', async () => {
      // The portal is public by nature. An allowlist that leaks onto it locks
      // out the customers the system exists to serve.
      await withRule(async () => {
        const res = await request(ctx.server)
          .post('/v1/auth/login')
          .set('Origin', 'http://localhost:3000')
          .send({ email: 'nobody@example.com', password: 'wrong-password' });
        expect(res.status).not.toBe(403);
      });
    });

    it('takes effect and stops taking effect immediately — the list is not cached', async () => {
      // Multi-instance correctness: a rule removed on one process must not keep
      // denying on another. The guard reads live, and this is what pins that.
      await withRule(async () => {
        const denied = await request(ctx.server).get('/v1/admin/clients');
        expect(denied.status).toBe(403);
      });

      const afterRemoval = await request(ctx.server).get('/v1/admin/clients');
      expect(afterRemoval.status).toBe(401);
    });
  });
});
