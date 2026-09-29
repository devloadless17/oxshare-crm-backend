import { ALL_PERMISSIONS } from './support/all-permissions';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import {
  actingAs,
  startHttpTestApp,
  stopHttpTestApp,
  type HttpTestContext,
  type Session,
} from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import { admins, auditLog, refreshTokens, roles, users } from '../src/database/schema';

/**
 * Suspending a CLIENT, over HTTP, through the real chain.
 *
 * The deliberate sibling of `admin-suspension-http.spec.ts`, which proves the
 * same property one surface over. It exists because the two surfaces had drifted
 * apart and nothing noticed: `AdminRbacService.setAdminStatus` has revoked the
 * refresh families since it was written, and `AdminClientsService.setClientStatus`
 * did not — while THREE comments said it did.
 *
 *   - `admin-clients.service.ts`, above the permission check:
 *     "Suspension kills live sessions and blocks login — a real privilege."
 *   - `auth.service.ts`, on the refresh path:
 *     "Belt and braces: suspension also revokes every family."
 *
 * Both described behaviour that no code performed. The status check alone is
 * necessary and not sufficient, for exactly the reason the admin path spells
 * out: it reads `users.status`, so the moment somebody REACTIVATES the account
 * the old cookies work again and a session nobody signed in resumes on its own.
 *
 * That is the case this file exercises, and it is the one a status-only test
 * cannot see — a suspended client is refused either way. Only the round trip
 * through suspend → reactivate tells the two implementations apart.
 */

const MASTER = { email: 'suspend-master@oxshare.com', password: 'admin-password-123' };
const CLIENT = { email: 'suspend-target@oxshare-e2e.test', password: 'client-password-123' };

const PORTAL_ME = '/v1/auth/me';
const PORTAL_REFRESH = '/v1/auth/refresh';

let ctx: HttpTestContext;
let master: Session;
let clientId: number;

const liveTokens = async () =>
  (
    await ctx.db.db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.subjectId, String(clientId)))
  ).filter((t) => t.revokedAt === null);

const setStatus = (status: 'active' | 'suspended') =>
  master.patch(`/v1/admin/clients/${clientId}/status`, { status });

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const passwords = new PasswordService();

  const [masterRole] = await ctx.db.db
    .insert(roles)
    .values({ name: 'Suspend Master', permissions: ALL_PERMISSIONS, isSystem: true })
    .returning();

  await ctx.db.db.insert(admins).values({
    email: MASTER.email,
    passwordHash: await passwords.hash(MASTER.password),
    name: 'Suspend Master',
    role: 'master_admin',
    roleId: masterRole.id,
    permissions: ALL_PERMISSIONS,
    status: 'active',
  });

  const [client] = await ctx.db.db
    .insert(users)
    .values({
      email: CLIENT.email,
      passwordHash: await passwords.hash(CLIENT.password),
      firstName: 'Nadia',
      lastName: 'Khoury',
      emailVerified: true,
      country: 'Lebanon',
    })
    .returning();
  clientId = client.id;

  master = await actingAs(ctx, 'admin', MASTER);
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

beforeEach(async () => {
  await ctx.db.db.update(users).set({ status: 'active' }).where(eq(users.id, clientId));
  /*
   * The CLIENT's tokens only — a blanket delete would also end the admin
   * session `beforeAll` signed in with, and every later request would arrive
   * unauthenticated. `audit_log` is not cleared: the append-only trigger
   * refuses DELETE, so assertions filter by subject instead.
   */
  await ctx.db.db.delete(refreshTokens).where(eq(refreshTokens.subjectId, String(clientId)));
});

describe('suspending a client reaches their live session', () => {
  it('refuses an already-authenticated client on their very next request', async () => {
    const client = await actingAs(ctx, 'portal', CLIENT);
    await client.get(PORTAL_ME).expect(200);

    await setStatus('suspended').expect(200);

    await client.get(PORTAL_ME).expect(401);
  });

  it('REVOKES the refresh families — reactivation does not resurrect the session', async () => {
    /*
     * The load-bearing case. Without the revoke this passes its first half and
     * fails here: the account is active again, the family was never ended, so
     * the pre-suspension cookie refreshes and a session nobody signed in comes
     * back to life.
     */
    const client = await actingAs(ctx, 'portal', CLIENT);
    expect((await liveTokens()).length).toBeGreaterThan(0);

    await setStatus('suspended').expect(200);
    await setStatus('active').expect(200);

    // The ACCOUNT is back; the old session is not.
    expect(await liveTokens()).toEqual([]);
    await client.post(PORTAL_REFRESH).expect(401);

    // And a fresh sign-in works — the account itself is healthy, which is what
    // separates "we ended the session" from "we broke the login".
    const fresh = await actingAs(ctx, 'portal', CLIENT);
    await fresh.get(PORTAL_ME).expect(200);
  });

  it('revokes the CLIENT’s sessions and no one else’s', async () => {
    const client = await actingAs(ctx, 'portal', CLIENT);
    await client.get(PORTAL_ME).expect(200);

    await setStatus('suspended').expect(200);

    // The admin driving this test is legitimately still live; revoking theirs
    // would be a different bug, and one a client-only assertion cannot see.
    await master.get('/v1/admin/auth/me').expect(200);
  });

  it('records how many sessions it ended, so the audit row says what happened', async () => {
    await actingAs(ctx, 'portal', CLIENT);
    await setStatus('suspended').expect(200);

    const [row] = await ctx.db.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.subjectId, String(clientId)), eq(auditLog.action, 'client.suspend')))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);

    const details = row?.details as { sessionsRevoked?: number } | null;
    expect(
      details?.sessionsRevoked,
      'the suspension row does not say what it ended',
    ).toBeGreaterThan(0);
  });

  it('reports no sessionsRevoked when REACTIVATING — nothing was ended', async () => {
    await ctx.db.db.update(users).set({ status: 'suspended' }).where(eq(users.id, clientId));

    await setStatus('active').expect(200);

    const [row] = await ctx.db.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.subjectId, String(clientId)), eq(auditLog.action, 'client.activate')))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);

    const details = row?.details as { sessionsRevoked?: number } | null;
    expect(details?.sessionsRevoked).toBeUndefined();
  });
});
