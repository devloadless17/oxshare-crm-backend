import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  actingAs,
  anonymous,
  parseSetCookies,
  sessionFrom,
  startHttpTestApp,
  stopHttpTestApp,
  SURFACES,
  type HttpTestContext,
} from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import { admins, roles } from '../src/database/schema';

/**
 * An administrator's own password and sessions, over HTTP, through the real
 * guard chain.
 *
 * ## Why this is a near-copy of `account-security-http.spec.ts`
 *
 * It is, and deliberately. The portal has had both of these since R-3.5 and the
 * admin console had neither: an administrator could not change their password
 * from inside a session at all — the only route was `POST
 * /admin/users/:id/password-reset`, which is somebody ELSE mailing them a link
 * — and there was no way to see, let alone end, a session on a machine they no
 * longer had. On the surface that approves withdrawals, that is the wrong way
 * round.
 *
 * So the semantics were copied rather than reinvented, and the tests are copied
 * with them. Where an assertion differs from its portal twin it is because the
 * surfaces genuinely differ, and each such place says so.
 *
 * ## The one behaviour with no portal equivalent
 *
 * `sessionFamilyId` comes from the `fam` claim on the ACCESS token, which this
 * surface signs and the portal's does not. The portal has to read its refresh
 * cookie and decode an unverified jti to answer "which of these rows is you".
 * The "marks the session making the request" test below is therefore covering a
 * different mechanism under the same name, which is the reason it is here
 * rather than assumed from the portal's copy.
 */

const ADMIN = { email: 'sec-admin@oxshare.com', password: 'admin-password-123' };
const OTHER = { email: 'sec-admin-other@oxshare.com', password: 'admin-password-123' };

const SESSIONS = '/v1/admin/auth/sessions';
const CHANGE_PASSWORD = '/v1/admin/auth/change-password';
const ADMIN_ME = '/v1/admin/auth/me';
const AVATAR = '/v1/admin/auth/me/avatar';

let ctx: HttpTestContext;

