/**
 * The admin sign-in's second factor (0191): an authenticator app — Google
 * Authenticator or any RFC 6238 app — REQUIRED for every administrator.
 *
 * Driven through the real routes against real Postgres. `actingAs` completes
 * the authenticator step for every other spec; this one drives it by hand, so
 * each refusal is asserted where it happens: no session on a password alone,
 * no session on a wrong or replayed code, no swapping a confirmed app, the
 * shared lockout, the reset and who may do it, and the invite path.
 *
 * Codes are computed from the secret the setup route returned — exactly what
 * the phone does with the QR code it scanned.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { ALL_PERMISSIONS } from './support/all-permissions';
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
import { admins, auditLog, loginAttempts, roles } from '../src/database/schema';
import { totpCode, totpStepAt } from '../src/common/security/totp';
import { COOKIE_BASES } from '../src/common/security/session-cookies';

const PASSWORD = 'totp-password-123';
const MASTER = { email: 'totp-master@oxshare.com', password: PASSWORD };
const PEER = { email: 'totp-peer@oxshare.com', password: PASSWORD };
const JUNIOR = { email: 'totp-junior@oxshare.com', password: PASSWORD };

let ctx: HttpTestContext;
const ids: Record<string, string> = {};

beforeAll(async () => {
  ctx = await startHttpTestApp();
  const passwords = new PasswordService();
  const hash = await passwords.hash(PASSWORD);
  const [masterRole] = await ctx.db.db
    .insert(roles)
    .values({ name: 'TOTP Master', permissions: ALL_PERMISSIONS, isSystem: true })
    .returning();
  for (const [key, who, perms] of [
    ['master', MASTER, ALL_PERMISSIONS],
    ['peer', PEER, ALL_PERMISSIONS],
    ['junior', JUNIOR, ['kyc.review', 'admins.view']],
  ] as const) {
    const [row] = await ctx.db.db
      .insert(admins)
      .values({
        email: who.email,
        passwordHash: hash,
        name: key,
        role: key === 'junior' ? 'sub_admin' : 'master_admin',
        roleId: key === 'junior' ? null : masterRole.id,
        permissions: [...perms],
        status: 'active',
      })
      .returning();
    ids[key] = row.id;
  }
});

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

const origin = SURFACES.admin.origin;

function login(who: { email: string; password: string }) {
  return anonymous(ctx).post('/v1/admin/auth/login').set('Origin', origin).send(who);
}
function setup(challengeToken: string) {
  return anonymous(ctx)
    .post('/v1/admin/auth/totp/setup')
    .set('Origin', origin)
    .send({ challengeToken });
}
function verify(challengeToken: string, code: string) {
  return anonymous(ctx)
    .post('/v1/admin/auth/totp/verify')
    .set('Origin', origin)
    .send({ challengeToken, code });
}
const codeNow = (secret: string, offset = 0) => totpCode(secret, totpStepAt(new Date()) + offset);

// supertest types every body as `any`. These name the two fields this file feeds
// back into the next request, so a renamed field fails to compile here instead of
// sending `undefined` as a challenge token or computing a code from it.
const tokenOf = (res: { body: unknown }) => (res.body as { challengeToken: string }).challengeToken;
const secretOf = (res: { body: unknown }) => (res.body as { secret: string }).secret;

/**
 * Codes are good for the CURRENT 30-second step only, so a request sent in a
 * step's last moments can land in the next one. Wait those out first, so no
 * test depends on which side of a boundary it happened to run.
 */
async function awayFromBoundary() {
  const intoStep = (Date.now() / 1000) % 30;
  if (intoStep > 26) await new Promise((r) => setTimeout(r, (30 - intoStep + 0.2) * 1000));
}

/**
 * "Thirty seconds later": pull the replay floor back one step, as the clock
 * moving on would. Enrolment spends the current step, and only the current
 * step's code is accepted, so without this a second sign-in inside the same
 * step would (correctly) be refused as a replay.
 */
async function nextPeriod(email: string) {
  await ctx.db.pool.query(
    'UPDATE admins SET totp_last_step = totp_last_step - 1 WHERE email = $1',
    [email],
  );
}

async function forget(email: string) {
  await ctx.db.pool.query(
    `UPDATE admins SET totp_secret = NULL, totp_pending_secret = NULL,
       totp_enabled_at = NULL, totp_last_step = NULL WHERE email = $1`,
    [email],
  );
  await ctx.db.db.delete(loginAttempts);
}

