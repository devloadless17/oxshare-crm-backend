import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { ALL_PERMISSIONS } from './support/all-permissions';
import { actingAs, startHttpTestApp, stopHttpTestApp, type HttpTestContext } from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import { admins, roles } from '../src/database/schema';

/*
 * D-82 through the real route: `AdminGuard` puts the reader's mask into the
 * request context, the one client search obeys it, and a complete-address
 * lookup of a hidden email is recorded. If the guard ever stopped writing the
 * mask, every search would silently fall back to matching hidden columns —
 * this is the case that would notice.
 */

const MASKED = { email: 'masked-search@oxshare.com', password: 'admin-password-123' };
const EMAIL = 'masked.http.target@example.test';
let ctx: HttpTestContext;

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const db = ctx.db.db;
  const [role] = await db
    .insert(roles)
    .values({ name: 'Email hidden', permissions: ALL_PERMISSIONS, maskedFields: ['client.email'] })
    .returning();
  await db.insert(admins).values({
    email: MASKED.email,
    passwordHash: await new PasswordService().hash(MASKED.password),
    name: 'Masked searcher',
    role: 'sub_admin',
    roleId: role.id,
    permissions: [],
    status: 'active',
  });
  await ctx.db.db.execute(sql`
    INSERT INTO users (email, password_hash, first_name, last_name)
    VALUES (${EMAIL}, 'x', 'Http', 'Target')`);
});

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('a role that hides client emails, through GET /admin/clients', () => {
  it('finds nothing by a fragment of the hidden email', async () => {
    const admin = await actingAs(ctx, 'admin', MASKED);
    const res = await admin.get('/v1/admin/clients?q=masked.http').expect(200);
    expect(res.body.items).toEqual([]);
  });

  it('finds the client by the complete address — and records who looked, not what was typed', async () => {
    const admin = await actingAs(ctx, 'admin', MASKED);
    const res = await admin.get(`/v1/admin/clients?q=${encodeURIComponent(EMAIL)}`).expect(200);
    expect(res.body.items).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toContain(EMAIL); // still masked in the answer

    // Fire-and-forget: give the audit write a moment.
    let rows: { details: Record<string, unknown> }[] = [];
    for (let i = 0; i < 20 && rows.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
      ({ rows } = await ctx.db.db.execute<{ details: Record<string, unknown> }>(sql`
        SELECT a.details FROM audit_log a JOIN users u ON u.id::text = a.subject_id
         WHERE a.action = 'client.lookup_hidden_email' AND u.email = ${EMAIL}`));
    }
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows[0].details)).not.toContain(EMAIL);
  });

  it('refuses to sort by the hidden email', async () => {
    const admin = await actingAs(ctx, 'admin', MASKED);
    await admin.get('/v1/admin/clients?sort=email').expect(400);
  });
});
