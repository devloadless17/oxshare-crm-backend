import { ALL_PERMISSIONS } from './support/all-permissions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  actingAs,
  anonymous,
  startHttpTestApp,
  stopHttpTestApp,
  SURFACES,
  type HttpTestContext,
} from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import { admins, roles } from '../src/database/schema';

/**
 * Suspending an administrator, over HTTP, through the real chain.
 *
 * `admins.status` was enforced long before anything could set it: AdminGuard
 * re-reads the row on every request and refuses a suspended admin, and login
 * refuses them too. The only write in the codebase set `'active'` on
 * invite-accept, so cutting off a compromised or departing administrator meant
 * direct SQL — or deleting the row, which destroys the subject every audit_log
 * entry points at.
 *
 * The property that matters is the one a service-level test cannot show:
 * suspension bites on the NEXT REQUEST, not at token expiry. An admin holding a
 * valid 8-hour session must stop working the moment they are suspended.
 * `test/admin-users.spec.ts` proves the service refuses the wrong callers; this
 * proves the ban actually reaches a live session.
 */

const MASTER = { email: 'susp-master@oxshare.com', password: 'admin-password-123' };
const OPERATOR = { email: 'susp-operator@oxshare.com', password: 'admin-password-123' };
const TARGET = { email: 'susp-target@oxshare.com', password: 'admin-password-123' };
/** Holds users.edit but NOT users.suspend — the 403 case. */
const EDITOR = { email: 'susp-editor@oxshare.com', password: 'admin-password-123' };

const ADMIN_ME = '/v1/admin/auth/me';

let ctx: HttpTestContext;
let targetId: string;
let masterId: string;

/** Put the target back to active between tests that suspend it. */
async function reactivate() {
  await ctx.db.db.update(admins).set({ status: 'active' }).where(eq(admins.id, targetId));
}

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const passwords = new PasswordService();
  const hash = await passwords.hash(MASTER.password);

  const [masterRole] = await ctx.db.db
    .insert(roles)
    .values({ name: 'Susp Master', permissions: ALL_PERMISSIONS, isSystem: true })
    .returning();

  const [master] = await ctx.db.db
    .insert(admins)
    .values({
      email: MASTER.email,
      passwordHash: hash,
      name: 'Susp Master',
      role: 'master_admin',
      roleId: masterRole.id,
      permissions: ALL_PERMISSIONS,
      status: 'active',
    })
    .returning();
  masterId = master.id;

  await ctx.db.db.insert(admins).values({
    email: OPERATOR.email,
    passwordHash: hash,
    name: 'Susp Operator',
    role: 'sub_admin',
    /*
     * `admins.suspend`, not `clients.suspend` — this operator suspends
     * ADMINISTRATORS, and the two are separate keys on purpose ("Revoke /
     * Restore Administrator Access" vs "Suspend / Restore Client Access").
     * The fixture kept the client key through the rework, so the test named
     * for an operator who DOES hold the grant was asserting a 403.
     */
    permissions: ['clients.view', 'admins.edit', 'admins.suspend'],
    status: 'active',
  });

  await ctx.db.db.insert(admins).values({
    email: EDITOR.email,
    passwordHash: hash,
    name: 'Susp Editor',
    role: 'sub_admin',
    permissions: ['clients.view', 'admins.edit'],
    status: 'active',
  });

  const [target] = await ctx.db.db
    .insert(admins)
    .values({
      email: TARGET.email,
      passwordHash: hash,
      name: 'Susp Target',
      role: 'sub_admin',
      permissions: ['kyc.review'],
      status: 'active',
    })
    .returning();
  targetId = target.id;
});

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('a suspension reaches a live session', () => {
  it('kills an ALREADY-AUTHENTICATED admin on their very next request', async () => {
    // The whole point of the 15-minute-ish access token and the row re-read in
    // AdminGuard. If this ever regresses to "expires when the token does", a
    // compromised administrator keeps full access for the rest of their session.
    await reactivate();
    const victim = await actingAs(ctx, 'admin', TARGET);
    await victim.get(ADMIN_ME).expect(200);

    const master = await actingAs(ctx, 'admin', MASTER);
    await master.patch(`/v1/admin/users/${targetId}/status`, { status: 'suspended' }).expect(200);

    // Same cookies, same session, no re-login.
    await victim.get(ADMIN_ME).expect(401);
  });

  it('refuses a suspended admin at login too', async () => {
    await reactivate();
    const master = await actingAs(ctx, 'admin', MASTER);
    await master.patch(`/v1/admin/users/${targetId}/status`, { status: 'suspended' }).expect(200);

    await expect(actingAs(ctx, 'admin', TARGET)).rejects.toThrow();
  });

  it('lets them back in once reactivated', async () => {
    // Reversibility is the reason suspension exists rather than deletion.
    const master = await actingAs(ctx, 'admin', MASTER);
    await master.patch(`/v1/admin/users/${targetId}/status`, { status: 'active' }).expect(200);

    const restored = await actingAs(ctx, 'admin', TARGET);
    await restored.get(ADMIN_ME).expect(200);
  });

  it('suspension REVOKES the sessions — reactivation does not resurrect them', async () => {
    /*
     * The guard blocking a suspended admin is necessary and not sufficient:
     * it reads the STATUS, so the moment somebody reactivates the account the
     * old cookies work again — a session nobody signed in resumes on its own.
     * Suspension now ends the refresh families, which reaches the access
     * token too (its `fam` claim fails the revocation check), so coming back
     * means signing in again.
     */
    await reactivate();
    const victim = await actingAs(ctx, 'admin', TARGET);
    await victim.get(ADMIN_ME).expect(200);

    const master = await actingAs(ctx, 'admin', MASTER);
    await master.patch(`/v1/admin/users/${targetId}/status`, { status: 'suspended' }).expect(200);
    await master.patch(`/v1/admin/users/${targetId}/status`, { status: 'active' }).expect(200);

    // The ACCOUNT is back; the old session is not.
    await victim.get(ADMIN_ME).expect(401);
    // And a fresh sign-in works — the account itself is healthy.
    const fresh = await actingAs(ctx, 'admin', TARGET);
    await fresh.get(ADMIN_ME).expect(200);
  });
});