beforeAll(async () => {
  ctx = await startHttpTestApp();

  const passwords = new PasswordService();
  const hash = await passwords.hash(ADMIN.password);

  /*
   * A role holding NOTHING.
   *
   * Every route under test is `@AnyAdmin`, and an admin with a full permission
   * set could not tell "this endpoint needs no permission" from "this endpoint
   * needs one I happen to have". An empty role is what makes these assertions
   * mean what they say.
   */
  const [empty] = await ctx.db.db
    .insert(roles)
    .values({
      name: 'Account Security Nobody',
      description: 'Holds no permissions at all.',
      permissions: [],
      isSystem: false,
    })
    .returning();

  await ctx.db.db.insert(admins).values([
    {
      email: ADMIN.email,
      passwordHash: hash,
      name: 'Sec Admin',
      role: 'sub_admin',
      roleId: empty.id,
      permissions: [],
    },
    {
      email: OTHER.email,
      passwordHash: hash,
      name: 'Other Admin',
      role: 'sub_admin',
      roleId: empty.id,
      permissions: [],
    },
  ]);
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('GET /admin/auth/sessions', () => {
  it('refuses an anonymous caller', async () => {
    await anonymous(ctx).get(SESSIONS).expect(401);
  });

  it('answers an administrator holding no permissions at all', async () => {
    /*
     * The whole point of `@AnyAdmin` on these routes. An administrator whose
     * role is one screen wide still has a stolen laptop to sign out, and gating
     * that on a permission would mean the ability to see where you are signed in
     * is something another person grants you.
     */
    const session = await actingAs(ctx, 'admin', ADMIN);
    await session.get(SESSIONS).expect(200);
  });

  it('lists one entry per LOGIN, not per token row', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    const res = await session.get(SESSIONS).expect(200);

    const ids = (res.body as { id: string }[]).map((s) => s.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('marks the session making the request, and only that one', async () => {
    /*
     * Resolved from the `fam` claim on the access token — verified by the guard
     * before this handler runs — rather than by decoding the refresh cookie the
     * way the portal must. A second login must not change which row the FIRST
     * session calls its own.
     */
    const first = await actingAs(ctx, 'admin', ADMIN);
    await actingAs(ctx, 'admin', ADMIN);

    const res = await first.get(SESSIONS).expect(200);
    const current = (res.body as { current: boolean }[]).filter((s) => s.current);
    expect(current).toHaveLength(1);
  });

  it("never shows one administrator another's sessions", async () => {
    const mine = await actingAs(ctx, 'admin', ADMIN);
    const theirs = await actingAs(ctx, 'admin', OTHER);

    const [mineRes, theirsRes] = await Promise.all([
      mine.get(SESSIONS).expect(200),
      theirs.get(SESSIONS).expect(200),
    ]);

    const mineIds = new Set((mineRes.body as { id: string }[]).map((s) => s.id));
    const theirIds = (theirsRes.body as { id: string }[]).map((s) => s.id);
    expect(theirIds.some((id) => mineIds.has(id))).toBe(false);
  });
});

describe('DELETE /admin/auth/sessions/:id', () => {
  it('ends another of my sessions, for real', async () => {
    const keep = await actingAs(ctx, 'admin', ADMIN);
    const doomed = await actingAs(ctx, 'admin', ADMIN);

    const before = await doomed.get(SESSIONS).expect(200);
    const target = (before.body as { id: string; current: boolean }[]).find((s) => s.current);

    await keep.del(`${SESSIONS}/${target!.id}`).expect(200);

    // Revoked, not delisted. This is the assertion that separates a UI change
    // from a security control: the killed session's cookies must stop working.
    await doomed.get(ADMIN_ME).expect(401);
  });

  it('refuses to revoke the session making the request', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    const list = await session.get(SESSIONS).expect(200);
    const current = (list.body as { id: string; current: boolean }[]).find((s) => s.current);

    await session.del(`${SESSIONS}/${current!.id}`).expect(400);
    // Still alive: refusing must not have revoked it on the way out.
    await session.get(ADMIN_ME).expect(200);
  });

  it("will not let one administrator end another's session", async () => {
    const mine = await actingAs(ctx, 'admin', ADMIN);
    const theirs = await actingAs(ctx, 'admin', OTHER);

    const theirList = await theirs.get(SESSIONS).expect(200);
    const theirCurrent = (theirList.body as { id: string; current: boolean }[]).find(
      (s) => s.current,
    );

    // 404, NOT 403 — "that session exists but is not yours" confirms the
    // existence of another account's session id.
    await mine.del(`${SESSIONS}/${theirCurrent!.id}`).expect(404);
    await theirs.get(ADMIN_ME).expect(200);
  });

  it('answers a malformed id before it reaches a query', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    await session.del(`${SESSIONS}/not-a-uuid`).expect(400);
  });

  it('requires the anti-forgery header, like every other write', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    await actingAs(ctx, 'admin', ADMIN);

    const list = await session.get(SESSIONS).expect(200);
    const other = (list.body as { id: string; current: boolean }[]).find((s) => !s.current);

    expect(other).toBeDefined();
    await session.del(`${SESSIONS}/${other!.id}`, { omitCsrf: true }).expect(403);
  });
});

describe('POST /admin/auth/change-password', () => {
  /** A fresh account per test, so one password change cannot affect another. */
  async function freshAdmin(label: string) {
    const passwords = new PasswordService();
    const creds = { email: `sec-admin-${label}@oxshare.com`, password: 'original-password-1' };
    await ctx.db.db.insert(admins).values({
      email: creds.email,
      passwordHash: await passwords.hash(creds.password),
      name: `Fresh ${label}`,
      role: 'sub_admin',
      permissions: [],
    });
    return creds;
  }

  it('refuses an anonymous caller', async () => {
    // `Origin` set, so the refusal under test is 401 (no session) rather than
    // the 403 `CsrfGuard.assertOriginAllowed` would raise first.
    await anonymous(ctx)
      .post(CHANGE_PASSWORD)
      .set('Origin', SURFACES.admin.origin)
      .send({ currentPassword: 'anything', newPassword: 'whatever-123' })
      .expect(401);
  });

  it('changes the password, and the new one actually works', async () => {
    /*
     * The success path, which is the only one that can catch a reversed
     * `verify(plain, hash)` — every negative case below still passes with those
     * arguments swapped, because a rejection is what they expect. The portal's
     * copy of this service shipped with exactly that bug.
     */
    const creds = await freshAdmin('happy');
    const session = await actingAs(ctx, 'admin', creds);

    await session
      .post(CHANGE_PASSWORD, { currentPassword: creds.password, newPassword: 'brand-new-pass-9' })
      .expect(200);

    // Proved by logging in again through the real route, not by reading a row.
    await actingAs(ctx, 'admin', { email: creds.email, password: 'brand-new-pass-9' });
    await expect(
      actingAs(ctx, 'admin', { email: creds.email, password: creds.password }),
    ).rejects.toThrow();
  });

  it('requires the CURRENT password', async () => {
    const creds = await freshAdmin('wrong-current');
    const session = await actingAs(ctx, 'admin', creds);

    await session
      .post(CHANGE_PASSWORD, { currentPassword: 'not-the-password', newPassword: 'attempted-9' })
      .expect(400);

    // Unchanged: a refused attempt must not have written anything.
    await actingAs(ctx, 'admin', creds);
  });

  it('refuses a "change" to the same password', async () => {
    /*
     * Refused rather than silently accepted. A change that changes nothing
     * leaves somebody believing they have rotated a credential, and signs out
     * their other sessions for no gain.
     */
    const creds = await freshAdmin('unchanged');
    const session = await actingAs(ctx, 'admin', creds);

    await session
      .post(CHANGE_PASSWORD, { currentPassword: creds.password, newPassword: creds.password })
      .expect(400);
  });

  it('keeps the CALLER working, on the cookies from THIS response', async () => {
    /*
     * The subtle half of the feature.
     *
     * `passwordChangedAt` invalidates every access token issued before it, and
     * the cutoff does not know whose token it is looking at — so sparing the
     * caller's refresh family is not enough, and exempting them from the cutoff
     * would put a hole in it. The server revokes everything and re-issues.
     *
     * Which is why the assertion is made against `parseSetCookies(res)` and NOT
     * against the agent that made the call. `actingAs` captures cookies once, at
     * login, and never updates them — so the original agent is holding tokens
     * the cutoff has correctly killed, and asserting on it tests the harness
     * rather than the feature. A real browser installs the new cookies from
     * this very response; `sessionFrom` is what stands in for that.
     *
     * Written the other way first, and it failed with a 401 that looked like a
     * bug in the re-issue. It was not: the re-issue works, and this is the only
     * way to see it.
     */
    const creds = await freshAdmin('reissued');
    const session = await actingAs(ctx, 'admin', creds);

    const res = await session
      .post(CHANGE_PASSWORD, { currentPassword: creds.password, newPassword: 'reissued-pass-9' })
      .expect(200);

    const reissued = sessionFrom(ctx, 'admin', parseSetCookies(res));
    await reissued.get(ADMIN_ME).expect(200);
  });

  it('leaves the administrator with exactly one session afterwards', async () => {
    // The natural consequence of "revoke everything, re-issue one": whatever
    // they had before, they now have one — the device in front of them.
    const creds = await freshAdmin('one-left');
    await actingAs(ctx, 'admin', creds);
    await actingAs(ctx, 'admin', creds);
    const owner = await actingAs(ctx, 'admin', creds);

    const res = await owner
      .post(CHANGE_PASSWORD, { currentPassword: creds.password, newPassword: 'one-left-pass-9' })
      .expect(200);

    const reissued = sessionFrom(ctx, 'admin', parseSetCookies(res));
    const list = await reissued.get(SESSIONS).expect(200);
    expect(list.body).toHaveLength(1);
    expect((list.body as { current: boolean }[])[0].current).toBe(true);
  });

  it('requires the anti-forgery header', async () => {
    const creds = await freshAdmin('csrf');
    const session = await actingAs(ctx, 'admin', creds);

    await session
      .post(
        CHANGE_PASSWORD,
        { currentPassword: creds.password, newPassword: 'never-applied-9' },
        { omitCsrf: true },
      )
      .expect(403);

    // Still the original password: a refused request must not have written.
    await actingAs(ctx, 'admin', creds);
  });

  it('ends every OTHER session immediately, not in fifteen minutes', async () => {
    /*
     * Revoking the refresh families alone would leave each other device working
     * on its already-issued ACCESS token for up to fifteen more minutes. On the
     * console that approves withdrawals, those fifteen minutes are exactly what
     * somebody changing their password under duress is trying to prevent.
     *
     * `/admin/auth/me` is checked on the OTHER session, so this fails if the
     * cutoff is missing even though the family is gone.
     */
    const creds = await freshAdmin('cutoff');
    const other = await actingAs(ctx, 'admin', creds);
    const changer = await actingAs(ctx, 'admin', creds);

    await other.get(ADMIN_ME).expect(200);

    await changer
      .post(CHANGE_PASSWORD, { currentPassword: creds.password, newPassword: 'cutoff-pass-9' })
      .expect(200);

    await other.get(ADMIN_ME).expect(401);
  });

  /*
   * THE THROTTLE IS NOT ASSERTED HERE, and that is a limit of the harness
   * rather than a gap anybody should close by loosening the test.
   *
   * `@Throttle({ ttl: 900_000, limit: 5 })` guards this route because it checks
   * the CURRENT password: unthrottled, it is an oracle for guessing the password
   * of an account whose session has already been stolen, and every guess costs
   * the process one argon2 verification.
   *
   * `RedisThrottlerStorage.increment` opens with `if (!this.redis) return
   * this.permit(ttl)` and the test app runs without Redis, so every request is
   * permitted no matter how many arrive. Seven consecutive wrong-password
   * attempts return seven 400s. The portal's copy of this file omits the same
   * assertion for the same reason.
   */
});

describe('the avatar routes', () => {
  it('refuse an anonymous caller', async () => {
    await anonymous(ctx).post(AVATAR).set('Origin', SURFACES.admin.origin).expect(401);
    await anonymous(ctx).delete(AVATAR).set('Origin', SURFACES.admin.origin).expect(401);
  });

  it('refuse a request carrying no file', async () => {
    // A 400 naming the problem, rather than a 500 from reading `.buffer` off
    // `undefined` — which is what happens without the explicit check.
    const session = await actingAs(ctx, 'admin', ADMIN);
    await session.post(AVATAR, {}).expect(400);
  });

  it('report no photo when there is none', async () => {
    /*
     * Removing an absent photo is a no-op that SUCCEEDS. It is idempotent on
     * purpose: the console draws the button from `avatarUrl`, and a second
     * click landing on an error would punish a double-click for nothing.
     */
    const session = await actingAs(ctx, 'admin', ADMIN);
    const res = await session.del(AVATAR).expect(200);
    expect((res.body as { avatarUrl: string | null }).avatarUrl).toBeNull();
  });

  it('put the photo on /admin/auth/me, where the sidebar reads it', async () => {
    // Not behind a profile endpoint of its own: the sidebar renders the avatar
    // on every page, so a second call would be a round trip per navigation.
    const session = await actingAs(ctx, 'admin', ADMIN);
    const res = await session.get(ADMIN_ME).expect(200);
    expect(res.body).toHaveProperty('avatarUrl');
    expect(res.body).toHaveProperty('passwordChangedAt');
  });
});
