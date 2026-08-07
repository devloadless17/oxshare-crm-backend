import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  actingAs,
  anonymous,
  startHttpTestApp,
  stopHttpTestApp,
  type HttpTestContext,
} from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import { admins, apiKeys, roles } from '../src/database/schema';
import { hashApiKey } from '../src/common/security/api-key';

/**
 * API keys, over HTTP, through the real guard chain.
 *
 * WHY THIS IS AN HTTP SPEC. A key's whole purpose is to replace a session
 * cookie at the edge, and the thing that could go wrong is not the hashing —
 * it is whether the assembled chain treats a key-authenticated request exactly
 * as it treats a signed-in one. `AdminAuthenticator` returns the same
 * `AuthenticatedAdmin` for both precisely so every downstream permission check
 * applies unchanged; only a request through the real router can prove that it
 * does, and that a key cannot slip past a check a session is subject to.
 *
 * The credential under test is always obtained by CALLING THE REAL ENDPOINT.
 * No spec here mints a key by inserting a row, so no assertion can pass
 * against a token the application would never have issued.
 */

const MASTER = { email: 'apikey-master@oxshare.com', password: 'admin-password-123' };
const SUB = { email: 'apikey-sub@oxshare.com', password: 'admin-password-123' };

let ctx: HttpTestContext;

beforeAll(async () => {
  ctx = await startHttpTestApp();

  const passwords = new PasswordService();
  const hash = await passwords.hash(MASTER.password);

  const [masterRole] = await ctx.db.db
    .insert(roles)
    .values({ name: 'API Key Master', description: 'Full.', permissions: ['*'], isSystem: false })
    .returning();

  // A deliberately LIMITED role: the anti-escalation assertions below need an
  // admin who holds something, but not everything.
  const [limitedRole] = await ctx.db.db
    .insert(roles)
    .values({
      name: 'API Key Limited',
      description: 'Reads clients only.',
      permissions: ['users.view'],
      isSystem: false,
    })
    .returning();

  await ctx.db.db.insert(admins).values([
    {
      email: MASTER.email,
      passwordHash: hash,
      name: 'API Key Master',
      role: 'master_admin',
      roleId: masterRole.id,
      permissions: ['*'],
    },
    {
      email: SUB.email,
      passwordHash: hash,
      name: 'API Key Sub',
      role: 'sub_admin',
      roleId: limitedRole.id,
      permissions: ['users.view'],
    },
  ]);
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

/** Issue a key through the real endpoint and return its plaintext. */
async function issueKey(
  body: { name: string; permissions: string[]; expiresAt?: string | null } = {
    name: 'Test key',
    permissions: ['users.view'],
  },
): Promise<{ plaintext: string; id: string }> {
  const session = await actingAs(ctx, 'admin', MASTER);
  const res = await session.post('/v1/admin/api-keys', body).expect(201);
  return { plaintext: res.body.plaintext, id: res.body.key.id };
}

describe('issuing a key', () => {
  it('returns the plaintext exactly once, and never stores it', async () => {
    const { plaintext, id } = await issueKey();

    expect(plaintext).toMatch(/^oxs_live_/);

    /*
     * The load-bearing assertion of this whole feature: what is at rest is a
     * HASH, and the plaintext appears nowhere in the row. A database dump must
     * not yield a working credential.
     */
    const [row] = await ctx.db.db.select().from(apiKeys).where(eq(apiKeys.id, id));
    expect(row.secretHash).toBe(hashApiKey(plaintext));
    expect(JSON.stringify(row)).not.toContain(plaintext);

    // And it is never recoverable — the list carries a prefix, not a secret.
    const session = await actingAs(ctx, 'admin', MASTER);
    const list = await session.get('/v1/admin/api-keys').expect(200);
    expect(JSON.stringify(list.body)).not.toContain(plaintext);
  });

  it('stores a prefix long enough to identify and too short to use', async () => {
    const { plaintext, id } = await issueKey();
    const [row] = await ctx.db.db.select().from(apiKeys).where(eq(apiKeys.id, id));

    expect(plaintext.startsWith(row.prefix)).toBe(true);
    expect(row.prefix.length).toBeLessThan(plaintext.length / 2);
  });

  it('refuses a key with no permissions', async () => {
    // A key that authenticates and can do nothing reads as a broken
    // integration to whoever installed it.
    const session = await actingAs(ctx, 'admin', MASTER);
    await session.post('/v1/admin/api-keys', { name: 'Empty', permissions: [] }).expect(400);
  });

  it('refuses an unknown permission key', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    await session
      .post('/v1/admin/api-keys', { name: 'Bogus', permissions: ['not.a.real.key'] })
      .expect(400);
  });

  it('refuses an expiry in the past', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    await session
      .post('/v1/admin/api-keys', {
        name: 'Stale',
        permissions: ['users.view'],
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      })
      .expect(400);
  });

  it('is MASTER ADMIN only — a sub-admin cannot mint one', async () => {
    /*
     * Issuing a key creates standing access to the admin API with no login and
     * no session lifetime. That belongs with the security switches and the SMTP
     * form: powers that should not be delegatable at all, because a permission
     * key for it eventually lands on a role called "Operations".
     */
    const session = await actingAs(ctx, 'admin', SUB);
    await session
      .post('/v1/admin/api-keys', { name: 'Escalation', permissions: ['users.view'] })
      .expect(403);
  });
});

