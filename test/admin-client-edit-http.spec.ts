import { ALL_PERMISSIONS } from './support/all-permissions';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
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
 * CORE-18's admin half, over HTTP, through the real guard chain.
 *
 * The property worth an HTTP test rather than a service test is the SPLIT: that
 * `clients.edit` and `clients.email` are genuinely two grants and not one with
 * two names. A service-level test asserts what the service refuses; only the
 * real chain proves the permission decorator on each route matches the
 * `assertActorCan` inside it, and that an operator handed the everyday key
 * cannot reach the account-takeover one.
 *
 * The rest is what makes the email change safe: sessions revoked, verification
 * reset, and an audit row that names both addresses.
 */

const MASTER = { email: 'edit-master@oxshare.com', password: 'admin-password-123' };
/** Holds clients.edit but NOT clients.email — the whole point of the split. */
const CLERK = { email: 'edit-clerk@oxshare.com', password: 'admin-password-123' };
/** Holds clients.view only — cannot edit anything. */
const VIEWER = { email: 'edit-viewer@oxshare.com', password: 'admin-password-123' };

const CLIENT = { email: 'edit-target@oxshare-e2e.test', password: 'client-password-123' };

let ctx: HttpTestContext;
let master: Session;
let clerk: Session;
let viewer: Session;
let clientId: string;

async function clientRow() {
  const [row] = await ctx.db.db.select().from(users).where(eq(users.id, clientId));
  return row;
}

/**
 * This client's rows for one action, newest first.
 *
 * Filtered rather than cleared: `audit_log` carries an append-only trigger
 * (D-21) and refuses DELETE outright — "an audit entry recorded in error is
 * itself a fact". So each assertion narrows to the subject under test instead
 * of assuming an empty table.
 */
async function auditRows(action: string) {
  const rows = await ctx.db.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.subjectId, clientId)));
  return rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const passwords = new PasswordService();
  const adminHash = await passwords.hash(MASTER.password);

  const [masterRole] = await ctx.db.db
    .insert(roles)
    .values({ name: 'Edit Master', permissions: ALL_PERMISSIONS, isSystem: true })
    .returning();

  await ctx.db.db.insert(admins).values([
    {
      email: MASTER.email,
      passwordHash: adminHash,
      name: 'Edit Master',
      role: 'master_admin',
      roleId: masterRole.id,
      permissions: ALL_PERMISSIONS,
      status: 'active',
    },
    {
      email: CLERK.email,
      passwordHash: adminHash,
      name: 'Edit Clerk',
      role: 'sub_admin',
      permissions: ['clients.view', 'clients.edit'],
      status: 'active',
    },
    {
      email: VIEWER.email,
      passwordHash: adminHash,
      name: 'Edit Viewer',
      role: 'sub_admin',
      permissions: ['clients.view'],
      status: 'active',
    },
  ]);

  const [client] = await ctx.db.db
    .insert(users)
    .values({
      email: CLIENT.email,
      passwordHash: await passwords.hash(CLIENT.password),
      firstName: 'Layla',
      lastName: 'Hadad',
      emailVerified: true,
      country: 'Lebanon',
      phone: '+9613111222',
    })
    .returning();
  clientId = client.id;

  master = await actingAs(ctx, 'admin', MASTER);
  clerk = await actingAs(ctx, 'admin', CLERK);
  viewer = await actingAs(ctx, 'admin', VIEWER);
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

beforeEach(async () => {
  await ctx.db.db
    .update(users)
    .set({
      email: CLIENT.email,
      firstName: 'Layla',
      lastName: 'Hadad',
      country: 'Lebanon',
      phone: '+9613111222',
      emailVerified: true,
      emailVerificationToken: null,
    })
    .where(eq(users.id, clientId));
  /*
   * `audit_log` is deliberately NOT cleared — it cannot be. The append-only
   * trigger refuses DELETE, so the assertions filter by subject instead.
   *
   * The CLIENT's tokens only.
   *
   * A blanket delete also removes the sessions the three admin fixtures signed
   * in with in `beforeAll`, and every request in the file then arrives
   * unauthenticated — fifteen 401s that look like a broken guard rather than a
   * broken fixture.
   */
  await ctx.db.db.delete(refreshTokens).where(eq(refreshTokens.subjectId, clientId));
});

