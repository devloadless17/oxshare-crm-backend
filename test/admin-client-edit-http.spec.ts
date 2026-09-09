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
import {
  admins,
  auditLog,
  refreshTokens,
  roles,
  tradingAccounts,
  users,
} from '../src/database/schema';

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
/** Holds clients.edit, but their ROLE masks `client.phone` (RBAC-03). */
const MASKED_CLERK = { email: 'edit-masked@oxshare.com', password: 'admin-password-123' };

const CLIENT = { email: 'edit-target@oxshare-e2e.test', password: 'client-password-123' };

let ctx: HttpTestContext;
let master: Session;
let clerk: Session;
let viewer: Session;
let maskedClerk: Session;
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

  /*
   * An editor whose ROLE hides the phone number (RBAC-03).
   *
   * They can correct a client's name — a real support task — and must not be
   * able to read back the field the mask withholds. Seeded through a role
   * rather than a per-admin override because the role is the level a mask is
   * normally set at, and `AdminRbacService` resolves it into `fieldMask`.
   */
  const [maskedRole] = await ctx.db.db
    .insert(roles)
    .values({
      name: 'Edit Clerk, No Phone',
      permissions: ['clients.view', 'clients.edit'],
      maskedFields: ['client.phone'],
    })
    .returning();

  await ctx.db.db.insert(admins).values({
    email: MASKED_CLERK.email,
    passwordHash: adminHash,
    name: 'Edit Clerk No Phone',
    role: 'sub_admin',
    roleId: maskedRole.id,
    permissions: [],
    status: 'active',
  });

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
  maskedClerk = await actingAs(ctx, 'admin', MASKED_CLERK);
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
      emailVerificationTokenHash: null,
      emailVerificationConsumedAt: null,
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

  /*
   * ── The PATCH response is masked, like every other read of a client ──
   *
   * It was not. `profileView` returned the row raw while `getClientProfile`
   * masked the identical object, so an admin whose role hides a client's phone
   * number could PATCH a harmless field — their own first name correction —
   * and read the hidden number straight out of the 200. That is a masking
   * bypass on the feature whose entire promise (RBAC-03) is that a masked
   * field is ABSENT from the JSON rather than merely hidden by the console.
   *
   * Asserted on the WIRE, because that is the only place the promise means
   * anything: `toHaveProperty` is false only when the key is genuinely gone.
   */
  it('does not hand a masked field back in the response to an edit', async () => {
    const res = await maskedClerk
      .patch(`/v1/admin/clients/${clientId}`, { firstName: 'Leila' })
      .expect(200);

    expect(res.body).not.toHaveProperty('phone');
    expect(res.body.firstName).toBe('Leila');
    // The sibling list says WHICH fields were withheld, so the console can
    // print "hidden by your permissions" rather than an empty box that reads
    // as "this client has no phone number".
    expect(res.body.maskedFields).toContain('client.phone');

    // The mask is a READ restriction, not a write one — the row is untouched.
    expect((await clientRow()).phone).toBe('+9613111222');
  });

  it('still returns an unmasked field to an editor whose role hides nothing', async () => {
    const res = await master
      .patch(`/v1/admin/clients/${clientId}`, { firstName: 'Leila' })
      .expect(200);

    expect(res.body.phone).toBe('+9613111222');
    expect(res.body.maskedFields).toEqual([]);
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

  it('records NO client address, because the log is the one store nothing can mask', async () => {
    /*
     * `audit_log.details` is free-form jsonb with no declared shape, so neither
     * `applyMask` nor the response interceptor can reach inside it. An
     * administrator whose role hides `client.email` was reading addresses
     * straight off the audit screen — and the address was pure denormalised
     * context here: `subject_id` IS the client, and `before`/`after` carry the
     * change. Recording it made the row no more answerable and spread PII into
     * the one place this system cannot take it back out of.
     *
     * Asserted on the whole serialised row rather than on a key, because the
     * next author's habit is to add context, and `{ client: { email } }` would
     * pass a check that only looked for a top-level `email`.
     */
    await master.patch(`/v1/admin/clients/${clientId}`, { firstName: 'Nadia' }).expect(200);

    /*
     * EVERY row of this action, not the first one. The rows accumulate across
     * this file, so indexing picked up an earlier test's edit and asserted
     * about the wrong write — a pass that would have meant nothing.
     */
    /*
     * POLLED. `audit.record` is fire-and-forget by design — right for a profile
     * edit, where failing the operator's save over a log write would be the
     * wrong trade — so the row lands shortly AFTER the 200. Reading immediately
     * asserted about the previous test's write instead of this one.
     */
    let rows = await auditRows('client.profile_update');
    for (let i = 0; i < 40 && !JSON.stringify(rows).includes('Nadia'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      rows = await auditRows('client.profile_update');
    }
    for (const row of rows) {
      expect(JSON.stringify(row.details), 'an address reached the audit log').not.toContain('@');
      // Still identified — by id, which a reader resolves through the client
      // screens, under their OWN mask.
      expect(row.subjectId).toBe(clientId);
    }
    // Non-vacuous: the rows still record the changes they exist to record.
    expect(JSON.stringify(rows.map((r) => r.details))).toContain('Nadia');
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
    expect(row.emailVerificationTokenHash).toBeTruthy();
    /*
     * And the PREVIOUS cycle's redemption marker is gone with it.
     *
     * This client had verified their old address, so the row carried a
     * `consumed_at`. Carrying it into the new cycle would make the very first
     * click on the new link answer `already_verified` — verifying nothing while
     * telling the client it had. See schema.ts.
     */
    expect(row.emailVerificationConsumedAt).toBeNull();
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

/**
 * ADM-01's trading-accounts card, which was DECLARED on the response and
 * populated by nothing.
 *
 * Every profile therefore reported no trading accounts — including a client
 * holding three — and because the field is optional the console rendered an
 * empty section rather than an error. That is the same failure the portal's own
 * accounts page once had, on the console this time, and in front of the reader
 * most likely to act on it.
 *
 * Asserted on the WIRE, because the distinction that matters is between an
 * ABSENT section and an EMPTY one: absent means "your permissions hide this",
 * empty means "this client has none", and a card cannot say the right one
 * unless the two arrive differently.
 */
describe('the client profile lists the client’s trading accounts', () => {
  beforeEach(async () => {
    await ctx.db.db.delete(tradingAccounts).where(eq(tradingAccounts.userId, clientId));
  });

  it('returns the accounts to a reader holding trading.view', async () => {
    await ctx.db.db.insert(tradingAccounts).values([
      {
        userId: clientId,
        login: '5100001',
        mt5Group: 'real\\Standard',
        environment: 'live',
        currency: 'USD',
        leverage: 100,
      },
      {
        userId: clientId,
        login: '5100002',
        mt5Group: 'demo\\Standard',
        environment: 'demo',
        currency: 'USD',
      },
    ]);

    const res = await master.get(`/v1/admin/clients/${clientId}`).expect(200);

    expect(res.body.tradingAccounts).toHaveLength(2);
    // LIVE first: the accounts holding real money are what the card is opened
    // for, and enum order rather than an alphabetical accident decides it.
    expect(res.body.tradingAccounts[0].mt5Login).toBe('5100001');
    expect(res.body.tradingAccounts[0].environment).toBe('live');
    expect(res.body.tradingAccounts[0].mt5Group).toBe('real\\Standard');
    expect(res.body.tradingAccounts[1].environment).toBe('demo');
  });

  it('returns an EMPTY array for a client who genuinely has none', async () => {
    const res = await master.get(`/v1/admin/clients/${clientId}`).expect(200);

    /*
     * Present and empty, never absent. Absent is reserved for "hidden by your
     * permissions", and collapsing the two is what let this card report an
     * account-less client and a hidden section with the same rendering.
     */
    expect(res.body).toHaveProperty('tradingAccounts');
    expect(res.body.tradingAccounts).toEqual([]);
  });

  it('omits the section entirely from a reader without trading.view', async () => {
    await ctx.db.db.insert(tradingAccounts).values({
      userId: clientId,
      login: '5100003',
      environment: 'live',
      currency: 'USD',
    });

    const res = await viewer.get(`/v1/admin/clients/${clientId}`).expect(200);

    expect(res.body).not.toHaveProperty('tradingAccounts');
  });
});
