import { ALL_PERMISSIONS } from './support/all-permissions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import {
  actingAs,
  anonymous,
  startHttpTestApp,
  stopHttpTestApp,
  type HttpTestContext,
} from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import {
  adminClientTagScopes,
  admins,
  apiKeys,
  auditLog,
  clientTagAssignments,
  clientTags,
  roles,
  users,
} from '../src/database/schema';
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
const SCOPED = { email: 'apikey-scoped@oxshare.com', password: 'admin-password-123' };
/**
 * Mints a key and is then SUSPENDED, which no other case here does.
 *
 * Separate from SCOPED deliberately: suspending a fixture the rest of the
 * file signs in as would fail later cases for a reason that has nothing to do
 * with what they assert, and would do it only when this test runs first.
 */
const KEY_OWNER = { email: 'apikey-owner@oxshare.com', password: 'admin-password-123' };

let inScopeClientId: string;
let keyOwnerId: string;
let outScopeClientId: string;

let ctx: HttpTestContext;

beforeAll(async () => {
  ctx = await startHttpTestApp();

  const passwords = new PasswordService();
  const hash = await passwords.hash(MASTER.password);

  const [masterRole] = await ctx.db.db
    .insert(roles)
    .values({
      name: 'API Key Master',
      description: 'Full.',
      permissions: ALL_PERMISSIONS,
      isSystem: false,
    })
    .returning();

  // A deliberately LIMITED role: the anti-escalation assertions below need an
  // admin who holds something, but not everything.
  const [limitedRole] = await ctx.db.db
    .insert(roles)
    .values({
      name: 'API Key Limited',
      description: 'Reads clients only.',
      permissions: ['clients.view'],
      isSystem: false,
    })
    .returning();

  // A tag-scoped admin who may mint keys — the escalation case (#7). Holds
  // clients.view + apikeys.create, and is confined to one tag.
  const [scopedRole] = await ctx.db.db
    .insert(roles)
    .values({
      name: 'API Key Scoped',
      description: 'Reads clients, mints keys, confined to a territory.',
      permissions: ['clients.view', 'apikeys.create'],
      isSystem: false,
    })
    .returning();

  const [, , scopedAdmin, keyOwner] = await ctx.db.db
    .insert(admins)
    .values([
      {
        email: MASTER.email,
        passwordHash: hash,
        name: 'API Key Master',
        role: 'master_admin',
        roleId: masterRole.id,
        permissions: ALL_PERMISSIONS,
      },
      {
        email: SUB.email,
        passwordHash: hash,
        name: 'API Key Sub',
        role: 'sub_admin',
        roleId: limitedRole.id,
        permissions: ['clients.view'],
      },
      {
        email: SCOPED.email,
        passwordHash: hash,
        name: 'API Key Scoped',
        role: 'sub_admin',
        roleId: scopedRole.id,
        permissions: ['clients.view', 'apikeys.create'],
        seesUntriaged: false,
      },
      {
        email: KEY_OWNER.email,
        passwordHash: hash,
        name: 'API Key Owner',
        role: 'sub_admin',
        roleId: scopedRole.id,
        permissions: ['clients.view', 'apikeys.create'],
      },
    ])
    .returning();
  keyOwnerId = keyOwner.id;

  const [tag] = await ctx.db.db
    .insert(clientTags)
    .values({ slug: 'apikey-territory', label: 'API Key Territory' })
    .returning();
  await ctx.db.db
    .insert(adminClientTagScopes)
    .values({ adminId: scopedAdmin.id, tagId: tag.id, createdBy: scopedAdmin.id });

  const [mine] = await ctx.db.db
    .insert(users)
    .values({
      email: 'apikey-mine@oxshare-e2e.test',
      passwordHash: 'x',
      firstName: 'InScope',
      lastName: 'Client',
    })
    .returning();
  await ctx.db.db.insert(clientTagAssignments).values({ userId: mine.id, tagId: tag.id });
  inScopeClientId = mine.id;

  const [theirs] = await ctx.db.db
    .insert(users)
    .values({
      email: 'apikey-theirs@oxshare-e2e.test',
      passwordHash: 'x',
      firstName: 'OutOfScope',
      lastName: 'Client',
    })
    .returning();
  outScopeClientId = theirs.id;
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

/** Issue a key through the real endpoint and return its plaintext. */
async function issueKey(
  body: { name: string; permissions: string[]; expiresAt?: string | null } = {
    name: 'Test key',
    permissions: ['clients.view'],
  },
): Promise<{ plaintext: string; id: string }> {
  const session = await actingAs(ctx, 'admin', MASTER);
  const res = await session.post('/v1/admin/api-keys', body).expect(201);
  return { plaintext: res.body.plaintext, id: res.body.key.id };
}

/**
 * Put KEY_OWNER back to active.
 *
 * Every case in the suspension block below ends with them suspended, and a
 * suspended admin cannot sign in — so without this the second case fails at
 * `actingAs` with a 401 that looks like broken login rather than a fixture left
 * where the previous test dropped it.
 */
async function reactivateKeyOwner(): Promise<void> {
  await ctx.db.db.update(admins).set({ status: 'active' }).where(eq(admins.id, keyOwnerId));
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
        permissions: ['clients.view'],
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
      .post('/v1/admin/api-keys', { name: 'Escalation', permissions: ['clients.view'] })
      .expect(403);
  });
});

