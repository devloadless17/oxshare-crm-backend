import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, createHmac, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
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
import { admins, adminInvites, auditLog, loginAttempts, roles } from '../src/database/schema';
import { GoogleOauthConfig } from '../src/modules/admin/google/admin-google-auth.service';
import {
  GOOGLE_FETCH,
  GOOGLE_JWKS_URL,
  GOOGLE_TOKEN_URL,
} from '../src/modules/admin/google/google-oidc.client';
import {
  GOOGLE_FLOW_COOKIE_BASE,
  googleFlowKey,
  sealGoogleFlow,
} from '../src/modules/admin/google/google-flow-cookie';
import type { GoogleOauthSettings } from '../src/config/google-oauth';
import { COOKIE_BASES } from '../src/common/security/session-cookies';

/**
 * "Sign in with Google" for the admin console, over HTTP, against a FAKE
 * Google: the token endpoint and the JWKS are answered by `fakeFetch`, and ID
 * tokens are signed with an RSA key generated here. Everything else — the flow
 * cookie, state, PKCE, the full ID-token verification, account resolution,
 * the session — is the real code.
 */

const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const ADMIN_URL = SURFACES.admin.origin;
const KID = 'test-kid-1';

const SETTINGS: GoogleOauthSettings = {
  clientId: CLIENT_ID,
  clientSecret: 'test-secret-value',
  redirectUri: 'http://localhost:3001/v1/admin/auth/google/callback',
  allowedDomains: [],
  cookiePath: '/v1/admin/auth/google',
};
let settings: GoogleOauthSettings | null = SETTINGS;

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

function signToken(
  claims: Record<string, unknown>,
  opts: {
    header?: Record<string, unknown>;
    key?: KeyObject;
    hmac?: boolean;
    unsigned?: boolean;
  } = {},
): string {
  const header = { alg: 'RS256', kid: KID, typ: 'JWT', ...opts.header };
  const input = `${b64(header)}.${b64(claims)}`;
  if (opts.unsigned) return `${input}.`;
  if (opts.hmac)
    return `${input}.${createHmac('sha256', 'whatever').update(input).digest('base64url')}`;
  return `${input}.${sign('RSA-SHA256', Buffer.from(input), opts.key ?? privateKey).toString('base64url')}`;
}

/** What the fake token endpoint answers next. */
let tokenAnswer: (nonce: string) => { status: number; idToken?: string } = () => ({ status: 500 });
let lastTokenRequest: URLSearchParams | undefined;

// eslint-disable-next-line @typescript-eslint/require-await -- matches fetch's async signature
async function fakeFetch(url: string, init?: RequestInit): Promise<Response> {
  if (url === GOOGLE_JWKS_URL) {
    const jwk = publicKey.export({ format: 'jwk' });
    return new Response(
      JSON.stringify({ keys: [{ ...jwk, kid: KID, alg: 'RS256', use: 'sig' }] }),
      {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' },
      },
    );
  }
  if (url === GOOGLE_TOKEN_URL) {
    lastTokenRequest = new URLSearchParams(init?.body as string);
    const answer = tokenAnswer(currentNonce);
    if (answer.status !== 200) {
      return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: answer.status });
    }
    return new Response(JSON.stringify({ id_token: answer.idToken, token_type: 'Bearer' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }
  throw new Error(`unexpected fetch ${url}`);
}

let currentNonce = '';
let ctx: HttpTestContext;
const passwords = new PasswordService();
const MASTER = { email: 'g-master@bbcorp.trade', password: 'master-password-123' };

function claims(overrides: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    azp: CLIENT_ID,
    sub: 'google-sub-default',
    email: 'nobody@bbcorp.trade',
    email_verified: true,
    iat: now,
    exp: now + 3600,
    nonce: currentNonce,
    ...overrides,
  };
}