/** Password → setup → confirm; returns the secret the "phone" now holds. */
async function enrol(who: { email: string; password: string }) {
  await awayFromBoundary();
  const first = await login(who).expect(200);
  expect(first.body.step).toBe('totp_setup');
  const qr = await setup(tokenOf(first)).expect(200);
  await verify(tokenOf(first), codeNow(secretOf(qr))).expect(200);
  await nextPeriod(who.email);
  return secretOf(qr);
}

describe('a password alone is not a session', () => {
  it('answers a right password with a challenge and sets NO session cookie', async () => {
    await forget(MASTER.email);
    const res = await login(MASTER).expect(200);
    expect(res.body).toEqual({
      step: 'totp_setup',
      challengeToken: expect.any(String),
      expiresInSeconds: 600,
    });
    const jar = parseSetCookies(res);
    expect(Object.keys(jar).some((name) => name.includes(COOKIE_BASES.adminAccess))).toBe(false);
    expect(Object.keys(jar).some((name) => name.includes(COOKIE_BASES.adminRefresh))).toBe(false);
    expect(res.body).not.toHaveProperty('admin');
  });

  it('the challenge token cannot be used AS a session', async () => {
    await forget(MASTER.email);
    const { challengeToken } = (await login(MASTER).expect(200)).body as { challengeToken: string };
    const session = sessionFrom(ctx, 'admin', { [COOKIE_BASES.adminAccess]: challengeToken });
    await session.get('/v1/admin/auth/me').expect(401);
  });

  it('refuses a forged or garbage challenge', async () => {
    const res = await verify('not-a-token', '123456').expect(401);
    expect(res.body.message).toMatch(/sign-in has expired/i);
    await setup('not-a-token').expect(401);
  });

  it('a wrong password still says nothing about the authenticator', async () => {
    const res = await login({ email: MASTER.email, password: 'wrong-password' }).expect(401);
    expect(res.body).not.toHaveProperty('challengeToken');
  });
});