describe('authenticating with a key', () => {
  it('reaches an admin endpoint with no cookie at all', async () => {
    const { plaintext } = await issueKey({ name: 'Reader', permissions: ['users.view'] });

    const res = await anonymous(ctx)
      .get('/v1/admin/clients?limit=1')
      .set('X-API-Key', plaintext)
      .expect(200);

    // A real payload, not just a 200: the key reached the handler and the
    // handler ran, which is the whole claim being made here.
    expect(res.body).toHaveProperty('items');
  });

  it('is accepted as a Bearer token too', async () => {
    const { plaintext } = await issueKey({ name: 'Bearer', permissions: ['users.view'] });
    await anonymous(ctx)
      .get('/v1/admin/clients?limit=1')
      .set('Authorization', `Bearer ${plaintext}`)
      .expect(200);
  });

  it('is REFUSED on an endpoint its permissions do not cover', async () => {
    /*
     * The point of the whole design: a key is subject to exactly the checks a
     * session is. `users.view` does not imply the audit log, and the key does
     * not become its creator — who, here, is a master admin.
     */
    const { plaintext } = await issueKey({ name: 'Narrow', permissions: ['users.view'] });

    await anonymous(ctx).get('/v1/admin/audit-log').set('X-API-Key', plaintext).expect(403);
  });

  it('refuses a made-up key', async () => {
    await anonymous(ctx)
      .get('/v1/admin/clients?limit=1')
      .set('X-API-Key', 'oxs_live_totally-invented-value')
      .expect(401);
  });

  it('stops working the moment it is revoked', async () => {
    const { plaintext, id } = await issueKey({ name: 'Doomed', permissions: ['users.view'] });

    await anonymous(ctx).get('/v1/admin/clients?limit=1').set('X-API-Key', plaintext).expect(200);

    const session = await actingAs(ctx, 'admin', MASTER);
    await session.del(`/v1/admin/api-keys/${id}`).expect(200);

    // Immediate, because the guard reads revoked_at on every request rather
    // than trusting anything cached.
    await anonymous(ctx).get('/v1/admin/clients?limit=1').set('X-API-Key', plaintext).expect(401);
  });

  it('refuses an EXPIRED key, and says so distinctly', async () => {
    /*
     * Expiry is answered distinctly where revocation is not. An expired key is
     * one the caller legitimately held, so "issue a new one" is actionable and
     * reveals nothing. Revocation is a decision made ABOUT them, and saying so
     * would confirm the key was genuine.
     *
     * The row is aged directly because the API refuses to CREATE a key that is
     * already expired — the two rules are consistent, so the only way to
     * observe expiry is to let time pass.
     */
    const { plaintext, id } = await issueKey({ name: 'Expiring', permissions: ['users.view'] });
    await ctx.db.db
      .update(apiKeys)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(apiKeys.id, id));

    const res = await anonymous(ctx)
      .get('/v1/admin/clients?limit=1')
      .set('X-API-Key', plaintext)
      .expect(401);

    expect(res.body.code).toBe('API_KEY_EXPIRED');
  });

  it('does not let a revoked key be told apart from a fictional one', async () => {
    const { plaintext, id } = await issueKey({ name: 'Revoked', permissions: ['users.view'] });
    const session = await actingAs(ctx, 'admin', MASTER);
    await session.del(`/v1/admin/api-keys/${id}`).expect(200);

    const revoked = await anonymous(ctx)
      .get('/v1/admin/clients?limit=1')
      .set('X-API-Key', plaintext)
      .expect(401);
    const invented = await anonymous(ctx)
      .get('/v1/admin/clients?limit=1')
      .set('X-API-Key', 'oxs_live_never-existed')
      .expect(401);

    expect(revoked.body.message).toBe(invented.body.message);
  });

  it('cannot reach the PORTAL surface', async () => {
    // An admin credential must be worthless on the client surface — the same
    // separation the two JWT secrets enforce for sessions.
    const { plaintext } = await issueKey({ name: 'Wrong surface', permissions: ['users.view'] });
    await anonymous(ctx).get('/v1/auth/me').set('X-API-Key', plaintext).expect(401);
  });
});

describe('revoking', () => {
  it('keeps the row, so the audit trail still resolves', async () => {
    const { id } = await issueKey({ name: 'Kept', permissions: ['users.view'] });
    const session = await actingAs(ctx, 'admin', MASTER);
    await session.del(`/v1/admin/api-keys/${id}`).expect(200);

    const [row] = await ctx.db.db.select().from(apiKeys).where(eq(apiKeys.id, id));
    expect(row).toBeDefined();
    expect(row.revokedAt).not.toBeNull();
  });

  it('succeeds when the key is already revoked', async () => {
    // The caller's intent is already satisfied; erroring would make a retry
    // after a dropped connection look like a failure.
    const { id } = await issueKey({ name: 'Twice', permissions: ['users.view'] });
    const session = await actingAs(ctx, 'admin', MASTER);
    await session.del(`/v1/admin/api-keys/${id}`).expect(200);
    await session.del(`/v1/admin/api-keys/${id}`).expect(200);
  });

  it('404s for a key that never existed', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    await session.del('/v1/admin/api-keys/11111111-2222-3333-4444-555555555555').expect(404);
  });
});