describe('authenticating with a key', () => {
  it('reaches an admin endpoint with no cookie at all', async () => {
    const { plaintext } = await issueKey({ name: 'Reader', permissions: ['clients.view'] });

    const res = await anonymous(ctx)
      .get('/v1/admin/clients?limit=1')
      .set('X-API-Key', plaintext)
      .expect(200);

    // A real payload, not just a 200: the key reached the handler and the
    // handler ran, which is the whole claim being made here.
    expect(res.body).toHaveProperty('items');
  });

  it('is accepted as a Bearer token too', async () => {
    const { plaintext } = await issueKey({ name: 'Bearer', permissions: ['clients.view'] });
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
    const { plaintext } = await issueKey({ name: 'Narrow', permissions: ['clients.view'] });

    await anonymous(ctx).get('/v1/admin/audit-log').set('X-API-Key', plaintext).expect(403);
  });

  it('INHERITS the creator’s territory — a scoped admin cannot mint an unrestricted key (#7)', async () => {
    /*
     * The escalation the 13 Aug scoped walk found: a key authenticated as
     * unrestricted regardless of who created it, so a tag-scoped admin holding
     * `apikeys.create` could mint a key that read the whole client base. The
     * fix snapshots the creator's territory onto the key (migration 0059). The
     * key here is minted by an admin confined to one tag, so it must see the
     * in-scope client and 404 the out-of-scope one — the same 404 the creator
     * themselves would get, never a 403.
     */
    const scoped = await actingAs(ctx, 'admin', SCOPED);
    const issued = await scoped
      .post('/v1/admin/api-keys', { name: 'Scoped reader', permissions: ['clients.view'] })
      .expect(201);
    const key = issued.body.plaintext as string;

    const mine = await anonymous(ctx)
      .get(`/v1/admin/clients/${inScopeClientId}`)
      .set('X-API-Key', key)
      .expect(200);
    expect(mine.body.email).toBe('apikey-mine@oxshare-e2e.test');

    // The whole point: the out-of-scope client is a 404 to the key, exactly as
    // to its scoped creator — the territory did not launder away through it.
    await anonymous(ctx)
      .get(`/v1/admin/clients/${outScopeClientId}`)
      .set('X-API-Key', key)
      .expect(404);

    // And the list is narrowed, not just the by-id route.
    const list = await anonymous(ctx)
      .get('/v1/admin/clients?q=oxshare-e2e.test&limit=100')
      .set('X-API-Key', key)
      .expect(200);
    const emails = (list.body.items as { email: string }[]).map((c) => c.email);
    expect(emails).toContain('apikey-mine@oxshare-e2e.test');
    expect(emails).not.toContain('apikey-theirs@oxshare-e2e.test');
  });

  it('a MASTER-minted key stays unrestricted — the reporting-job case is unchanged', async () => {
    const { plaintext } = await issueKey({ name: 'Reporting', permissions: ['clients.view'] });
    const list = await anonymous(ctx)
      .get('/v1/admin/clients?q=oxshare-e2e.test&limit=100')
      .set('X-API-Key', plaintext)
      .expect(200);
    const emails = (list.body.items as { email: string }[]).map((c) => c.email);
    // Sees BOTH — no territory confines a key an unrestricted admin minted.
    expect(emails).toContain('apikey-mine@oxshare-e2e.test');
    expect(emails).toContain('apikey-theirs@oxshare-e2e.test');
  });

  it('refuses a made-up key', async () => {
    await anonymous(ctx)
      .get('/v1/admin/clients?limit=1')
      .set('X-API-Key', 'oxs_live_totally-invented-value')
      .expect(401);
  });

  it('stops working the moment it is revoked', async () => {
    const { plaintext, id } = await issueKey({ name: 'Doomed', permissions: ['clients.view'] });

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
    const { plaintext, id } = await issueKey({ name: 'Expiring', permissions: ['clients.view'] });
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
    const { plaintext, id } = await issueKey({ name: 'Revoked', permissions: ['clients.view'] });
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
    const { plaintext } = await issueKey({ name: 'Wrong surface', permissions: ['clients.view'] });
    await anonymous(ctx).get('/v1/auth/me').set('X-API-Key', plaintext).expect(401);
  });
});

