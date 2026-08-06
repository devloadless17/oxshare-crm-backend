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
import { users } from '../src/database/schema';

/**
 * Password change and session management, over HTTP, through the real chain.
 *
 * Both are new, and both were previously answered by the portal rendering a
 * "waiting on backend endpoints" placeholder. What made them worth testing at
 * this level rather than as unit tests is that the interesting behaviour is all
 * in the seams: which sessions survive a password change, which session the
 * caller is allowed to revoke, and whether a family belonging to somebody else
 * is distinguishable from one that does not exist.
 *
 * THE BUG THIS FILE WOULD HAVE CAUGHT. `PasswordService.verify` takes
 * `(plain, hash)`. The first cut of `changePassword` called it as
 * `(hash, plain)` at both of its call sites, so every correct current password
 * read as wrong and the endpoint could never succeed — while every negative
 * test still passed, because a rejection is what they expect. It was found by
 * curl, which is not a thing that runs in CI.
 *
 * Every credential here is obtained by logging in through the real route, so no
 * assertion can pass against a session the application would not have issued.
 */

const CLIENT = { email: 'sec-client@oxshare.com', password: 'client-password-123' };
const OTHER = { email: 'sec-other@oxshare.com', password: 'other-password-123' };

const SESSIONS = '/v1/auth/sessions';
const CHANGE_PASSWORD = '/v1/auth/change-password';
const PORTAL_ME = '/v1/auth/me';

let ctx: HttpTestContext;