describe('enrolment — scan the QR code, confirm one code', () => {
  it('shows a QR code (SVG) and the otpauth URI the app reads', async () => {
    await forget(MASTER.email);
    const challengeToken = tokenOf(await login(MASTER).expect(200));
    const res = await setup(challengeToken).expect(200);
    expect(res.body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(res.body.qrSvg).toMatch(/^<svg[\s\S]*<\/svg>\s*$/);
    expect(res.body.otpauthUri).toBe(
      `otpauth://totp/${encodeURIComponent(`OxShare Admin:${MASTER.email}`)}?secret=${res.body.secret}` +
        '&issuer=OxShare+Admin&algorithm=SHA1&digits=6&period=30',
    );
    expect(res.body.account).toBe(MASTER.email);
  });

  it('stores the secret SEALED, never readable', async () => {
    await forget(MASTER.email);
    const challengeToken = tokenOf(await login(MASTER).expect(200));
    const secret = secretOf(await setup(challengeToken).expect(200));
    const { rows } = await ctx.db.pool.query(
      'SELECT totp_pending_secret, totp_secret FROM admins WHERE email = $1',
      [MASTER.email],
    );
    expect(rows[0].totp_pending_secret).toMatch(/^v1\./);
    expect(rows[0].totp_pending_secret).not.toContain(secret);
    expect(rows[0].totp_secret).toBeNull();
  });

  it('two setup calls at once show the SAME secret — the one stored', async () => {
    // A double render, a refresh or a double click races two setups. Each used to
    // write its own secret, so the QR code on screen could be the one the database
    // no longer held and every code was "not correct" (found by e2e, Oct 2026).
    await forget(MASTER.email);
    const challengeToken = tokenOf(await login(MASTER).expect(200));
    const answers = await Promise.all([1, 2, 3, 4].map(() => setup(challengeToken).expect(200)));
    const secrets = new Set(answers.map((a) => secretOf(a)));
    expect(secrets.size).toBe(1);
    await awayFromBoundary();
    const [only] = [...secrets];
    await verify(challengeToken, codeNow(only)).expect(200);
  });

  it('refuses a code before any QR code was shown', async () => {
    await forget(MASTER.email);
    const challengeToken = tokenOf(await login(MASTER).expect(200));
    await verify(challengeToken, '123456').expect(400);
  });

  it('a wrong code does not enrol and does not sign in', async () => {
    await forget(MASTER.email);
    const challengeToken = tokenOf(await login(MASTER).expect(200));
    const secret = secretOf(await setup(challengeToken).expect(200));
    const wrong = codeNow(secret) === '000000' ? '111111' : '000000';
    const res = await verify(challengeToken, wrong).expect(401);
    expect(res.body.message).toMatch(/code is not correct/i);
    expect(parseSetCookies(res)).toEqual({});
    const [row] = await ctx.db.db.select().from(admins).where(eq(admins.email, MASTER.email));
    expect(row.totpSecret).toBeNull();
  });

  it('shows the SAME QR code until it is confirmed — a reload or a new sign-in wastes no scan', async () => {
    await forget(MASTER.email);
    const first = tokenOf(await login(MASTER).expect(200));
    const scanned = secretOf(await setup(first).expect(200));
    // A reload of the setup screen…
    expect(secretOf(await setup(first).expect(200))).toBe(scanned);
    // …and "Back to sign in" then signing in again: still the QR already in the app.
    const second = tokenOf(await login(MASTER).expect(200));
    expect(secretOf(await setup(second).expect(200))).toBe(scanned);
    await verify(second, codeNow(scanned)).expect(200);
  });

  it('a right code confirms the app, starts the session and is audited', async () => {
    await forget(MASTER.email);
    const challengeToken = tokenOf(await login(MASTER).expect(200));
    const secret = secretOf(await setup(challengeToken).expect(200));
    const res = await verify(challengeToken, codeNow(secret)).expect(200);
    expect(res.body.admin.email).toBe(MASTER.email);
    expect(res.body.admin.totpEnabledAt).toEqual(expect.any(String));
    expect(JSON.stringify(res.body)).not.toMatch(/totpSecret|totp_secret|pendingSecret/);

    const session = sessionFrom(ctx, 'admin', parseSetCookies(res));
    const me = await session.get('/v1/admin/auth/me').expect(200);
    expect(me.body.totpEnabledAt).toEqual(expect.any(String));

    const rows = await ctx.db.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'admin.totp_enroll'), eq(auditLog.subjectId, ids.master)));
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe('every sign-in after enrolment — the code from the app', () => {
  it('asks for the code (no QR) and refuses to replace a confirmed app', async () => {
    await forget(MASTER.email);
    await enrol(MASTER);
    const next = await login(MASTER).expect(200);
    expect(next.body.step).toBe('totp');
    // A stolen password must not be enough to swap in the thief's phone.
    await setup(tokenOf(next)).expect(409);
  });

  it('signs in with the current code, and refuses the SAME code twice', async () => {
    await forget(MASTER.email);
    const secret = await enrol(MASTER);
    // The enrolment spent the current step; the next one is inside the window.
    await awayFromBoundary();
    const code = codeNow(secret);
    const a = tokenOf(await login(MASTER).expect(200));
    await verify(a, code).expect(200);
    const b = tokenOf(await login(MASTER).expect(200));
    const replay = await verify(b, code).expect(401);
    expect(parseSetCookies(replay)).toEqual({});
  });

  it('accepts a code with a space in the middle, as the apps display it', async () => {
    await forget(MASTER.email);
    const secret = await enrol(MASTER);
    const code = codeNow(secret);
    const challenge = tokenOf(await login(MASTER).expect(200));
    await verify(challenge, `${code.slice(0, 3)} ${code.slice(3)}`).expect(200);
  });

  it('NO grace window: the previous and the next code are both refused', async () => {
    await forget(MASTER.email);
    const secret = await enrol(MASTER);
    const challenge = tokenOf(await login(MASTER).expect(200));
    // The code the app showed a moment ago stops working when it changes.
    await verify(challenge, codeNow(secret, -1)).expect(401);
    await verify(challenge, codeNow(secret, 1)).expect(401);
    await verify(challenge, codeNow(secret, -10)).expect(401);
    await ctx.db.db.delete(loginAttempts);
    await verify(challenge, codeNow(secret)).expect(200);
  });

  it('rejects a malformed code at the DTO', async () => {
    const challenge = tokenOf(await login(MASTER).expect(200));
    await verify(challenge, 'abcdef').expect(400);
    await verify(challenge, '1234567').expect(400);
  });

  it('five wrong codes lock the account, like five wrong passwords', async () => {
    await forget(PEER.email);
    const secret = await enrol(PEER);
    const challenge = tokenOf(await login(PEER).expect(200));
    const wrong = codeNow(secret) === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) await verify(challenge, wrong).expect(401);
    // Locked: even the RIGHT code is refused, and so is the password.
    const locked = await verify(challenge, codeNow(secret)).expect(401);
    expect(locked.body.message).toMatch(/too many/i);
    await login(PEER).expect(401);
    await ctx.db.db.delete(loginAttempts);
  });

  it('a password success does NOT reset the code-failure counter', async () => {
    await forget(PEER.email);
    const secret = await enrol(PEER);
    const wrong = codeNow(secret) === '000000' ? '111111' : '000000';
    for (let round = 0; round < 2; round++) {
      const challenge = tokenOf(await login(PEER).expect(200));
      for (let i = 0; i < 3; i++) await verify(challenge, wrong);
    }
    // 6 wrong codes across two password sign-ins — locked, not reset.
    const res = await login(PEER).expect(401);
    expect(res.body.message).toMatch(/too many/i);
    await ctx.db.db.delete(loginAttempts);
  });

  it('a suspension between the password and the code is honoured', async () => {
    await forget(PEER.email);
    const secret = await enrol(PEER);
    const challenge = tokenOf(await login(PEER).expect(200));
    await ctx.db.db.update(admins).set({ status: 'suspended' }).where(eq(admins.id, ids.peer));
    await verify(challenge, codeNow(secret)).expect(403);
    await ctx.db.db.update(admins).set({ status: 'active' }).where(eq(admins.id, ids.peer));
  });
});

describe("resetting another administrator's authenticator (lost phone)", () => {
  it('a peer master resets it; the next sign-in shows a new QR code; audited', async () => {
    await forget(PEER.email);
    const peerSecretBeforeReset = await enrol(PEER);
    const master = await actingAs(ctx, 'admin', MASTER);
    const res = await master.post(`/v1/admin/users/${ids.peer}/totp/reset`).expect(200);
    expect(res.body.message).toMatch(/new one at their next sign-in/i);

    const before = await ctx.db.pool.query('SELECT totp_secret FROM admins WHERE id = $1', [
      ids.peer,
    ]);
    expect(before.rows[0].totp_secret).toBeNull();

    const next = await login(PEER).expect(200);
    expect(next.body.step).toBe('totp_setup');
    const qr = await setup(tokenOf(next)).expect(200);
    // A reset is a NEW app entry, never the old secret coming back.
    expect(secretOf(qr)).not.toBe(peerSecretBeforeReset);
    await verify(tokenOf(next), codeNow(secretOf(qr))).expect(200);

    const rows = await ctx.db.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'admin.totp_reset'), eq(auditLog.subjectId, ids.peer)));
    expect(rows).toHaveLength(1);
    expect(rows[0].actorId).toBe(ids.master);
  });

  it('nobody resets their OWN authenticator', async () => {
    const master = await actingAs(ctx, 'admin', MASTER);
    const res = await master.post(`/v1/admin/users/${ids.master}/totp/reset`).expect(400);
    expect(res.body.message).toMatch(/another administrator/i);
  });

  it('refuses without admins.reset', async () => {
    const junior = await actingAs(ctx, 'admin', JUNIOR);
    await junior.post(`/v1/admin/users/${ids.master}/totp/reset`).expect(403);
  });

  it('says so when the admin has no authenticator to reset', async () => {
    const master = await actingAs(ctx, 'admin', MASTER);
    await forget(JUNIOR.email);
    await master.post(`/v1/admin/users/${ids.junior}/totp/reset`).expect(400);
  });

  it('a reset does not touch the password or end sessions', async () => {
    const peer = await actingAs(ctx, 'admin', PEER);
    const master = await actingAs(ctx, 'admin', MASTER);
    await master.post(`/v1/admin/users/${ids.peer}/totp/reset`).expect(200);
    await peer.get('/v1/admin/auth/me').expect(200);
    await login(PEER).expect(200);
  });
});

