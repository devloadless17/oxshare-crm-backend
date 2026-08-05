import { describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { ForbiddenException } from '@nestjs/common';
import type { ArgumentsHost, ExecutionContext } from '@nestjs/common';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import type { Request } from 'express';
import { CsrfService } from '../src/common/security/csrf.service';
import { CsrfGuard, CSRF_HEADER, NO_ORIGIN_CHECK_KEY } from '../src/common/security/csrf.guard';
import { TOKEN_AUDIENCE, TOKEN_ISSUER } from '../src/common/security/token-audience';
import { API_VERSION_PREFIX } from '../src/common/api-prefix';
import type { Response } from 'express';
import {
  LEGACY_COOKIE_NAMES,
  clearLegacySessionCookies,
  isSecureContext,
  sessionCookieNames,
} from '../src/common/security/session-cookies';

/**
 * PLATFORM-CONVENTIONS §3.0 / R-3.6.
 *
 * OxShare runs many sites under one registrable domain, which makes
 * `SameSite=Lax` useless as a boundary between them: a sibling host is
 * same-site. These tests pin the two controls that DO separate them, and in
 * particular the cookie-tossing case — a sibling setting our CSRF cookie — that
 * a naive double-submit check would wave straight through.
 */

const ADMIN_SECRET = 'test-only-admin-secret-never-used-outside-vitest';
const PORTAL = 'http://localhost:3000';
const ADMIN = 'http://localhost:3002';

const ENV: Record<string, string> = {
  ADMIN_JWT_SECRET: ADMIN_SECRET,
  PORTAL_URL: PORTAL,
  ADMIN_URL: ADMIN,
};

const config = {
  get: (key: string) => ENV[key],
  // The production code reads secrets with getOrThrow — a fallback there could
  // only ever mask a wiring mistake. A stub offering only `get` would make this
  // spec fail for a reason that has nothing to do with what it tests.
  getOrThrow: (key: string) => {
    const value = ENV[key];
    if (value === undefined) throw new Error(`missing config: ${key}`);
    return value;
  },
} as unknown as ConfigService;

const jwt = new JwtService({});
const csrf = new CsrfService(config);

/**
 * A reflector that answers PER KEY, not one value for every question.
 *
 * It used to return the same reason for whatever it was asked, which was
 * harmless while `@NoCsrf` was the only decorator the guard read. It stopped
 * being harmless when `@NoOriginCheck` arrived: a stub that cannot tell the two
 * apart cannot express "exempt from the token check but NOT from the origin
 * check", which is exactly the distinction that closed login CSRF.
 */
function reflectorWith(exemptions: { noCsrf?: string; noOrigin?: string } = {}) {
  return {
    getAllAndOverride: (key: string) =>
      key === NO_ORIGIN_CHECK_KEY ? exemptions.noOrigin : exemptions.noCsrf,
  } as unknown as Reflector;
}

function guard(noCsrf?: string) {
  return new CsrfGuard(reflectorWith({ noCsrf }), csrf, jwt, config);
}

/** A guard for a route that has opted out of origin checking too — the bridge. */
function guardWithoutOriginCheck(reason: string) {
  return new CsrfGuard(reflectorWith({ noOrigin: reason, noCsrf: reason }), csrf, jwt, config);
}

/**
 * A token as the real admin surface mints it — including `aud`/`iss` (R-3.1).
 *
 * Without the claims the guard correctly declines to recognise it as a session
 * at all, so every "refuses X" assertion below would pass for the wrong reason.
 */
function adminToken(sub: string) {
  return jwt.sign(
    { sub },
    {
      secret: ADMIN_SECRET,
      expiresIn: '8h',
      audience: TOKEN_AUDIENCE.admin,
      issuer: TOKEN_ISSUER,
    },
  );
}

/**
 * A route as the server actually SERVES it.
 *
 * Built from `API_VERSION_PREFIX` rather than written out, because this file
 * previously hardcoded the pre-`/v1` paths. That made every case here exercise
 * a URL shape the application no longer served: the guard's admin-surface test
 * went false in production while these tests stayed green, and the CSRF check
 * was disarmed on every admin write for as long as nobody looked. A test that
 * writes its own copy of the thing it guards guards nothing.
 */
const served = (path: string) => `/${API_VERSION_PREFIX}${path}`;

/** Builds an ExecutionContext around a fake request. */
function contextFor(req: Partial<Request> & { headers?: Record<string, string> }) {
  const headers = req.headers ?? {};
  const full = {
    method: 'POST',
    path: served('/admin/withdrawals/w1/approve'),
    originalUrl: served('/admin/withdrawals/w1/approve'),
    cookies: {},
    headers,
    get: (name: string) => headers[name.toLowerCase()],
    ...req,
  } as unknown as Request;

  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => full }),
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
}