async function insertAdmin(
  email: string,
  permissions: string[],
  extra: Record<string, unknown> = {},
) {
  const [row] = await ctx.db.db
    .insert(admins)
    .values({
      email,
      passwordHash: await passwords.hash('some-password-123'),
      name: email.split('@')[0],
      role: 'sub_admin',
      permissions,
      status: 'active',
      ...extra,
    })
    .returning();
  return row;
}

interface Started {
  location: URL;
  flowCookie: string;
  state: string;
}

async function start(query = ''): Promise<Started> {
  const res = await anonymous(ctx).get(`/v1/admin/auth/google/start${query}`).expect(302);
  const location = new URL(res.headers.location);
  const flowCookie = parseSetCookies(res)[GOOGLE_FLOW_COOKIE_BASE];
  currentNonce = location.searchParams.get('nonce') ?? '';
  return { location, flowCookie, state: location.searchParams.get('state') ?? '' };
}

function callback(params: Record<string, string>, cookie?: string) {
  const req = anonymous(ctx).get(
    `/v1/admin/auth/google/callback?${new URLSearchParams(params).toString()}`,
  );
  if (cookie !== undefined) req.set('Cookie', `${GOOGLE_FLOW_COOKIE_BASE}=${cookie}`);
  return req;
}

/** start → Google answers with `idToken(nonce)` → callback. Returns the callback response. */
async function signIn(token: (nonce: string) => string, query = '') {
  const flow = await start(query);
  tokenAnswer = (nonce) => ({ status: 200, idToken: token(nonce) });
  return callback({ code: 'auth-code-1', state: flow.state }, flow.flowCookie).expect(302);
}

function googleError(res: { headers: Record<string, unknown> }): string | null {
  return new URL(res.headers.location as string).searchParams.get('google_error');
}

/** `AdminAuditService.record` is fire-and-forget, so its row lands just after the response. */
async function waitForAudit(action: string, subjectId: string) {
  for (let i = 0; i < 50; i++) {
    const rows = await ctx.db.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, action), eq(auditLog.subjectId, subjectId)));
    if (rows.length > 0) return rows;
    await new Promise((r) => setTimeout(r, 50));
  }
  return [];
}

beforeAll(async () => {
  ctx = await startHttpTestApp({
    overrides: [
      { token: GoogleOauthConfig, value: { settings: () => settings } },
      { token: GOOGLE_FETCH, value: fakeFetch },
    ],
  });
  const [masterRole] = await ctx.db.db
    .insert(roles)
    .values({ name: 'Google Master', permissions: ALL_PERMISSIONS, isSystem: true })
    .returning();
  await ctx.db.db.insert(admins).values({
    email: MASTER.email,
    passwordHash: await passwords.hash(MASTER.password),
    name: 'Google Master',
    role: 'master_admin',
    roleId: masterRole.id,
    permissions: ALL_PERMISSIONS,
    status: 'active',
  });
});

afterAll(async () => {
  await stopHttpTestApp(ctx);
});

beforeEach(() => {
  settings = SETTINGS;
});