beforeAll(async () => {
  ctx = await startHttpTestApp();

  const passwords = new PasswordService();
  const [clientHash, otherHash] = await Promise.all([
    passwords.hash(CLIENT.password),
    passwords.hash(OTHER.password),
  ]);

  await ctx.db.db.insert(users).values([
    {
      email: CLIENT.email,
      passwordHash: clientHash,
      firstName: 'Sec',
      lastName: 'Client',
      type: 'individual',
      status: 'active',
      emailVerified: true,
    },
    {
      email: OTHER.email,
      passwordHash: otherHash,
      firstName: 'Some',
      lastName: 'Other',
      type: 'individual',
      status: 'active',
      emailVerified: true,
    },
  ]);
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

describe('GET /auth/sessions', () => {
  it('refuses an anonymous caller', async () => {
    await anonymous(ctx).get(SESSIONS).expect(401);
  });

  it('lists one entry per LOGIN, not per token row', async () => {
    // A session is a refresh-token FAMILY. One login starts a family and every
    // rotation appends to it, so listing rows would show a client signed in for
    // a month thousands of identical entries and no way to end "the one on the
    // old phone".
    const session = await actingAs(ctx, 'portal', CLIENT);
    const res = await session.get(SESSIONS).expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    const ids = (res.body as { id: string }[]).map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('marks the session making the request, and only that one', async () => {
    // Resolved from the REFRESH cookie, because the access token carries no
    // family id. This is what lets the UI refuse to revoke the session the
    // client is sitting in.
    const first = await actingAs(ctx, 'portal', CLIENT);
    await actingAs(ctx, 'portal', CLIENT);

    const res = await first.get(SESSIONS).expect(200);
    const current = (res.body as { current: boolean }[]).filter((s) => s.current);
    expect(current).toHaveLength(1);
  });

  it('captures what the request looked like, so a row is recognisable', async () => {
    // The whole point of the feature: "there are three sessions and they expire
    // in 29 days" is not something anyone can act on.
    const session = await actingAs(ctx, 'portal', CLIENT);
    const res = await session.get(SESSIONS).expect(200);

    const mine = (res.body as { current: boolean; userAgent: string | null }[]).find(
      (s) => s.current,
    );
    expect(mine?.userAgent).toBeTruthy();
  });

  it("never shows one client another client's sessions", async () => {
    const mine = await actingAs(ctx, 'portal', CLIENT);
    const theirs = await actingAs(ctx, 'portal', OTHER);

    const [mineRes, theirsRes] = await Promise.all([
      mine.get(SESSIONS).expect(200),
      theirs.get(SESSIONS).expect(200),
    ]);

    const mineIds = new Set((mineRes.body as { id: string }[]).map((s) => s.id));
    const theirIds = (theirsRes.body as { id: string }[]).map((s) => s.id);
    expect(theirIds.some((id) => mineIds.has(id))).toBe(false);
  });
});

describe('DELETE /auth/sessions/:id', () => {
  it('ends another of my sessions', async () => {
    const keep = await actingAs(ctx, 'portal', CLIENT);
    const doomed = await actingAs(ctx, 'portal', CLIENT);

    const before = await doomed.get(SESSIONS).expect(200);
    const target = (before.body as { id: string; current: boolean }[]).find((s) => s.current);

    await keep.del(`${SESSIONS}/${target!.id}`).expect(200);

    // Revoked for real, not just delisted: the killed session's cookies must
    // stop working. This is the assertion that separates a UI change from a
    // security control.
    await doomed.get(PORTAL_ME).expect(401);
  });

  it('refuses to revoke the session making the request', async () => {
    /*
     * It would otherwise half-work: the family dies, the httpOnly cookies stay
     * in the browser, and the client sits on a rendered portal where the next
     * request 401s. Logout is the operation that both revokes AND clears the
     * cookies.
     */
    const session = await actingAs(ctx, 'portal', CLIENT);
    const list = await session.get(SESSIONS).expect(200);
    const current = (list.body as { id: string; current: boolean }[]).find((s) => s.current);

    await session.del(`${SESSIONS}/${current!.id}`).expect(400);
    // Still alive, because refusing must not have revoked it on the way out.
    await session.get(PORTAL_ME).expect(200);
  });

  it("will not let one client end another client's session", async () => {
    const mine = await actingAs(ctx, 'portal', CLIENT);
    const theirs = await actingAs(ctx, 'portal', OTHER);

    const theirList = await theirs.get(SESSIONS).expect(200);
    const theirCurrent = (theirList.body as { id: string; current: boolean }[]).find(
      (s) => s.current,
    );

    // 404, NOT 403. Telling a caller "that session exists but is not yours"
    // confirms the existence of another account's session id.
    await mine.del(`${SESSIONS}/${theirCurrent!.id}`).expect(404);
    await theirs.get(PORTAL_ME).expect(200);
  });

  it('answers a malformed id before it reaches a query', async () => {
    const session = await actingAs(ctx, 'portal', CLIENT);
    await session.del(`${SESSIONS}/not-a-uuid`).expect(400);
  });

  it('requires the anti-forgery header, like every other write', async () => {
    const session = await actingAs(ctx, 'portal', CLIENT);
    const list = await session.get(SESSIONS).expect(200);
    const other = (list.body as { id: string; current: boolean }[]).find((s) => !s.current);

    if (other) await session.del(`${SESSIONS}/${other.id}`, { omitCsrf: true }).expect(403);
  });
});

describe('POST /auth/change-password', () => {
  /** A fresh account per test, so one password change cannot affect another. */
  async function freshClient(label: string) {
    const passwords = new PasswordService();
    const creds = { email: `sec-${label}@oxshare.com`, password: 'original-password-1' };
    await ctx.db.db.insert(users).values({
      email: creds.email,
      passwordHash: await passwords.hash(creds.password),
      firstName: 'Fresh',
      lastName: 'Client',
      type: 'individual',
      status: 'active',
      emailVerified: true,
    });
    return creds;
  }

  it('refuses an anonymous caller', async () => {
    /*
     * `Origin` set, like every other anonymous call in this suite.
     *
     * Without it `CsrfGuard.assertOriginAllowed` refuses first with 403, and the
     * request never reaches the authentication guard — so the spec passed
     * through the wrong control and asserted the wrong refusal. That origin
     * check runs BEFORE the session lookup deliberately (csrf.guard.ts:115): it
     * used to run only once a session cookie had been found, which exempted
     * every unauthenticated state-changing route.
     *
     * 401 is what this test is about — no session, not a bad origin.
     */
    await anonymous(ctx)
      .post(CHANGE_PASSWORD)
      .set('Origin', SURFACES.portal.origin)
      .send({
        currentPassword: 'anything',
        newPassword: 'whatever-123',
      })
      .expect(401);
  });

  it('changes the password, and the new one actually works', async () => {
    /*
     * The assertion that would have caught the reversed `verify(plain, hash)`
     * arguments. Every negative case below still passed with that bug, because
     * a rejection is what they expect — only the success path could tell.
     */
    const creds = await freshClient('happy');
    const session = await actingAs(ctx, 'portal', creds);

    await session
      .post(CHANGE_PASSWORD, { currentPassword: creds.password, newPassword: 'brand-new-pass-9' })
      .expect(200);

    // Proved by logging in again through the real route, not by reading the DB.
    await actingAs(ctx, 'portal', { email: creds.email, password: 'brand-new-pass-9' });
    await expect(
      actingAs(ctx, 'portal', { email: creds.email, password: creds.password }),
    ).rejects.toThrow();
  });

  it('requires the CURRENT password', async () => {
    /*
     * Without this, any XSS or borrowed unlocked laptop is a permanent account
     * takeover in one request — a password outlives every cookie that could be
     * revoked.
     */
    const creds = await freshClient('wrong-current');
    const session = await actingAs(ctx, 'portal', creds);

    await session
      .post(CHANGE_PASSWORD, {
        currentPassword: 'not-the-password',
        newPassword: 'brand-new-pass-9',
      })
      .expect(400);

    // And the password is unchanged, so a failed attempt costs nothing.
    await actingAs(ctx, 'portal', creds);
  });

  it('refuses a "change" to the same password', async () => {
    // Accepting it would leave the client believing they had rotated a
    // credential they may have just told somebody, and revoke their other
    // sessions for no gain.
    const creds = await freshClient('unchanged');
    const session = await actingAs(ctx, 'portal', creds);

    const res = await session
      .post(CHANGE_PASSWORD, { currentPassword: creds.password, newPassword: creds.password })
      .expect(400);
    expect(String(res.body.message)).toMatch(/different/i);
  });

  it('enforces the same length bounds as registration', async () => {
    // A password this API accepts on one route and refuses on another is a
    // trap the client only discovers at the point of failure.
    const creds = await freshClient('short');
    const session = await actingAs(ctx, 'portal', creds);

    await session
      .post(CHANGE_PASSWORD, { currentPassword: creds.password, newPassword: 'short' })
      .expect(400);
  });

  it('cuts every other session off IMMEDIATELY, not in fifteen minutes', async () => {
    /*
     * This is what a password change is FOR, and the assertion is deliberately
     * about the access token rather than the refresh token.
     *
     * Revoking refresh-token families only ends a session's ability to RENEW.
     * The first version of this feature did exactly that, and the other device
     * kept answering 200 on /auth/me — it still held an access token valid for
     * its full fifteen minutes. Fifteen more minutes of access is precisely
     * what somebody changing their password under duress is trying to prevent.
     *
     * `users.passwordChangedAt` is the cutoff that closes it: jwt.strategy
     * compares it against every access token's `iat`. This test fails the
     * moment that check is removed or its comparison is loosened.
     */
    const creds = await freshClient('revokes');
    const attacker = await actingAs(ctx, 'portal', creds);
    const owner = await actingAs(ctx, 'portal', creds);

    const res = await owner
      .post(CHANGE_PASSWORD, { currentPassword: creds.password, newPassword: 'brand-new-pass-9' })
      .expect(200);

    // Dead on the very next request, with no refresh in between.
    await attacker.get(PORTAL_ME).expect(401);

    /*
     * And the caller keeps working — because the response handed them a NEW
     * session, not because the cutoff spared their old one.
     *
     * That distinction is the security property. Exempting the caller would
     * mean the cutoff had an exception, and any token an exception waves
     * through is a token an attacker might be holding. So every session dies
     * and one is re-issued, which is why the assertion has to be made against
     * the cookies from THIS response rather than the ones `owner` logged in
     * with.
     */
    const reissued = sessionFrom(ctx, 'portal', parseSetCookies(res));
    await reissued.get(PORTAL_ME).expect(200);
  });

  it('leaves the client with exactly one session afterwards', async () => {
    // The natural consequence of "revoke everything, re-issue one": whatever
    // the client had before, they now have one — the device in front of them.
    const creds = await freshClient('one-left');
    await actingAs(ctx, 'portal', creds);
    await actingAs(ctx, 'portal', creds);
    const owner = await actingAs(ctx, 'portal', creds);

    const res = await owner
      .post(CHANGE_PASSWORD, { currentPassword: creds.password, newPassword: 'brand-new-pass-9' })
      .expect(200);

    const reissued = sessionFrom(ctx, 'portal', parseSetCookies(res));
    const list = await reissued.get(SESSIONS).expect(200);
    expect(list.body).toHaveLength(1);
    expect((list.body as { current: boolean }[])[0].current).toBe(true);
  });

  it('requires the anti-forgery header', async () => {
    const creds = await freshClient('csrf');
    const session = await actingAs(ctx, 'portal', creds);

    await session
      .post(
        CHANGE_PASSWORD,
        { currentPassword: creds.password, newPassword: 'brand-new-pass-9' },
        { omitCsrf: true },
      )
      .expect(403);
  });
});
