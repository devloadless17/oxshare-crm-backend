// The admin idle rule (12 Oct 2026), over real HTTP.
//
// The owner's rule: an administrator who does nothing on the console for the
// idle window signs in again. The console measures the idle age and reports it
// with each refresh; what is pinned here is that the SERVER ends the session on
// that report — the tokens die at "last activity + window", and a report past
// the window is refused and takes the access token with it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JwtService } from '@nestjs/jwt';
import { eq } from 'drizzle-orm';
import { ALL_PERMISSIONS } from './support/all-permissions';
import {
  actingAs,
  parseSetCookies,
  sessionFrom,
  startHttpTestApp,
  stopHttpTestApp,
  type HttpTestContext,
} from './http-setup';
import { PasswordService } from '../src/common/security/password.service';
import { admins, refreshTokens, roles } from '../src/database/schema';
import { COOKIE_BASES } from '../src/common/security/session-cookies';
import {
  ADMIN_IDLE_GRACE_MS,
  adminSessionLifetimes,
} from '../src/modules/admin/admin-session-lifetime';

const ADMIN = { email: 'idle-admin@oxshare.com', password: 'admin-password-123' };
const ADMIN_ME = '/v1/admin/auth/me';
const ADMIN_REFRESH = '/v1/admin/auth/refresh';

// The default: nothing in the test environment sets ADMIN_IDLE_TIMEOUT_MINUTES.
const WINDOW_MS = 15 * 60 * 1000;

let ctx: HttpTestContext;
let adminId: string;

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const [role] = await ctx.db.db
    .insert(roles)
    .values({ name: 'Idle Admin', description: 'Full access.', permissions: ALL_PERMISSIONS })
    .returning();
  const [row] = await ctx.db.db
    .insert(admins)
    .values({
      email: ADMIN.email,
      passwordHash: await new PasswordService().hash(ADMIN.password),
      name: 'Idle Admin',
      role: 'sub_admin',
      roleId: role.id,
      permissions: ALL_PERMISSIONS,
    })
    .returning();
  adminId = row.id;
}, 180_000);

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

/** Seconds until the newest live refresh row of this admin expires. */
async function liveRefreshSecondsLeft(): Promise<number> {
  const rows = await ctx.db.db
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.subjectId, adminId));
  const live = rows.filter((r) => !r.usedAt && !r.revokedAt);
  expect(live, 'exactly one live refresh token per session').toHaveLength(1);
  return (live[0].expiresAt.getTime() - Date.now()) / 1000;
}

const accessSecondsLeft = (token: string): number => {
  const { exp } = new JwtService({}).decode<{ exp: number }>(token);
  return exp - Date.now() / 1000;
};

describe('the arithmetic', () => {
  it('gives a fresh session the whole window, and an idle one what is left of it', () => {
    expect(adminSessionLifetimes(WINDOW_MS, 0)).toEqual({
      accessMs: 15 * 60 * 1000,
      refreshMs: WINDOW_MS + ADMIN_IDLE_GRACE_MS,
    });
    // Ten minutes idle: five left, plus the grace — and the access token may not
    // outlive the session it belongs to.
    expect(adminSessionLifetimes(WINDOW_MS, 600)).toEqual({
      accessMs: 6 * 60 * 1000,
      refreshMs: 6 * 60 * 1000,
    });
  });

  it('ends the session at the window, and never reads a missing report as idle', () => {
    expect(adminSessionLifetimes(WINDOW_MS, 900)).toBeNull();
    expect(adminSessionLifetimes(WINDOW_MS, 5000)).toBeNull();
    expect(adminSessionLifetimes(WINDOW_MS, undefined)?.refreshMs).toBe(
      WINDOW_MS + ADMIN_IDLE_GRACE_MS,
    );
    // A long window still keeps the fifteen-minute access token (R-3.3).
    expect(adminSessionLifetimes(12 * 60 * 60 * 1000, 0)?.accessMs).toBe(15 * 60 * 1000);
  });
});

describe('an admin session lives for "last activity + the idle window"', () => {
  it('signs in for the window, not for thirty days, and tells the console the number', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);

    const left = await liveRefreshSecondsLeft();
    expect(left).toBeGreaterThan(15 * 60);
    expect(left).toBeLessThanOrEqual(16 * 60);

    const me = await session.get(ADMIN_ME).expect(200);
    expect(me.body.idleTimeoutSeconds).toBe(900);

    await session.post('/v1/admin/auth/logout').expect(200);
  });

  it('shortens BOTH tokens to what the reported idle age leaves', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);

    const res = await session.post(ADMIN_REFRESH, { idleSeconds: 600 }).expect(200);
    const cookies = parseSetCookies(res);

    const refreshLeft = await liveRefreshSecondsLeft();
    expect(refreshLeft).toBeGreaterThan(5 * 60);
    expect(refreshLeft).toBeLessThanOrEqual(6 * 60);

    const accessLeft = accessSecondsLeft(cookies[COOKIE_BASES.adminAccess]);
    expect(accessLeft).toBeLessThanOrEqual(6 * 60 + 1);

    // …and the session it renewed still works.
    await sessionFrom(ctx, 'admin', cookies).get(ADMIN_ME).expect(200);
    await sessionFrom(ctx, 'admin', cookies).post('/v1/admin/auth/logout').expect(200);
  });

  it('a console from before the rule (no report) keeps renewing for the full window', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);

    const res = await session.post(ADMIN_REFRESH).expect(200);

    const left = await liveRefreshSecondsLeft();
    expect(left).toBeGreaterThan(15 * 60);
    await sessionFrom(ctx, 'admin', parseSetCookies(res)).post('/v1/admin/auth/logout').expect(200);
  });

  it('REFUSES a refresh reporting the whole window idle, and ends the access token with it', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);
    await session.get(ADMIN_ME).expect(200);

    const res = await session.post(ADMIN_REFRESH, { idleSeconds: 900 }).expect(401);
    expect(res.body.code).toBe('SESSION_REVOKED');

    // The access token had fourteen minutes left. It must not get to use them.
    await session.get(ADMIN_ME).expect(401);
    // And the refresh token cannot be tried again with a kinder number.
    await session.post(ADMIN_REFRESH, { idleSeconds: 0 }).expect(401);
  });

  it('refuses a report that is not a whole non-negative number', async () => {
    const session = await actingAs(ctx, 'admin', ADMIN);

    await session.post(ADMIN_REFRESH, { idleSeconds: -5 }).expect(400);
    await session.post(ADMIN_REFRESH, { idleSeconds: 'soon' }).expect(400);

    // Neither refusal spent the token.
    await session.post(ADMIN_REFRESH, { idleSeconds: 0 }).expect(200);
  });
});
