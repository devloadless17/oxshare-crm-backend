import { ALL_PERMISSIONS } from './support/all-permissions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  actingAs,
  anonymous,
  startHttpTestApp,
  stopHttpTestApp,
  SURFACES,
  type HttpTestContext,
} from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import { admins, refreshTokens } from '../src/database/schema';

/**
 * Admin password recovery, over HTTP — DECISIONS D-44.
 *
 * `test/admin-reset-guard.spec.ts` proves the escalation rules as pure logic.
 * What it cannot show is that those rules are WIRED to the route: a guard that
 * is correct and unreferenced looks identical in review to one that is enforced.
 * So this drives the real endpoints through the real chain.
 *
 * The properties that matter here are the ones that make a reset link safe to
 * put in an email on a system that approves payouts: it works exactly once, it
 * dies with the session it replaces, and it refuses to reach upwards.
 */

const MASTER = { email: 'reset-master@oxshare.com', password: 'admin-password-123' };
const OTHER_MASTER = { email: 'reset-master-2@oxshare.com', password: 'admin-password-123' };
const SUB = { email: 'reset-sub@oxshare.com', password: 'admin-password-123' };
const TARGET = { email: 'reset-target@oxshare.com', password: 'admin-password-123' };

let ctx: HttpTestContext;
const ids: Record<string, string> = {};

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const passwords = new PasswordService();
  const hash = await passwords.hash(MASTER.password);

  const rows = [
    {
      ...MASTER,
      name: 'Reset Master',
      role: 'master_admin' as const,
      permissions: ALL_PERMISSIONS,
    },
    {
      ...OTHER_MASTER,
      name: 'Other Master',
      role: 'master_admin' as const,
      permissions: ALL_PERMISSIONS,
    },
    // Holds the admin-management grant and nothing above it — the identity that
    // makes "a permission alone is not enough" demonstrable.
    { ...SUB, name: 'Reset Sub', role: 'sub_admin' as const, permissions: ['admins.create'] },
    { ...TARGET, name: 'Reset Target', role: 'sub_admin' as const, permissions: ['kyc.review'] },
  ];

  for (const row of rows) {
    const [created] = await ctx.db.db
      .insert(admins)
      .values({
        email: row.email,
        passwordHash: hash,
        name: row.name,
        role: row.role,
        permissions: row.permissions,
        status: 'active',
      })
      .returning();
    ids[row.email] = created.id;
  }
});

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

/** The token is emailed, never returned — so read the hash the route stored. */
async function armedTokenHashFor(email: string): Promise<string | null> {
  const [row] = await ctx.db.db.select().from(admins).where(eq(admins.email, email)).limit(1);
  return row?.passwordResetTokenHash ?? null;
}

describe('POST /admin/users/:id/password-reset', () => {
  it('lets a master arm a reset for another admin', async () => {
    const master = await actingAs(ctx, 'admin', MASTER);
    await master.post(`/v1/admin/users/${ids[TARGET.email]}/password-reset`, {}).expect(200);

    expect(await armedTokenHashFor(TARGET.email)).not.toBeNull();
  });

  it('REFUSES a sub-admin reaching a master, and arms nothing', async () => {
    /*
     * The headline case. The sub-admin holds `users.create`, so the permission
     * guard admits them — and a system whose only control was that permission
     * would hand over the master account here.
     *
     * Asserting the column is still empty matters as much as the status: a
     * route that refused the response but had already written the token would
     * pass a status-only check while leaving a usable credential in the row.
     */
    const sub = await actingAs(ctx, 'admin', SUB);
    await sub.post(`/v1/admin/users/${ids[MASTER.email]}/password-reset`, {}).expect(403);

    expect(await armedTokenHashFor(MASTER.email)).toBeNull();
  });

  it('lets a master reset ANOTHER master — masters are peers (D-44)', async () => {
    // Resolved deliberately: forbidding it strands a sole locked-out master with
    // no way back except the database. The audit row is what makes it survivable.
    const master = await actingAs(ctx, 'admin', MASTER);
    await master.post(`/v1/admin/users/${ids[OTHER_MASTER.email]}/password-reset`, {}).expect(200);
  });

  it('refuses to reset YOUR OWN account, whoever you are', async () => {
    // Change-password verifies the password you already know; this path does
    // not. Allowing self-reset would turn a stolen session into a permanent one.
    const master = await actingAs(ctx, 'admin', MASTER);
    const res = await master.post(`/v1/admin/users/${ids[MASTER.email]}/password-reset`, {});
    expect(res.status).toBe(400);
  });

  it('refuses an admin with no admin-management permission at all', async () => {
    const target = await actingAs(ctx, 'admin', TARGET);
    await target.post(`/v1/admin/users/${ids[SUB.email]}/password-reset`, {}).expect(403);
  });
});

