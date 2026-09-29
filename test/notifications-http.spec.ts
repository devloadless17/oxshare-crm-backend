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
import { admins, notifications, roles, users } from '../src/database/schema';
import { NotificationsService } from '../src/modules/notifications/notifications.service';

/**
 * The notification endpoints through the real guard chain.
 *
 * The property that matters most here is ISOLATION: the recipient comes from
 * the session and never from a parameter, so client A must not be able to
 * read or mark client B's rows by any means — including guessing ids. The
 * cross-audience case (a client touching an admin's row) is covered by the
 * same WHERE clause and asserted here too.
 */

const ADMIN_A = { email: 'notif-admin-a@oxshare.com', password: 'admin-password-123' };
const ADMIN_B = { email: 'notif-admin-b@oxshare.com', password: 'admin-password-123' };
const CLIENT_A = { email: 'notif-client-a@oxshare-e2e.test', password: 'client-password-123' };
const CLIENT_B = { email: 'notif-client-b@oxshare-e2e.test', password: 'client-password-123' };

let ctx: HttpTestContext;
let clientAId: number;
let clientBId: number;
let adminAId: string;

interface NotificationRow {
  id: string;
  kind: string;
  params: Record<string, unknown>;
  readAt: string | null;
  createdAt: string;
}

const items = (body: unknown) => (body as { items: NotificationRow[] }).items;

async function seedRow(
  recipientKind: 'client' | 'admin',
  recipientId: string | number,
  kind: string,
) {
  const [row] = await ctx.db.db
    .insert(notifications)
    .values({
      recipientKind,
      recipientId: String(recipientId),
      kind,
      params: { amount: '10.00000000' },
      /*
       * An admin row is a TASK and must name its item and client (0140's
       * CHECK). Client A's KYC is the item here — the admin feeds below are
       * read by unrestricted admins, so any real client serves.
       */
      ...(recipientKind === 'admin'
        ? { subjectKind: 'kyc' as const, subjectId: String(clientAId), subjectUserId: clientAId }
        : {}),
    })
    .returning();
  return row.id;
}

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const passwords = new PasswordService();
  const db = ctx.db.db;
  const adminHash = await passwords.hash(ADMIN_A.password);
  const clientHash = await passwords.hash(CLIENT_A.password);

  const [masterRole] = await db
    .insert(roles)
    .values({ name: 'Notif Master', permissions: ALL_PERMISSIONS, isSystem: true })
    .returning();
  const insertedAdmins = await db
    .insert(admins)
    .values(
      [ADMIN_A, ADMIN_B].map((a, i) => ({
        email: a.email,
        passwordHash: adminHash,
        name: `Notif Admin ${i}`,
        role: 'master_admin' as const,
        roleId: masterRole.id,
        permissions: ALL_PERMISSIONS,
      })),
    )
    .returning();
  adminAId = insertedAdmins[0].id;

  const insertedClients = await db
    .insert(users)
    .values(
      [CLIENT_A, CLIENT_B].map((c, i) => ({
        email: c.email,
        passwordHash: clientHash,
        firstName: 'Notif',
        lastName: `Client ${i}`,
        emailVerified: true,
      })),
    )
    .returning();
  clientAId = insertedClients[0].id;
  clientBId = insertedClients[1].id;
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('authentication', () => {
  it('refuses an anonymous caller on every route', async () => {
    expect((await anonymous(ctx).get('/v1/notifications')).status).toBe(401);
    expect((await anonymous(ctx).get('/v1/notifications/unread-count')).status).toBe(401);
    // 403, not 401: the CSRF guard refuses an originless state change before
    // authentication is even consulted. Refused either way is the property.
    expect((await anonymous(ctx).post('/v1/notifications/read-all')).status).toBe(403);
    expect((await anonymous(ctx).get('/v1/admin/notifications')).status).toBe(401);
  });
});