/** A well-formed, genuinely authorised request. */
function validRequest(sub = 'admin-1', overrides: Record<string, unknown> = {}) {
  const token = csrf.issue(sub);
  return contextFor({
    cookies: {
      [sessionCookieNames.adminAccess()]: adminToken(sub),
      [sessionCookieNames.adminCsrf()]: token,
    },
    headers: { origin: ADMIN, [CSRF_HEADER]: token },
    ...overrides,
  });
}

describe('CsrfService — the token proves which session it was minted for', () => {
  it('accepts a token for the subject it was issued to', () => {
    expect(csrf.verify('admin-1', csrf.issue('admin-1'))).toBe(true);
  });

  it('rejects a token minted for a DIFFERENT subject', () => {
    // The cookie-tossing case in miniature: an attacker can obtain a perfectly
    // valid token for their OWN session and plant it. Binding is what stops it
    // authorising anything on the victim's.
    expect(csrf.verify('victim', csrf.issue('attacker'))).toBe(false);
  });

  it('rejects a token the attacker simply made up', () => {
    expect(csrf.verify('admin-1', 'nonce.not-a-real-signature')).toBe(false);
    expect(csrf.verify('admin-1', 'no-separator')).toBe(false);
    expect(csrf.verify('admin-1', '.onlysig')).toBe(false);
    expect(csrf.verify('admin-1', 'onlynonce.')).toBe(false);
    expect(csrf.verify('admin-1', undefined)).toBe(false);
  });

  it('issues a distinct token every time, so one is never a stand-in for another', () => {
    const tokens = new Set(Array.from({ length: 20 }, () => csrf.issue('admin-1')));
    expect(tokens.size).toBe(20);
  });
});

describe('CsrfGuard — what it lets through', () => {
  it('allows a correctly formed request', () => {
    expect(guard().canActivate(validRequest())).toBe(true);
  });

  it('ignores reads entirely', () => {
    expect(guard().canActivate(contextFor({ method: 'GET' }))).toBe(true);
  });

  it('skips the TOKEN check for requests carrying no session cookie', () => {
    // Login, register, password reset: there is no anti-forgery token minted yet
    // to compare against, so the double-submit half cannot apply. The ORIGIN
    // half still does — see the login-CSRF block below — which is why this now
    // sends one.
    expect(guard().canActivate(contextFor({ cookies: {}, headers: { origin: ADMIN } }))).toBe(true);
  });

  it('skips the MT5 bridge, which has cookies from nobody and an HMAC of its own', () => {
    // The bridge is a server: no Origin to send and no cookie to abuse. It says
    // so explicitly with @NoOriginCheck rather than being skipped as a
    // side-effect of having no session, which is what used to exempt it.
    const ctx = contextFor({
      originalUrl: '/webhooks/mt5/deals',
      path: '/webhooks/mt5/deals',
      cookies: {},
      headers: { 'x-bridge-signature': 'abc' },
    });
    expect(guardWithoutOriginCheck('bridge authenticates with an HMAC').canActivate(ctx)).toBe(
      true,
    );
  });

  it('honours an explicit @NoCsrf exemption', () => {
    expect(
      guard('refresh rotates a session the caller already holds').canActivate(validRequest()),
    ).toBe(true);
  });

  it('treats an unverifiable session cookie as no session, leaving the 401 to the auth guard', () => {
    const ctx = contextFor({
      cookies: { [sessionCookieNames.adminAccess()]: 'not-a-jwt' },
      headers: { origin: ADMIN },
    });
    expect(guard().canActivate(ctx)).toBe(true);
  });
});