describe('revoking', () => {
  it('keeps the row, so the audit trail still resolves', async () => {
    const { id } = await issueKey({ name: 'Kept', permissions: ['clients.view'] });
    const session = await actingAs(ctx, 'admin', MASTER);
    await session.del(`/v1/admin/api-keys/${id}`).expect(200);

    const [row] = await ctx.db.db.select().from(apiKeys).where(eq(apiKeys.id, id));
    expect(row).toBeDefined();
    expect(row.revokedAt).not.toBeNull();
  });

  it('succeeds when the key is already revoked', async () => {
    // The caller's intent is already satisfied; erroring would make a retry
    // after a dropped connection look like a failure.
    const { id } = await issueKey({ name: 'Twice', permissions: ['clients.view'] });
    const session = await actingAs(ctx, 'admin', MASTER);
    await session.del(`/v1/admin/api-keys/${id}`).expect(200);
    await session.del(`/v1/admin/api-keys/${id}`).expect(200);
  });

  it('404s for a key that never existed', async () => {
    const session = await actingAs(ctx, 'admin', MASTER);
    await session.del('/v1/admin/api-keys/11111111-2222-3333-4444-555555555555').expect(404);
  });
});

describe('the anti-forgery waiver is exactly as wide as the admin surface', () => {
  /*
   * CsrfGuard skips its Origin and token checks for a request carrying a key,
   * because the admin surface authenticates the KEY rather than a cookie and a
   * cross-site page cannot set that header. The portal authenticates only the
   * COOKIE, so the waiver applying there was a hole: any string in `X-API-Key`
   * beside a client session reached the handler with neither check — observed
   * against a running API on 14 Sep 2026 as a 400 from validation where the
   * guard should have answered 403. Both halves are pinned over HTTP, so the fix
   * can neither regress nor pass by breaking integrations.
   *
   * Every body below is invalid on purpose: were a guard ever to wave one
   * through again, validation stops it and nothing is written.
   */
  const CLIENT = { email: 'apikey-client@oxshare-e2e.test', password: 'client-password-123' };

  beforeAll(async () => {
    // A client who can really SIGN IN — verified, with a genuine password hash.
    await ctx.db.db.insert(users).values({
      email: CLIENT.email,
      passwordHash: await new PasswordService().hash(CLIENT.password),
      firstName: 'Portal',
      lastName: 'Client',
      emailVerified: true,
    });
  });

  it('keeps both checks on a PORTAL write that carries a key header', async () => {
    const client = await actingAs(ctx, 'portal', CLIENT);

    const keyHeaders: Record<string, string>[] = [
      { 'X-API-Key': 'oxs_live_not-a-real-key' },
      { Authorization: 'Bearer oxs_live_not-a-real-key' },
    ];
    for (const header of keyHeaders) {
      const res = await client
        .post('/v1/auth/change-password', {}, { origin: null, omitCsrf: true, headers: header })
        .expect(403);
      expect(res.body.message).toContain('anti-forgery');
    }
  });

  it('still waives them for a real key writing on the ADMIN surface', async () => {
    const { plaintext } = await issueKey({ name: 'Writer', permissions: ['apikeys.create'] });

    // No Origin, no cookie, no token: the key alone clears the guard chain, and
    // the empty body is refused by validation rather than by any guard.
    const res = await anonymous(ctx)
      .post('/v1/admin/api-keys')
      .set('X-API-Key', plaintext)
      .send({})
      .expect(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });
});

describe('suspending the administrator who minted a key', () => {
  it('REVOKES the keys they issued — the session and the credential end together', async () => {
    /*
     * Ending the sessions and leaving the keys takes away the screen and leaves
     * the access.
     *
     * A key carries its creator's permissions and territory snapshotted onto the
     * row, so it keeps answering with their authority after their cookies stop
     * working — `admin-rbac.service.ts` has revoked the refresh families on
     * suspend since it was written, and nothing touched the keys. Someone
     * suspended for cause who minted a key on the way out kept everything that
     * key could reach, indefinitely: `findActiveByHash` filters `revoked_at IS
     * NULL` and never looks at who created the row.
     *
     * The snapshot itself is deliberate and stays — `admin.guard.ts` explains
     * that a key holds no live join to its creator so it survives their
     * DELETION. Suspension is the case that reasoning never covered: a decision
     * about the person, taken while the link still exists.
     */
    await reactivateKeyOwner();
    const owner = await actingAs(ctx, 'admin', KEY_OWNER);
    const issued = await owner
      .post('/v1/admin/api-keys', { name: 'Owner key', permissions: ['clients.view'] })
      .expect(201);
    const key = issued.body.plaintext as string;

    // It works while its creator is active — otherwise the assertion below
    // passes for the wrong reason.
    const before = await anonymous(ctx)
      .get('/v1/admin/clients?limit=1')
      .set('X-API-Key', key)
      .expect(200);
    expect(before.body).toHaveProperty('items');

    const master = await actingAs(ctx, 'admin', MASTER);
    await master.patch(`/v1/admin/users/${keyOwnerId}/status`, { status: 'suspended' }).expect(200);

    // 401, not 403: the credential is no longer valid at all, which is the same
    // answer a revoked key has always given.
    await anonymous(ctx).get('/v1/admin/clients?limit=1').set('X-API-Key', key).expect(401);
  });

  it('leaves keys minted by OTHER administrators alone', async () => {
    /*
     * The blast radius. Revoking every key on any suspension would take down
     * integrations belonging to people who were not suspended — a far worse
     * outage than the gap being closed, and the reason `revokeAllCreatedBy`
     * filters on `created_by` rather than revoking the table.
     */
    await reactivateKeyOwner();
    const { plaintext } = await issueKey({ name: 'Master key', permissions: ['clients.view'] });

    const owner = await actingAs(ctx, 'admin', KEY_OWNER);
    await owner
      .post('/v1/admin/api-keys', { name: 'Doomed key', permissions: ['clients.view'] })
      .expect(201);

    const master = await actingAs(ctx, 'admin', MASTER);
    await master.patch(`/v1/admin/users/${keyOwnerId}/status`, { status: 'suspended' }).expect(200);

    await anonymous(ctx).get('/v1/admin/clients?limit=1').set('X-API-Key', plaintext).expect(200);
  });

  it('reports what it revoked, so the audit row says what the suspension cost', async () => {
    await reactivateKeyOwner();
    const owner = await actingAs(ctx, 'admin', KEY_OWNER);
    await owner
      .post('/v1/admin/api-keys', { name: 'Counted key', permissions: ['clients.view'] })
      .expect(201);

    const master = await actingAs(ctx, 'admin', MASTER);
    await master.patch(`/v1/admin/users/${keyOwnerId}/status`, { status: 'suspended' }).expect(200);

    const [row] = await ctx.db.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.subjectId, keyOwnerId), eq(auditLog.action, 'admin.suspend')))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);

    const details = row?.details as { apiKeysRevoked?: number } | null;
    expect(
      details?.apiKeysRevoked,
      'the suspension row does not say what it ended',
    ).toBeGreaterThan(0);
  });
});