describe('POST /admin/password-reset/complete', () => {
  /** Arm a reset and return the RAW token, recovered the only way a test can. */
  async function armReset(targetEmail: string): Promise<string> {
    const master = await actingAs(ctx, 'admin', MASTER);
    await master.post(`/v1/admin/users/${ids[targetEmail]}/password-reset`, {}).expect(200);
    // The raw token only exists in the email, and nothing echoes it anywhere, so
    // a test cannot read it back. The spec therefore arms a KNOWN token by
    // writing the hash the route would have written. Everything after this is
    // the real path.
    const known = 'e2e-reset-token-known-value';
    const { createHash } = await import('crypto');
    await ctx.db.db
      .update(admins)
      .set({ passwordResetTokenHash: createHash('sha256').update(known).digest('hex') })
      .where(eq(admins.email, targetEmail));
    return known;
  }

  it('sets the password, and the link cannot be used twice', async () => {
    /*
     * Single-use is the property that makes this safe to email. It is enforced
     * in the UPDATE's WHERE clause rather than by a preceding SELECT, so two
     * requests racing cannot both succeed — the same reasoning the money rules
     * apply to `UPDATE … WHERE state='approved'`.
     */
    const token = await armReset(TARGET.email);
    const newPassword = 'a-brand-new-password-123';

    await anonymous(ctx)
      .post('/v1/admin/password-reset/complete')
      .set('Origin', SURFACES.admin.origin)
      .send({ token, password: newPassword })
      .expect(200);

    // The second attempt finds nothing to spend.
    await anonymous(ctx)
      .post('/v1/admin/password-reset/complete')
      .set('Origin', SURFACES.admin.origin)
      .send({ token, password: 'another-password-123' })
      .expect(400);

    // And the new password is the one that works.
    const signedIn = await actingAs(ctx, 'admin', { email: TARGET.email, password: newPassword });
    await signedIn.get('/v1/admin/auth/me').expect(200);
  });

  it('stamps passwordChangedAt, so a pre-reset access token has a cutoff', async () => {
    /*
     * Family revocation reaches every token carrying a `fam` claim, and
     * today that is every token this surface mints — but the cutoff is the
     * control that does not depend on that stays true. The portal's reset
     * has stamped it since it shipped, `changePassword` on this surface
     * stamps it, and the reset was the one writer that forgot: an access
     * token minted seconds before a duress reset deserves both locks.
     */
    const before = new Date();
    const token = await armReset(TARGET.email);
    await anonymous(ctx)
      .post('/v1/admin/password-reset/complete')
      .set('Origin', SURFACES.admin.origin)
      .send({ token, password: 'cutoff-checking-password-123' })
      .expect(200);

    const [row] = await ctx.db.db
      .select()
      .from(admins)
      .where(eq(admins.email, TARGET.email))
      .limit(1);
    expect(row?.passwordChangedAt).toBeTruthy();
    expect(row.passwordChangedAt!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);

    // Put the fixture's password back — the tests below sign in with it.
    const restore = await armReset(TARGET.email);
    await anonymous(ctx)
      .post('/v1/admin/password-reset/complete')
      .set('Origin', SURFACES.admin.origin)
      .send({ token: restore, password: TARGET.password })
      .expect(200);
  });

  it('kills every existing session for that admin', async () => {
    /*
     * The reason a reset exists is often that somebody should no longer be in
     * the account. Leaving their session alive would make the whole exercise
     * decorative.
     *
     * Counted in the database rather than by driving a second browser, because
     * what is being asserted is that the families were revoked — not that one
     * particular request 401s.
     */
    const password = 'session-kill-password-123';
    // The fixture password: the cutoff test above restores it, so this test no
    // longer leans on a SIDE EFFECT of the single-use test two above it.
    await actingAs(ctx, 'admin', TARGET);

    const live = async () =>
      (
        await ctx.db.db
          .select()
          .from(refreshTokens)
          .where(
            and(eq(refreshTokens.subjectId, ids[TARGET.email]), eq(refreshTokens.surface, 'admin')),
          )
      ).filter((r) => r.revokedAt === null).length;

    expect(await live(), 'no session to revoke — the test proves nothing').toBeGreaterThan(0);

    const token = await armReset(TARGET.email);
    await anonymous(ctx)
      .post('/v1/admin/password-reset/complete')
      .set('Origin', SURFACES.admin.origin)
      .send({ token, password })
      .expect(200);

    expect(await live()).toBe(0);
  });

  it('answers a spent token and a made-up one identically', async () => {
    /*
     * Non-disclosure, asserted as SAMENESS rather than as the absence of a word.
     *
     * The first version of this checked the message did not contain "expired" —
     * and failed, because the copy reads "invalid or has expired", which is
     * exactly the non-committal phrasing wanted. The word is not the leak; a
     * DIFFERENCE between the two answers is. Telling a spent token from a
     * fictional one tells somebody grinding for an admin account which guess
     * was closest.
     */
    const spent = await armReset(SUB.email);
    await anonymous(ctx)
      .post('/v1/admin/password-reset/complete')
      .set('Origin', SURFACES.admin.origin)
      .send({ token: spent, password: 'first-use-password-123' })
      .expect(200);

    const replay = await anonymous(ctx)
      .post('/v1/admin/password-reset/complete')
      .set('Origin', SURFACES.admin.origin)
      .send({ token: spent, password: 'replay-password-123' });

    const fictional = await anonymous(ctx)
      .post('/v1/admin/password-reset/complete')
      .set('Origin', SURFACES.admin.origin)
      .send({ token: 'never-existed-at-all', password: 'whatever-password-123' });

    expect(replay.status).toBe(400);
    expect(fictional.status).toBe(replay.status);
    expect((fictional.body as { message: string }).message).toBe(
      (replay.body as { message: string }).message,
    );
  });
});