describe('CsrfGuard — login CSRF: origin is checked before a session exists', () => {
  /*
   * The hole this closes.
   *
   * `assertOriginAllowed` used to run only AFTER a session cookie had been
   * resolved, so every session-ESTABLISHING route was exempt by construction —
   * they have no cookie yet by definition. `@NoCsrf` on top made it total.
   *
   * The consequence is not abstract on a broker. An attacker's page POSTs to
   * `/auth/login` with THEIR credentials; the victim's browser is now signed
   * into the attacker's account, and the passport, selfie and proof of address
   * the victim uploads next land in the attacker's KYC submission — along with
   * any deposit they make.
   *
   * These pin that the check no longer depends on holding a session.
   */
  const loginContext = (headers: Record<string, string>) =>
    contextFor({
      path: served('/admin/auth/login'),
      originalUrl: served('/admin/auth/login'),
      cookies: {},
      headers,
    });

  it('refuses a login POST from an attacker origin', () => {
    expect(() => guard().canActivate(loginContext({ origin: 'https://evil.example' }))).toThrow(
      ForbiddenException,
    );
  });

  it('refuses a login POST that sends no Origin and no Referer at all', () => {
    expect(() => guard().canActivate(loginContext({}))).toThrow(ForbiddenException);
  });

  it('still admits a login POST from our own admin origin', () => {
    expect(guard().canActivate(loginContext({ origin: ADMIN }))).toBe(true);
  });

  it('still admits a registration POST from the portal origin', () => {
    const ctx = contextFor({
      path: served('/auth/register'),
      originalUrl: served('/auth/register'),
      cookies: {},
      headers: { origin: PORTAL },
    });
    expect(guard().canActivate(ctx)).toBe(true);
  });

  it('does not demand an anti-forgery TOKEN on login — there is none minted yet', () => {
    // The distinction that makes this safe to ship: origin is enforced, the
    // double-submit is not, so a first-time visitor with an empty cookie jar can
    // still sign in.
    const ctx = loginContext({ origin: ADMIN });
    expect(guard().canActivate(ctx)).toBe(true);
  });
});