describe('who may suspend', () => {
  it('answers 403, not 401, without users.suspend — FSD §8.8', async () => {
    // An authenticated admin lacking a permission is FORBIDDEN, not
    // unauthenticated. 401 would send the admin app into a refresh-and-retry
    // loop against a request that can never succeed.
    await reactivate();
    const editor = await actingAs(ctx, 'admin', EDITOR);
    await editor.patch(`/v1/admin/users/${targetId}/status`, { status: 'suspended' }).expect(403);
  });

  it('allows a sub-admin who does hold users.suspend', async () => {
    await reactivate();
    const operator = await actingAs(ctx, 'admin', OPERATOR);
    await operator.patch(`/v1/admin/users/${targetId}/status`, { status: 'suspended' }).expect(200);
  });

  it('refuses an anonymous caller with 401 — no session', async () => {
    // The Origin header is sent deliberately. CsrfGuard checks origin on EVERY
    // state change, session or not (the login-CSRF fix), so a request without
    // one never reaches authentication and would answer 403 for a reason that
    // has nothing to do with who is asking. Sending a legitimate origin isolates
    // the property under test: no session means 401.
    await anonymous(ctx)
      .patch(`/v1/admin/users/${targetId}/status`)
      .set('Origin', SURFACES.admin.origin)
      .send({ status: 'suspended' })
      .expect(401);
  });

  it('refuses a state change from a foreign ORIGIN, before authenticating it', async () => {
    // The other half, stated on purpose rather than met by accident. An attacker
    // page must not be able to reach this endpoint at all, and the refusal must
    // not depend on the caller being signed in.
    await anonymous(ctx)
      .patch(`/v1/admin/users/${targetId}/status`)
      .set('Origin', 'https://attacker.example')
      .send({ status: 'suspended' })
      .expect(403);
  });

  it('refuses a state-changing request with no CSRF token', async () => {
    // The admin write surface is double-submit protected; a literal path match
    // in CsrfGuard once disarmed this on every admin route.
    await reactivate();
    const master = await actingAs(ctx, 'admin', MASTER);
    await master
      .patch(`/v1/admin/users/${targetId}/status`, { status: 'suspended' }, { omitCsrf: true })
      .expect(403);
  });
});