describe('an invited administrator sets up the app before their first session', () => {
  it('accept → QR code → code → signed in', async () => {
    const master = await actingAs(ctx, 'admin', MASTER);
    const invited = await master
      .post('/v1/admin/invite', { email: 'totp-invitee@oxshare.com', name: 'Invitee' })
      .expect(201);
    const token = new URL(invited.body.inviteUrl as string).searchParams.get('token');

    const accepted = await anonymous(ctx)
      .post('/v1/admin/invite/accept')
      .set('Origin', origin)
      .send({ token, password: PASSWORD })
      .expect(200);
    expect(accepted.body.step).toBe('totp_setup');
    expect(accepted.body).not.toHaveProperty('admin');
    expect(
      Object.keys(parseSetCookies(accepted)).some((n) => n.includes(COOKIE_BASES.adminAccess)),
    ).toBe(false);

    const qr = await setup(tokenOf(accepted)).expect(200);
    const signedIn = await verify(tokenOf(accepted), codeNow(secretOf(qr))).expect(200);
    const session = sessionFrom(ctx, 'admin', parseSetCookies(signedIn));
    const me = await session.get('/v1/admin/auth/me').expect(200);
    expect(me.body.email).toBe('totp-invitee@oxshare.com');
  });
});

describe('migration 0191', () => {
  it('dropped every Google sign-in column', async () => {
    const { rows } = await ctx.db.pool.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'admins' AND column_name LIKE 'google%'`,
    );
    expect(rows).toEqual([]);
  });
});