describe('CsrfGuard — the admin surface is recognised at the path actually served', () => {
  /*
   * The regression, pinned at the exact seam that failed.
   *
   * `canActivate` returns true both when a request is properly authorised and
   * when there is nothing to protect, so "it returned true" proves nothing on
   * its own. What distinguishes the bug is WHICH branch ran: with the prefix
   * unaccounted for, an admin request was classified as portal traffic, no
   * portal cookie was found, and the guard concluded there was no ambient
   * authority to abuse — so a forged cross-origin approval sailed through.
   *
   * So the assertion is that a hostile origin on a real admin path is REFUSED.
   * That can only happen if the guard resolved an admin session, which it can
   * only do if it recognised the surface.
   */
  it('refuses a forged cross-origin admin write on the /v1 path', () => {
    const ctx = validRequest('admin-1', {
      path: served('/admin/withdrawals/w1/approve'),
      originalUrl: served('/admin/withdrawals/w1/approve'),
      headers: { origin: 'https://evil.example' },
    });
    expect(() => guard().canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('still recognises the admin surface if the prefix is ever removed', () => {
    // Not symmetry for its own sake: it keeps the guard correct through a
    // prefix change in either direction, which is how this broke the first time.
    const ctx = validRequest('admin-1', {
      path: '/admin/withdrawals/w1/approve',
      originalUrl: '/admin/withdrawals/w1/approve',
      headers: { origin: 'https://evil.example' },
    });
    expect(() => guard().canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('does not mistake a portal path for the admin surface', () => {
    // The other half of the branch. A portal session on a portal path must be
    // checked against the PORTAL cookie, not the admin one.
    const ctx = contextFor({
      path: served('/payments/withdrawals'),
      originalUrl: served('/payments/withdrawals'),
      cookies: { [sessionCookieNames.adminAccess()]: adminToken('admin-1') },
      headers: { origin: ADMIN },
    });
    // No portal cookie, so nothing to forge on this surface.
    expect(guard().canActivate(ctx)).toBe(true);
  });
});

describe('CsrfGuard — what it refuses', () => {
  const rejects = (ctx: ExecutionContext) =>
    expect(() => guard().canActivate(ctx)).toThrow(ForbiddenException);

  it('refuses a cross-site write from another origin entirely', () => {
    rejects(validRequest('admin-1', { headers: { origin: 'https://evil.example' } }));
  });

  it('refuses a SIBLING OxShare host — the case SameSite=Lax does not cover', () => {
    // The whole reason §3.0 exists. promo.oxshare.com is same-site as the admin
    // panel, so the browser attaches our cookies to its requests; only an exact
    // origin match keeps it out.
    rejects(validRequest('admin-1', { headers: { origin: 'https://promo.oxshare.com' } }));
  });

  it('refuses a look-alike domain that a suffix match would have allowed', () => {
    // `origin.endsWith('.oxshare.com')` would accept the first of these and a
    // regex on the domain would accept the second. Exact equality accepts neither.
    rejects(validRequest('admin-1', { headers: { origin: 'https://evil-oxshare.com' } }));
    rejects(validRequest('admin-1', { headers: { origin: 'https://oxshare.com.evil.net' } }));
  });

  it('refuses a write with neither Origin nor Referer rather than assuming the best', () => {
    const token = csrf.issue('admin-1');
    rejects(
      contextFor({
        cookies: {
          [sessionCookieNames.adminAccess()]: adminToken('admin-1'),
          [sessionCookieNames.adminCsrf()]: token,
        },
        headers: { [CSRF_HEADER]: token },
      }),
    );
  });

  it('accepts a matching Referer when Origin is absent', () => {
    const token = csrf.issue('admin-1');
    const ctx = contextFor({
      cookies: {
        [sessionCookieNames.adminAccess()]: adminToken('admin-1'),
        [sessionCookieNames.adminCsrf()]: token,
      },
      headers: { referer: `${ADMIN}/withdrawals`, [CSRF_HEADER]: token },
    });
    expect(guard().canActivate(ctx)).toBe(true);
  });

  it('refuses when the header is missing, even with a valid cookie', () => {
    const token = csrf.issue('admin-1');
    rejects(
      contextFor({
        cookies: {
          [sessionCookieNames.adminAccess()]: adminToken('admin-1'),
          [sessionCookieNames.adminCsrf()]: token,
        },
        headers: { origin: ADMIN },
      }),
    );
  });

  it('refuses a TOSSED cookie — the attack a naive double-submit would pass', () => {
    // A sibling host sets Domain=.oxshare.com cookies, so the attacker controls
    // BOTH halves of the comparison: cookie and header agree perfectly. What
    // they cannot do is compute an HMAC for the victim's session without the
    // server secret, so the binding check is what refuses this.
    const attackerToken = csrf.issue('attacker-admin');
    rejects(
      contextFor({
        cookies: {
          [sessionCookieNames.adminAccess()]: adminToken('victim-admin'),
          [sessionCookieNames.adminCsrf()]: attackerToken,
        },
        headers: { origin: ADMIN, [CSRF_HEADER]: attackerToken },
      }),
    );
  });

  it('refuses when the header does not match the cookie', () => {
    rejects(
      validRequest('admin-1', {
        headers: { origin: ADMIN, [CSRF_HEADER]: csrf.issue('admin-1') },
      }),
    );
  });
});

describe('session cookie naming (§3.0)', () => {
  it('uses plain names on http localhost, where __Host- cannot be set', () => {
    // __Host- requires Secure, which a plain-HTTP dev server cannot provide, so
    // the prefix has to be conditional — and computed in one place, never
    // written as a literal in two.
    expect(isSecureContext()).toBe(false);
    expect(sessionCookieNames.adminAccess()).toBe('oxshare_crm_admin_at');
    expect(sessionCookieNames.adminCsrf()).toBe('oxshare_crm_admin_csrf');
  });

  it('is app-unique, so it cannot collide with another OxShare site', () => {
    const names = Object.values(sessionCookieNames).map((f) => f());
    expect(new Set(names).size).toBe(names.length);
    // The old generic names are exactly what another OxShare app would pick.
    expect(names).not.toContain('access_token');
    expect(names).not.toContain('refresh_token');
  });
});

describe('AllExceptionsFilter — Postgres codes survive the ORM wrapping', () => {
  /*
   * A regression test for a silent failure the drizzle-orm 0.45 upgrade caused.
   *
   * The filter read `exception.code` directly. Drizzle 0.45 wraps driver errors
   * in its own `Failed query: …` Error and moves the original to `cause`, so the
   * wrapper has no `code` — and every unique violation and foreign-key violation
   * quietly became a 500 instead of a 409 or a 400. Nothing failed loudly.
   * Verified live before the fix: a duplicate role name answered 500, and a
   * malformed uuid in a path answered 500 with a full stack in the logs.
   */
  it('classifies a wrapped unique violation as a conflict, not a server error', () => {
    const filter = new AllExceptionsFilter();
    const wrapped = new Error('Failed query: insert into "roles" ...', {
      cause: Object.assign(new Error('duplicate key value'), { code: '23505' }),
    });

    // classify() is private; exercising it through the public catch() keeps the
    // test honest about what actually runs in production.
    const captured = captureResponse(filter, wrapped);
    expect(captured.status).toBe(409);
    expect(captured.body.code).toBe('CONFLICT');
  });

  it('classifies a wrapped malformed identifier as a bad request', () => {
    const filter = new AllExceptionsFilter();
    const wrapped = new Error('Failed query: update "transactions" ...', {
      cause: Object.assign(new Error('invalid input syntax for type uuid'), { code: '22P02' }),
    });

    const captured = captureResponse(filter, wrapped);
    expect(captured.status).toBe(400);
    expect(captured.body.code).toBe('INVALID_IDENTIFIER');
  });

  it('still treats a genuinely unexpected error as a 500', () => {
    const captured = captureResponse(new AllExceptionsFilter(), new TypeError('boom'));
    expect(captured.status).toBe(500);
    expect(captured.body.code).toBe('INTERNAL_ERROR');
    // And says nothing about what broke.
    expect(JSON.stringify(captured.body)).not.toContain('boom');
  });
});

/** Runs the filter against a stub response and returns what it wrote. */
function captureResponse(filter: AllExceptionsFilter, error: unknown) {
  const captured = { status: 0, body: {} as Record<string, unknown> };
  const res = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(body: Record<string, unknown>) {
      captured.body = body;
      return this;
    },
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => res,
      getRequest: () => ({ method: 'POST', url: '/admin/roles', id: 'test-request' }),
    }),
  } as unknown as ArgumentsHost;

  filter.catch(error, host);
  return captured;
}

describe('surfaces do not interfere with each other (§3.0, R-3.1)', () => {
  /*
   * The bug this pins, reported from a real browser session:
   *
   * Cookies are scoped by host and path and IGNORE the port, so on localhost the
   * portal (:3000) and the admin app (:3002) share one cookie jar. Log into the
   * portal, then open the admin login page, and the browser sends a PORTAL
   * session cookie to POST /admin/auth/login. The guard read that as "this
   * request is authenticated", demanded an anti-forgery token for a session with
   * nothing to do with the admin surface, and refused the login — locking the
   * developer out of the admin panel with an anti-forgery message that pointed
   * nowhere useful.
   *
   * Two changes fix it, and both are asserted here: the surface is chosen by the
   * ROUTE, and each surface has its OWN csrf cookie rather than sharing one that
   * each login silently overwrote.
   */
  const portalToken = (sub: string) =>
    jwt.sign(
      { sub },
      {
        secret: 'test-only-access-secret-never-used-outside-vitest',
        audience: TOKEN_AUDIENCE.portal,
        issuer: TOKEN_ISSUER,
      },
    );

  it('lets an admin login through while a portal session is present', () => {
    const ctx = contextFor({
      path: served('/admin/auth/login'),
      originalUrl: served('/admin/auth/login'),
      cookies: {
        [sessionCookieNames.clientAccess()]: portalToken('portal-user'),
        [sessionCookieNames.portalCsrf()]: csrf.issue('portal-user'),
      },
      headers: { origin: ADMIN },
    });
    expect(guard().canActivate(ctx)).toBe(true);
  });

  it('still protects an admin WRITE when an admin session is present', () => {
    const ctx = contextFor({
      path: served('/admin/withdrawals/w1/approve'),
      cookies: { [sessionCookieNames.adminAccess()]: adminToken('admin-1') },
      headers: { origin: ADMIN },
    });
    expect(() => guard().canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('will not accept the portal token for an admin write', () => {
    // Each surface reads its own cookie, so the portal's token is not even
    // consulted here — let alone accepted.
    const token = csrf.issue('admin-1');
    const ctx = contextFor({
      path: served('/admin/withdrawals/w1/approve'),
      cookies: {
        [sessionCookieNames.adminAccess()]: adminToken('admin-1'),
        [sessionCookieNames.portalCsrf()]: token,
      },
      headers: { origin: ADMIN, [CSRF_HEADER]: token },
    });
    expect(() => guard().canActivate(ctx)).toThrow(ForbiddenException);
  });

  it('gives each surface its own csrf cookie name', () => {
    expect(sessionCookieNames.adminCsrf()).not.toBe(sessionCookieNames.portalCsrf());
  });
});

describe('legacy cookie purge (R-3.2 migration)', () => {
  /*
   * Renaming the cookies is only half a migration. The OLD ones were set with
   * `httpOnly: false` and contain real JWTs — an 8-hour access token and a
   * 30-day refresh token — so every browser that used the previous build keeps
   * carrying a JS-readable session for up to 30 days after the deploy that was
   * meant to end exactly that exposure. They have to be deleted, not waited out.
   */
  it('names every superseded cookie this system has set', () => {
    expect(LEGACY_COOKIE_NAMES).toEqual(
      expect.arrayContaining([
        'access_token',
        'refresh_token',
        'admin_access_token',
        'admin_refresh_token',
      ]),
    );
  });

  it('never lists a name that is still in use', () => {
    // A purge entry that matches a live cookie would delete the session it just
    // created — on every single login.
    const live = Object.values(sessionCookieNames).map((f) => f());
    for (const legacy of LEGACY_COOKIE_NAMES) {
      expect(live).not.toContain(legacy);
    }
  });

  it('issues a deletion for each one', () => {
    const cleared: string[] = [];
    const res = {
      clearCookie(name: string) {
        cleared.push(name);
        return this;
      },
    } as unknown as Response;

    clearLegacySessionCookies(res);
    expect(cleared).toEqual([...LEGACY_COOKIE_NAMES]);
  });
});

describe('R-3.1 the two surfaces cannot be confused, even on a shared secret', () => {
  /*
   * The separation currently rests entirely on three environment variables
   * staying distinct. The day someone reuses one — a deploy script, a staging
   * shortcut, a rushed rotation — an admin token would silently verify on the
   * portal, and nothing anywhere would notice.
   *
   * `aud` makes that mistake produce a failed login instead of a privilege
   * escalation. These tests deliberately sign BOTH tokens with the SAME secret,
   * which is precisely the misconfiguration being defended against: only the
   * audience claim distinguishes them.
   */
  const SHARED = 'the-same-secret-on-both-surfaces-by-mistake';

  const tokenFor = (audience: string) =>
    jwt.sign({ sub: 'someone' }, { secret: SHARED, audience, issuer: TOKEN_ISSUER });

  const verifyAs = (token: string, audience: string) => () => {
    jwt.verify(token, { secret: SHARED, audience, issuer: TOKEN_ISSUER });
  };

  it('rejects an admin-audience token when the portal audience is required', () => {
    expect(verifyAs(tokenFor(TOKEN_AUDIENCE.admin), TOKEN_AUDIENCE.portal)).toThrow();
  });

  it('rejects a portal-audience token when the admin audience is required', () => {
    expect(verifyAs(tokenFor(TOKEN_AUDIENCE.portal), TOKEN_AUDIENCE.admin)).toThrow();
  });

  it('rejects a token minted by something else entirely', () => {
    // Right audience, no issuer — a token from another system that happens to
    // have picked the same audience string.
    const foreign = jwt.sign(
      { sub: 'someone' },
      { secret: SHARED, audience: TOKEN_AUDIENCE.admin },
    );
    expect(verifyAs(foreign, TOKEN_AUDIENCE.admin)).toThrow();
  });

  it('accepts the matching pair, so the claims are not simply breaking everything', () => {
    expect(verifyAs(tokenFor(TOKEN_AUDIENCE.admin), TOKEN_AUDIENCE.admin)).not.toThrow();
  });

  it('gives the two surfaces different audiences in the first place', () => {
    expect(TOKEN_AUDIENCE.admin).not.toBe(TOKEN_AUDIENCE.portal);
  });
});