describe('what cannot be suspended', () => {
  /*
   * The master is no longer a protected row, and this asserts the rule that
   * replaced the protection.
   *
   * This expected 400 on the reasoning that the master is everyone's way back.
   * The permission rework removed that idea — "there is no master admin to
   * protect any more. What is protected is the SYSTEM" — and put a sharper
   * guard in its place: no status change may leave the directory with nobody
   * holding `admins.edit`. Several administrators hold it here, so suspending
   * the master is now an ordinary, permitted act.
   *
   * It is reversed immediately. The master is the identity most of this file
   * signs in as, so leaving it suspended would fail the specs after it for a
   * reason none of them are about — which is exactly how this test failing
   * took two others down with it.
   */
  it('refuses a LESSER manager suspending the full-access admin — D-59, the super admin is out of reach', async () => {
    /*
     * The owner's rule, replacing the earlier "any manager may suspend the
     * master" pin: nobody manages an account whose access SUPERSEDES their
     * own (holds everything they hold, and more). Suspension of a superior is
     * the bluntest takeover there is.
     */
    await reactivate();
    const operator = await actingAs(ctx, 'admin', OPERATOR);
    await operator.patch(`/v1/admin/users/${masterId}/status`, { status: 'suspended' }).expect(403);

    // Still signed in, untouched.
    const master = await actingAs(ctx, 'admin', MASTER);
    await master.get(ADMIN_ME).expect(200);
  });

  it('lets an EQUAL suspend the full-access admin while managers remain — peers can rescue each other', async () => {
    // Equals are peers, exactly as D-44 made them for password reset: a
    // locked-out or compromised top admin must be stoppable by the other one,
    // and the last-manager guard is what keeps the pair from zeroing out.
    await reactivate();
    const passwords = new PasswordService();
    const PEER = { email: 'susp-peer@oxshare.com', password: 'admin-password-123' };
    await ctx.db.db.insert(admins).values({
      email: PEER.email,
      passwordHash: await passwords.hash(PEER.password),
      name: 'Susp Peer',
      role: 'sub_admin',
      permissions: ALL_PERMISSIONS,
      seesUntriaged: false,
      status: 'active',
    });

    const peer = await actingAs(ctx, 'admin', PEER);
    await peer.patch(`/v1/admin/users/${masterId}/status`, { status: 'suspended' }).expect(200);

    // Suspension bites on the NEXT request, so this is the real check.
    await expect(actingAs(ctx, 'admin', MASTER)).rejects.toThrow();

    await ctx.db.db.update(admins).set({ status: 'active' }).where(eq(admins.id, masterId));
    const master = await actingAs(ctx, 'admin', MASTER);
    await master.get(ADMIN_ME).expect(200);
  });

  it('rejects a status outside the enum before it reaches the service', async () => {
    // The global ValidationPipe whitelists; AdminStatusDto pins the two values.
    await reactivate();
    const master = await actingAs(ctx, 'admin', MASTER);
    await master.patch(`/v1/admin/users/${targetId}/status`, { status: 'deleted' }).expect(400);
  });
});

describe('the directory tells the truth about status', () => {
  it('reports a suspended admin as suspended', async () => {
    // The admin app rendered a hardcoded "Active" badge because this field did
    // not exist on the response. Adding it to AdminProfileDto and the sanitize()
    // allow-list is what lets the screen read the real value.
    await reactivate();
    const master = await actingAs(ctx, 'admin', MASTER);
    await master.patch(`/v1/admin/users/${targetId}/status`, { status: 'suspended' }).expect(200);

    const res = await master.get('/v1/admin/users').expect(200);
    const rows = res.body as Array<{ id: string; status?: string; passwordHash?: string }>;
    const row = rows.find((r) => r.id === targetId);

    expect(row?.status).toBe('suspended');
    // sanitize() is an allow-list; prove it stayed one.
    expect(row).not.toHaveProperty('passwordHash');
  });
});
