import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS } from './support/all-permissions';
import { actingAs, startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import { admins, roles } from '../src/database/schema';

/*
 * Two different 404s, and the consoles must be able to tell them apart:
 * ROUTE_NOT_FOUND — no such endpoint (a frontend ahead of its API) — versus a
 * route's own "not found", which is also what a record outside the reader's
 * territory answers. Rendering both as "endpoint not built yet" told a scoped
 * admin following a link that the feature was missing.
 */

const ADMIN = { email: 'route-404@oxshare.com', password: 'admin-password-123' };
let ctx: HttpTestContext;

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const db = ctx.db.db;
  const [role] = await db
    .insert(roles)
    .values({ name: 'Route 404', permissions: ALL_PERMISSIONS, maskedFields: [] })
    .returning();
  await db.insert(admins).values({
    email: ADMIN.email,
    passwordHash: await new PasswordService().hash(ADMIN.password),
    name: 'Route 404',
    role: 'sub_admin',
    roleId: role.id,
    permissions: [],
    status: 'active',
  });
});

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('a 404 says whether the ROUTE or the RECORD is missing', () => {
  it('an endpoint that does not exist is ROUTE_NOT_FOUND', async () => {
    const admin = await actingAs(ctx, 'admin', ADMIN);
    const res = await admin.get('/v1/admin/no-such-endpoint');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ROUTE_NOT_FOUND');
  });

  it('a record that does not exist is the route’s own not-found, never ROUTE_NOT_FOUND', async () => {
    const admin = await actingAs(ctx, 'admin', ADMIN);
    const res = await admin.get('/v1/admin/clients/999999999');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CLIENT_NOT_FOUND');
  });
});