describe('editing a profile', () => {
  it('corrects the fields a support desk actually fixes', async () => {
    const res = await master
      .patch(`/v1/admin/clients/${clientId}`, { firstName: 'Leila', lastName: 'Haddad' })
      .expect(200);

    expect(res.body.firstName).toBe('Leila');
    expect(res.body.lastName).toBe('Haddad');

    const row = await clientRow();
    expect(row.firstName).toBe('Leila');
    expect(row.lastName).toBe('Haddad');
  });

  it('clears an optional field when sent an empty string', async () => {
    await master.patch(`/v1/admin/clients/${clientId}`, { phone: '' }).expect(200);

    // NULL, not '' — "no number on file" and "the number is the empty string"
    // behave differently in every query that follows.
    expect((await clientRow()).phone).toBeNull();
  });

  it('leaves fields the caller did not name alone', async () => {
    await master.patch(`/v1/admin/clients/${clientId}`, { firstName: 'Leila' }).expect(200);

    const row = await clientRow();
    expect(row.lastName).toBe('Hadad');
    expect(row.country).toBe('Lebanon');
    expect(row.phone).toBe('+9613111222');
  });

  it('records only what actually moved', async () => {
    await master
      .patch(`/v1/admin/clients/${clientId}`, { firstName: 'Leila', country: 'Lebanon' })
      .expect(200);

    const [row] = await auditRows('client.profile_update');
    const meta = row.details as { before: Record<string, unknown>; after: Record<string, unknown> };
    // `country` was posted but unchanged, so it is not a change.
    expect(Object.keys(meta.after)).toEqual(['firstName']);
    expect(meta.before.firstName).toBe('Layla');
  });

  it('writes no audit row when nothing changed', async () => {
    // Relative to a baseline, because earlier tests in this file legitimately
    // left rows behind and the table cannot be truncated.
    const before = (await auditRows('client.profile_update')).length;
    await master.patch(`/v1/admin/clients/${clientId}`, { firstName: 'Layla' }).expect(200);
    expect(await auditRows('client.profile_update')).toHaveLength(before);
  });

  it('refuses a body that names no field', async () => {
    await master.patch(`/v1/admin/clients/${clientId}`, {}).expect(400);
  });

  it('refuses an admin holding only clients.view', async () => {
    await viewer.patch(`/v1/admin/clients/${clientId}`, { firstName: 'Nope' }).expect(403);
    expect((await clientRow()).firstName).toBe('Layla');
  });

  it('is 404, never 403, for a client that does not exist', async () => {
    await master
      .patch('/v1/admin/clients/00000000-0000-4000-8000-0000000000ff', { firstName: 'X' })
      .expect(404);
  });
});

describe('changing the sign-in email', () => {
  it('is refused for an admin who can edit a profile but not the email', async () => {
    /*
     * THE test in this file. `clients.edit` is handed out for clerical work; if
     * it also carried the email change, every support operator would hold an
     * account-takeover primitive and the grant would not say so.
     */
    await clerk
      .patch(`/v1/admin/clients/${clientId}/email`, { email: 'attacker@evil.test' })
      .expect(403);

    expect((await clientRow()).email).toBe(CLIENT.email);
  });

  it('changes the address, resets verification and issues a fresh token', async () => {
    const res = await master
      .patch(`/v1/admin/clients/${clientId}/email`, { email: 'Leila.Haddad@Example.com' })
      .expect(200);

    // Lower-cased: users.email is unique as written, so two casings would be two
    // accounts one person believes is one.
    expect(res.body.email).toBe('leila.haddad@example.com');
    expect(res.body.emailVerified).toBe(false);

    const row = await clientRow();
    expect(row.email).toBe('leila.haddad@example.com');
    expect(row.emailVerified).toBe(false);
    expect(row.emailVerificationToken).toBeTruthy();
  });

  it('revokes every portal session the client had', async () => {
    const client = await actingAs(ctx, 'portal', CLIENT);
    const clientTokens = () =>
      ctx.db.db.select().from(refreshTokens).where(eq(refreshTokens.subjectId, clientId));

    expect((await clientTokens()).filter((t) => t.revokedAt === null).length).toBeGreaterThan(0);

    await master
      .patch(`/v1/admin/clients/${clientId}/email`, { email: 'moved@example.com' })
      .expect(200);

    // The client's, specifically — the admin sessions driving this test are
    // legitimately still live, and revoking those would be a different bug.
    expect((await clientTokens()).every((t) => t.revokedAt !== null)).toBe(true);

    // And the session really is dead, not merely marked: refresh is the thing
    // revocation exists to stop.
    await client.post('/v1/identity/refresh').expect(401);
  });

  it('records both addresses, so a takeover is reconstructable', async () => {
    await master
      .patch(`/v1/admin/clients/${clientId}/email`, { email: 'moved@example.com' })
      .expect(200);

    const [row] = await auditRows('client.email_change');
    const meta = row.details as { before: string; after: string; sessionsRevoked: boolean };
    expect(meta.before).toBe(CLIENT.email);
    expect(meta.after).toBe('moved@example.com');
    expect(meta.sessionsRevoked).toBe(true);
  });

  it('refuses an address another account already uses', async () => {
    const passwords = new PasswordService();
    await ctx.db.db.insert(users).values({
      email: 'taken@oxshare-e2e.test',
      passwordHash: await passwords.hash('x'),
      firstName: 'Other',
      lastName: 'Person',
    });

    // A clear 400 rather than a 23505 surfacing as a 500 with a constraint name.
    await master
      .patch(`/v1/admin/clients/${clientId}/email`, { email: 'taken@oxshare-e2e.test' })
      .expect(400);

    expect((await clientRow()).email).toBe(CLIENT.email);
    await ctx.db.db.delete(users).where(eq(users.email, 'taken@oxshare-e2e.test'));
  });

  it('refuses the address the client already has', async () => {
    await master.patch(`/v1/admin/clients/${clientId}/email`, { email: CLIENT.email }).expect(400);
  });

  it('refuses a malformed address before anything is revoked', async () => {
    const client = await actingAs(ctx, 'portal', CLIENT);

    await master
      .patch(`/v1/admin/clients/${clientId}/email`, { email: 'not-an-email' })
      .expect(400);

    // Validation runs before revocation, so a typo does not log the client out.
    await client.get('/v1/identity/me').expect(200);
  });
});
