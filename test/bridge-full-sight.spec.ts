import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS } from './support/all-permissions';
import { actingAs, startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import { adminClientTagScopes, admins, clientTags, roles } from '../src/database/schema';

/*
 * The bridge pages relay the MT5 bridge's own queues and log text, which name
 * every client's logins and amounts and cannot be filtered by territory. So a
 * territory-scoped admin is refused them outright (R3), whatever their
 * permissions — the same stance as reconciliation.
 */

const FULL = { email: 'bridge-full@oxshare.com', password: 'admin-password-123' };
const SCOPED = { email: 'bridge-scoped@oxshare.com', password: 'admin-password-123' };
const ROUTES = ['outbox', 'operations', 'logs'].map((r) => `/v1/admin/bridge/${r}`);

let ctx: HttpTestContext;

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const db = ctx.db.db;
  const passwords = new PasswordService();
  const [role] = await db
    .insert(roles)
    .values({ name: 'Bridge readers', permissions: ALL_PERMISSIONS, maskedFields: [] })
    .returning();
  const [tag] = await db
    .insert(clientTags)
    .values({ slug: 'bridge-desk', label: 'Desk' })
    .returning();
  for (const who of [FULL, SCOPED]) {
    const scoped = who === SCOPED;
    const [row] = await db
      .insert(admins)
      .values({
        email: who.email,
        passwordHash: await passwords.hash(who.password),
        name: who.email,
        role: 'sub_admin',
        roleId: role.id,
        permissions: [],
        seesAllClients: !scoped,
        seesUntriaged: true,
        status: 'active',
      })
      .returning();
    if (scoped) {
      await db
        .insert(adminClientTagScopes)
        .values({ adminId: row.id, tagId: tag.id, createdBy: row.id });
    }
  }
});

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('/admin/bridge/* needs sight of all clients', () => {
  it('refuses a territory-scoped admin on every route, even holding every permission', async () => {
    const scoped = await actingAs(ctx, 'admin', SCOPED);
    for (const route of ROUTES) {
      const res = await scoped.get(route);
      expect(res.status, route).toBe(403);
      expect(JSON.stringify(res.body)).toMatch(/sight of all clients/);
    }
  });

  it('is not refused to an admin who sees all clients', async () => {
    const full = await actingAs(ctx, 'admin', FULL);
    // The bridge itself may be unreachable in a test run; what matters is that
    // THIS gate lets the request through.
    for (const route of ROUTES) expect((await full.get(route)).status, route).not.toBe(403);
  });
});