describe('status and start', () => {
  it('reports whether Google sign-in is configured', async () => {
    const on = await anonymous(ctx).get('/v1/admin/auth/google/status').expect(200);
    expect(on.body).toEqual({ enabled: true });
    settings = null;
    const off = await anonymous(ctx).get('/v1/admin/auth/google/status').expect(200);
    expect(off.body).toEqual({ enabled: false });
  });

  it('sends a disabled start straight back to the console', async () => {
    settings = null;
    const res = await anonymous(ctx).get('/v1/admin/auth/google/start').expect(302);
    expect(res.headers.location).toBe(`${ADMIN_URL}/login?google_error=disabled`);
  });

  it('redirects to Google with every parameter, and a signed flow cookie behind it', async () => {
    settings = { ...SETTINGS, allowedDomains: ['bbcorp.trade'] };
    const res = await anonymous(ctx)
      .get('/v1/admin/auth/google/start?next=/clients&invite=')
      .expect(302);
    const url = new URL(res.headers.location);
    expect(`${url.origin}${url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const p = url.searchParams;
    expect(p.get('response_type')).toBe('code');
    expect(p.get('client_id')).toBe(CLIENT_ID);
    expect(p.get('redirect_uri')).toBe(SETTINGS.redirectUri);
    expect(p.get('scope')).toBe('openid email profile');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('prompt')).toBe('select_account');
    expect(p.get('hd')).toBe('bbcorp.trade');
    expect(p.get('state')).toMatch(/^[\w-]{43}$/);
    expect(p.get('nonce')).toMatch(/^[\w-]{43}$/);

    const raw = ([] as string[]).concat(res.headers['set-cookie'] as unknown as string[]);
    const header = raw.find((c) => c.startsWith(`${GOOGLE_FLOW_COOKIE_BASE}=`))!;
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=Lax/i);
    expect(header).toMatch(/Path=\/v1\/admin\/auth\/google(;|$)/);
    expect(header).toMatch(/Max-Age=600/);

    // The cookie holds the verifier whose S256 is the challenge Google got.
    const value = parseSetCookies(res)[GOOGLE_FLOW_COOKIE_BASE];
    const flow = JSON.parse(Buffer.from(value.split('.')[0], 'base64url').toString()) as {
      verifier: string;
      state: string;
      next: string;
      mode: string;
    };
    expect(createHash('sha256').update(flow.verifier).digest('base64url')).toBe(
      p.get('code_challenge'),
    );
    expect(flow.state).toBe(p.get('state'));
    expect(flow.next).toBe('/clients');
    expect(flow.mode).toBe('login');
  });

  it.each(['//evil.com', 'https://evil.com', '/\\evil.com', 'evil', '/\r\nSet-Cookie: x=1'])(
    'refuses %j as a landing path',
    async (next) => {
      const flow = await start(`?next=${encodeURIComponent(next)}`);
      const payload = JSON.parse(
        Buffer.from(flow.flowCookie.split('.')[0], 'base64url').toString(),
      ) as { next: string };
      expect(payload.next).toBe('/dashboard');
    },
  );

  it('keeps an invite token in the cookie and never sends it to Google', async () => {
    const flow = await start('?invite=secret-invite-token');
    expect(flow.location.toString()).not.toContain('secret-invite-token');
    const payload = JSON.parse(
      Buffer.from(flow.flowCookie.split('.')[0], 'base64url').toString(),
    ) as { mode: string; invite: string };
    expect(payload).toMatchObject({ mode: 'invite', invite: 'secret-invite-token' });
  });
});

describe('callback refusals', () => {
  it('reports a cancelled consent as cancelled, and clears the flow cookie', async () => {
    const flow = await start();
    const res = await callback(
      { error: 'access_denied', state: flow.state },
      flow.flowCookie,
    ).expect(302);
    expect(googleError(res)).toBe('cancelled');
    const cleared = ([] as string[]).concat(res.headers['set-cookie'] as unknown as string[]);
    expect(cleared.some((c) => c.startsWith(`${GOOGLE_FLOW_COOKIE_BASE}=;`))).toBe(true);
  });

  it('refuses a callback with no flow cookie', async () => {
    const flow = await start();
    expect(googleError(await callback({ code: 'c', state: flow.state }).expect(302))).toBe('state');
  });

  it('refuses a tampered flow cookie', async () => {
    const flow = await start();
    const [payload, mac] = flow.flowCookie.split('.');
    const forged = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<
      string,
      unknown
    >;
    forged.next = '/admin-users';
    const tampered = `${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${mac}`;
    expect(googleError(await callback({ code: 'c', state: flow.state }, tampered))).toBe('state');
  });

  it('refuses an expired flow', async () => {
    const key = googleFlowKey(process.env['ADMIN_JWT_SECRET']!);
    const expired = sealGoogleFlow(
      {
        state: 's',
        nonce: 'n',
        verifier: 'v',
        mode: 'login',
        next: '/dashboard',
        exp: Date.now() - 1,
      },
      key,
    );
    expect(googleError(await callback({ code: 'c', state: 's' }, expired))).toBe('expired');
  });

  it('refuses a state that does not match the cookie', async () => {
    const flow = await start();
    expect(googleError(await callback({ code: 'c', state: 'other' }, flow.flowCookie))).toBe(
      'state',
    );
  });

  it('reports a refused code exchange, having sent the PKCE verifier', async () => {
    const flow = await start();
    tokenAnswer = () => ({ status: 400 });
    const res = await callback({ code: 'bad-code', state: flow.state }, flow.flowCookie);
    expect(googleError(res)).toBe('exchange');
    expect(lastTokenRequest?.get('code_verifier')).toMatch(/^[\w-]{43}$/);
    expect(lastTokenRequest?.get('grant_type')).toBe('authorization_code');
    expect(lastTokenRequest?.get('redirect_uri')).toBe(SETTINGS.redirectUri);
  });

  const now = () => Math.floor(Date.now() / 1000);
  it.each<[string, (nonce: string) => string]>([
    ['alg none', () => signToken(claims(), { header: { alg: 'none' }, unsigned: true })],
    ['HS256', () => signToken(claims(), { header: { alg: 'HS256' }, hmac: true })],
    ['an unknown kid', () => signToken(claims(), { header: { kid: 'nope' } })],
    ['a bad signature', () => signToken(claims(), { key: otherKey })],
    ['a wrong issuer', () => signToken(claims({ iss: 'https://evil.example' }))],
    ['a wrong audience', () => signToken(claims({ aud: 'someone-else' }))],
    [
      'an audience array without our azp',
      () => signToken(claims({ aud: [CLIENT_ID, 'x'], azp: 'x' })),
    ],
    ['a foreign azp', () => signToken(claims({ azp: 'someone-else' }))],
    ['an expired token', () => signToken(claims({ exp: now() - 120 }))],
    ['a token issued in the future', () => signToken(claims({ iat: now() + 600 }))],
    ['a nonce mismatch', () => signToken(claims({ nonce: 'not-the-nonce' }))],
  ])('refuses %s as token', async (_label, token) => {
    expect(googleError(await signIn(token))).toBe('token');
  });

  it('refuses an unverified email', async () => {
    const res = await signIn(() => signToken(claims({ email_verified: false })));
    expect(googleError(res)).toBe('unverified_email');
  });

  it('applies the domain rule to hd AND the address', async () => {
    settings = { ...SETTINGS, allowedDomains: ['bbcorp.trade'] };
    expect(googleError(await signIn(() => signToken(claims({ email: 'a@gmail.com' }))))).toBe(
      'domain',
    );
    expect(
      googleError(
        await signIn(() => signToken(claims({ hd: 'bbcorp.trade', email: 'a@gmail.com' }))),
      ),
    ).toBe('domain');
    expect(
      googleError(await signIn(() => signToken(claims({ hd: 'other.com', email: 'a@other.com' })))),
    ).toBe('domain');
  });
});

describe('resolving the administrator', () => {
  it('links on the first sign-in, signs in by sub afterwards, and the session works', async () => {
    const admin = await insertAdmin('ada@bbcorp.trade', ['kyc.review', 'admins.view']);
    const res = await signIn(() =>
      signToken(claims({ sub: 'sub-ada', email: 'Ada@BBCorp.trade', hd: 'bbcorp.trade' })),
    );
    expect(res.headers.location).toBe(`${ADMIN_URL}/dashboard`);
    const jar = parseSetCookies(res);
    expect(jar[COOKIE_BASES.adminAccess]).toBeTruthy();
    expect(jar[COOKIE_BASES.adminRefresh]).toBeTruthy();
    expect(jar[GOOGLE_FLOW_COOKIE_BASE]).toBeUndefined();

    const [row] = await ctx.db.db.select().from(admins).where(eq(admins.id, admin.id));
    expect(row.googleSub).toBe('sub-ada');
    expect(row.googleEmail).toBe('ada@bbcorp.trade');
    expect(row.googleLinkedAt).toBeInstanceOf(Date);
    const links = await ctx.db.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, 'admin.google_link'), eq(auditLog.subjectId, admin.id)));
    expect(links).toHaveLength(1);

    // The landing is a cold load: /auth/me works on the cookies alone and
    // echoes the anti-forgery token, which then authorises a write.
    const session = sessionFrom(ctx, 'admin', jar);
    const me = await session.get('/v1/admin/auth/me').expect(200);
    expect(me.body).toMatchObject({ email: 'ada@bbcorp.trade', googleEmail: 'ada@bbcorp.trade' });
    expect(me.headers['x-oxshare-csrf']).toBe(jar[COOKIE_BASES.adminCsrf]);

    // Second sign-in: by sub, even though Google now reports another address.
    const again = await signIn(() =>
      signToken(claims({ sub: 'sub-ada', email: 'ada.l@bbcorp.trade' })),
    );
    expect(again.headers.location).toBe(`${ADMIN_URL}/dashboard`);
  });

  it('honours a safe next path on success', async () => {
    await insertAdmin('next@bbcorp.trade', ['kyc.review']);
    const res = await signIn(
      () => signToken(claims({ sub: 'sub-next', email: 'next@bbcorp.trade' })),
      `?next=${encodeURIComponent('/kyc?tab=2')}`,
    );
    expect(res.headers.location).toBe(`${ADMIN_URL}/kyc?tab=2`);
  });

  it('refuses an address already linked to a DIFFERENT Google account', async () => {
    await insertAdmin('linked@bbcorp.trade', ['kyc.review'], {
      googleSub: 'sub-original',
      googleEmail: 'linked@bbcorp.trade',
      googleLinkedAt: new Date(),
    });
    const res = await signIn(() =>
      signToken(claims({ sub: 'sub-imposter', email: 'linked@bbcorp.trade' })),
    );
    expect(googleError(res)).toBe('account_mismatch');
    expect(parseSetCookies(res)[COOKIE_BASES.adminAccess]).toBeUndefined();
  });

  it('refuses an unknown address, on a counter separate from the password lockout', async () => {
    const res = await signIn(() =>
      signToken(claims({ sub: 'sub-stranger', email: 'stranger@bbcorp.trade' })),
    );
    expect(googleError(res)).toBe('no_account');
    expect(new URL(res.headers.location).toString()).not.toContain('stranger');
    const rows = await ctx.db.db.select().from(loginAttempts);
    expect(rows.find((r) => r.identifier === 'google:stranger@bbcorp.trade')?.failures).toBe(1);
    expect(rows.find((r) => r.identifier === 'stranger@bbcorp.trade')).toBeUndefined();
  });

  it('refuses a suspended administrator without linking', async () => {
    const admin = await insertAdmin('gone@bbcorp.trade', ['kyc.review'], { status: 'suspended' });
    const res = await signIn(() =>
      signToken(claims({ sub: 'sub-gone', email: 'gone@bbcorp.trade' })),
    );
    expect(googleError(res)).toBe('suspended');
    const [row] = await ctx.db.db.select().from(admins).where(eq(admins.id, admin.id));
    expect(row.googleSub).toBeNull();
  });

  it('clears the link when the administrator email changes', async () => {
    const admin = await insertAdmin('mover@bbcorp.trade', ['kyc.review'], {
      googleSub: 'sub-mover',
      googleEmail: 'mover@bbcorp.trade',
      googleLinkedAt: new Date(),
    });
    await ctx.db.db.update(admins).set({ name: 'Renamed' }).where(eq(admins.id, admin.id));
    let [row] = await ctx.db.db.select().from(admins).where(eq(admins.id, admin.id));
    expect(row.googleSub).toBe('sub-mover');
    await ctx.db.db
      .update(admins)
      .set({ email: 'moved@bbcorp.trade' })
      .where(eq(admins.id, admin.id));
    [row] = await ctx.db.db.select().from(admins).where(eq(admins.id, admin.id));
    expect(row.googleSub).toBeNull();
    expect(row.googleEmail).toBeNull();
    expect(row.googleLinkedAt).toBeNull();
  });
});

describe('accepting an invite with Google', () => {
  async function invite(email: string) {
    const master = await actingAs(ctx, 'admin', MASTER);
    const [role] = await ctx.db.db
      .insert(roles)
      .values({ name: `Reviewer ${email}`, permissions: ['kyc.review', 'clients.view'] })
      .returning();
    const res = await master
      .post('/v1/admin/invite', { email, name: 'Invitee', roleId: role.id })
      .expect(201);
    return new URL((res.body as { inviteUrl: string }).inviteUrl).searchParams.get('token')!;
  }

  it('does NOT accept a pending invite without its link', async () => {
    await invite('pending@bbcorp.trade');
    const res = await signIn(() =>
      signToken(claims({ sub: 'sub-pending', email: 'pending@bbcorp.trade' })),
    );
    expect(googleError(res)).toBe('no_account');
  });

  it('creates the administrator with the invite permissions, claims it, and links Google', async () => {
    const token = await invite('newbie@bbcorp.trade');
    const res = await signIn(
      () => signToken(claims({ sub: 'sub-newbie', email: 'newbie@bbcorp.trade' })),
      `?invite=${token}`,
    );
    expect(res.headers.location).toBe(`${ADMIN_URL}/dashboard`);

    const me = await sessionFrom(ctx, 'admin', parseSetCookies(res))
      .get('/v1/admin/auth/me')
      .expect(200);
    const profile = me.body as { permissions: string[]; googleEmail: string; role: string };
    expect(profile.permissions.sort()).toEqual(['clients.view', 'kyc.review']);
    expect(profile.googleEmail).toBe('newbie@bbcorp.trade');
    expect(profile.role).toBe('sub_admin');

    const [inv] = await ctx.db.db
      .select()
      .from(adminInvites)
      .where(eq(adminInvites.email, 'newbie@bbcorp.trade'));
    expect(inv.accepted).toBe(true);
    const [created] = await ctx.db.db
      .select()
      .from(admins)
      .where(eq(admins.email, 'newbie@bbcorp.trade'));
    const [accepted] = await waitForAudit('admin.invite_accept', created.id);
    expect(accepted.actorEmail).toBe('newbie@bbcorp.trade');
    expect(accepted.details).toMatchObject({ method: 'google', email: 'newbie@bbcorp.trade' });
    expect(await waitForAudit('admin.google_link', created.id)).toHaveLength(1);

    // Spent: neither path can use the token again.
    await anonymous(ctx).get(`/v1/admin/invite/validate?token=${token}`).expect(400);
    await anonymous(ctx)
      .post('/v1/admin/invite/accept')
      .set('Origin', ADMIN_URL)
      .send({ token, password: 'another-password-1' })
      .expect(400);
  });

  it('refuses a Google address that is not the invited one, back on the invite screen', async () => {
    const token = await invite('right@bbcorp.trade');
    const res = await signIn(
      () => signToken(claims({ sub: 'sub-wrong', email: 'wrong@bbcorp.trade' })),
      `?invite=${token}`,
    );
    const url = new URL(res.headers.location);
    expect(`${url.origin}${url.pathname}`).toBe(`${ADMIN_URL}/invite/accept`);
    expect(url.searchParams.get('token')).toBe(token);
    expect(url.searchParams.get('google_error')).toBe('invite_email_mismatch');
  });

  it('refuses an invalid invite token', async () => {
    const res = await signIn(
      () => signToken(claims({ sub: 'sub-x', email: 'x@bbcorp.trade' })),
      '?invite=not-a-real-token',
    );
    expect(googleError(res)).toBe('invite_invalid');
  });
});

describe('unlinking', () => {
  it('lets an administrator unlink their own account (CSRF from the echoed header)', async () => {
    const admin = await insertAdmin('self@bbcorp.trade', ['kyc.review']);
    const res = await signIn(() =>
      signToken(claims({ sub: 'sub-self', email: 'self@bbcorp.trade' })),
    );
    const jar = parseSetCookies(res);
    const session = sessionFrom(ctx, 'admin', jar);
    const me = await session.get('/v1/admin/auth/me').expect(200);
    await session
      .del('/v1/admin/auth/me/google', { csrfToken: me.headers['x-oxshare-csrf'] })
      .expect(200);
    const after = await session.get('/v1/admin/auth/me').expect(200);
    expect(after.body).toMatchObject({ googleEmail: null, googleLinkedAt: null });
    expect(await waitForAudit('admin.google_unlink', admin.id)).toHaveLength(1);
    // Nothing linked any more.
    await session.del('/v1/admin/auth/me/google').expect(400);
  });

  it('lets admins.reset unlink another admin, but never one who outranks them', async () => {
    const target = await insertAdmin('target@bbcorp.trade', ['kyc.review'], {
      googleSub: 'sub-target',
      googleEmail: 'target@bbcorp.trade',
      googleLinkedAt: new Date(),
    });
    const resetter = await insertAdmin('resetter@bbcorp.trade', [
      'admins.reset',
      'admins.view',
      'kyc.review',
    ]);
    await ctx.db.db
      .update(admins)
      .set({ passwordHash: await passwords.hash('resetter-pass-123') })
      .where(eq(admins.id, resetter.id));
    const plain = await insertAdmin('plain@bbcorp.trade', ['kyc.review', 'admins.view']);
    await ctx.db.db
      .update(admins)
      .set({ passwordHash: await passwords.hash('plain-pass-1234') })
      .where(eq(admins.id, plain.id));

    const plainSession = await actingAs(ctx, 'admin', {
      email: 'plain@bbcorp.trade',
      password: 'plain-pass-1234',
    });
    await plainSession.del(`/v1/admin/users/${target.id}/google`).expect(403);

    const resetSession = await actingAs(ctx, 'admin', {
      email: 'resetter@bbcorp.trade',
      password: 'resetter-pass-123',
    });
    const [masterRow] = await ctx.db.db.select().from(admins).where(eq(admins.email, MASTER.email));
    await ctx.db.db
      .update(admins)
      .set({ googleSub: 'sub-master', googleEmail: MASTER.email, googleLinkedAt: new Date() })
      .where(eq(admins.id, masterRow.id));
    await resetSession.del(`/v1/admin/users/${masterRow.id}/google`).expect(403);
    await resetSession.del(`/v1/admin/users/${resetter.id}/google`).expect(400);

    await resetSession.del(`/v1/admin/users/${target.id}/google`).expect(200);
    const [row] = await ctx.db.db.select().from(admins).where(eq(admins.id, target.id));
    expect(row.googleSub).toBeNull();
    const audit = await waitForAudit('admin.google_unlink', target.id);
    expect(audit[0].actorId).toBe(resetter.id);

    // The master's own link survived the refused attempt, and they may clear it.
    const master = await actingAs(ctx, 'admin', MASTER);
    const listed = await master.get('/v1/admin/users').expect(200);
    const masterListed = (listed.body as { email: string; googleEmail: string | null }[]).find(
      (a) => a.email === MASTER.email,
    );
    expect(masterListed?.googleEmail).toBe(MASTER.email);
  });
});