describe('the client feed', () => {
  it('serves only the caller’s own rows, and the unread count round-trips', async () => {
    await seedRow('client', clientAId, 'kyc.approved');
    await seedRow('client', clientBId, 'kyc.rejected');

    const session = await actingAs(ctx, 'portal', CLIENT_A);
    const list = await session.get('/v1/notifications');
    expect(list.status).toBe(200);
    expect(items(list.body).map((n) => n.kind)).toContain('kyc.approved');
    expect(items(list.body).map((n) => n.kind)).not.toContain('kyc.rejected');

    const count = await session.get('/v1/notifications/unread-count');
    expect(count.status).toBe(200);
    expect((count.body as { count: number }).count).toBeGreaterThanOrEqual(1);
  });

  it("refuses to mark another client's row — as NOT FOUND, not forbidden", async () => {
    const foreignId = await seedRow('client', clientBId, 'wallet.credited');
    const session = await actingAs(ctx, 'portal', CLIENT_A);

    const res = await session.post(`/v1/notifications/${foreignId}/read`, {});
    // 404, deliberately: "exists but not yours" is an oracle for enumerating
    // other people's notification ids.
    expect(res.status).toBe(404);
  });

  it("cannot touch an ADMIN's row even with its real id", async () => {
    const adminRowId = await seedRow('admin', adminAId, 'admin.kyc.submitted');
    const session = await actingAs(ctx, 'portal', CLIENT_A);
    expect((await session.post(`/v1/notifications/${adminRowId}/read`, {})).status).toBe(404);
  });

  it('mark one read, then read-all, both idempotent', async () => {
    const id = await seedRow('client', clientAId, 'deposit.succeeded');
    const session = await actingAs(ctx, 'portal', CLIENT_A);

    const first = await session.post(`/v1/notifications/${id}/read`, {});
    expect(first.status).toBe(200);
    expect((first.body as NotificationRow).readAt).not.toBeNull();
    // Same call again: same answer, no error.
    expect((await session.post(`/v1/notifications/${id}/read`, {})).status).toBe(200);

    const all = await session.post('/v1/notifications/read-all', {});
    expect(all.status).toBe(200);
    const again = await session.post('/v1/notifications/read-all', {});
    expect((again.body as { updated: number }).updated).toBe(0);

    const count = await session.get('/v1/notifications/unread-count');
    expect((count.body as { count: number }).count).toBe(0);
  });
});

describe('the admin feed', () => {
  it('serves only the signed-in admin’s rows', async () => {
    await seedRow('admin', adminAId, 'admin.withdrawal.requested');

    const a = await actingAs(ctx, 'admin', ADMIN_A);
    const listA = await a.get('/v1/admin/notifications');
    expect(listA.status).toBe(200);
    expect(items(listA.body).map((n) => n.kind)).toContain('admin.withdrawal.requested');

    const b = await actingAs(ctx, 'admin', ADMIN_B);
    const listB = await b.get('/v1/admin/notifications');
    expect(listB.status).toBe(200);
    expect(items(listB.body).map((n) => n.kind)).not.toContain('admin.withdrawal.requested');
  });

  it('paginates with a cursor, and the inbox holds only what is still waiting', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN_A);
    for (let i = 0; i < 3; i++) await seedRow('admin', adminAId, 'admin.kyc.submitted');

    const first = await session.get('/v1/admin/notifications?limit=2');
    expect(items(first.body)).toHaveLength(2);
    const nextCursor = (first.body as { nextCursor: string | null }).nextCursor;
    expect(nextCursor).not.toBeNull();

    const second = await session.get(
      `/v1/admin/notifications?limit=2&cursor=${encodeURIComponent(nextCursor as string)}`,
    );
    expect(second.status).toBe(200);
    const firstIds = new Set(items(first.body).map((n) => n.id));
    for (const row of items(second.body)) expect(firstIds.has(row.id)).toBe(false);

    const inbox = await session.get('/v1/admin/notifications?view=inbox');
    expect(inbox.status).toBe(200);
    expect(items(inbox.body).every((n) => n.readAt === null)).toBe(true);
  });

  it('refuses a query parameter it does not know — the retired `unread` filter included', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN_A);
    expect((await session.get('/v1/admin/notifications?unread=true')).status).toBe(400);
  });

  it('shows no kind outside the catalogue, whatever is in the table', async () => {
    // A row of a retired kind — what the migration deleted, written again by
    // hand. The feed admits only catalogue kinds the reader can act on.
    await seedRow('admin', adminAId, 'admin.client.registered');
    const session = await actingAs(ctx, 'admin', ADMIN_A);
    const list = await session.get('/v1/admin/notifications?limit=100');
    expect(items(list.body).map((n) => n.kind)).not.toContain('admin.client.registered');
  });
});

describe('the dispatch port through the real module graph', () => {
  it('resolves NotificationsService and lands a client row end to end', async () => {
    const service = ctx.app.get(NotificationsService);
    await service.notify({
      recipient: { kind: 'client', id: clientAId },
      kind: 'e2e.port.check',
      params: { amount: '1.00000000', currency: 'USD' },
    });

    const session = await actingAs(ctx, 'portal', CLIENT_A);
    const list = await session.get('/v1/notifications');
    expect(items(list.body).map((n) => n.kind)).toContain('e2e.port.check');
  });
});
