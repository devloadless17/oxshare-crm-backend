import { describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { ForbiddenException } from '@nestjs/common';
import type { ArgumentsHost, ExecutionContext } from '@nestjs/common';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import type { Request } from 'express';
import { CsrfService } from '../src/common/security/csrf.service';
import { CsrfGuard, CSRF_HEADER } from '../src/common/security/csrf.guard';
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

const config = {
  get: (key: string) =>
    ({ ADMIN_JWT_SECRET: ADMIN_SECRET, PORTAL_URL: PORTAL, ADMIN_URL: ADMIN })[key],
} as unknown as ConfigService;

const jwt = new JwtService({});
const csrf = new CsrfService(config);

/** A reflector that reports no @NoCsrf, unless a reason is supplied. */
function reflectorWith(exemption?: string) {
  return { getAllAndOverride: () => exemption } as unknown as Reflector;
}

function guard(exemption?: string) {
  return new CsrfGuard(reflectorWith(exemption), csrf, jwt, config);
}

function adminToken(sub: string) {
  return jwt.sign({ sub }, { secret: ADMIN_SECRET, expiresIn: '8h' });
}

/** Builds an ExecutionContext around a fake request. */
function contextFor(req: Partial<Request> & { headers?: Record<string, string> }) {
  const headers = req.headers ?? {};
  const full = {
    method: 'POST',
    path: '/admin/withdrawals/w1/approve',
    originalUrl: '/admin/withdrawals/w1/approve',
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

  it('skips requests carrying no session cookie', () => {
    // Login, register, password reset: nothing to forge, because the browser has
    // no ambient authority to attach yet. This is what keeps the guard global
    // without a list of exempt paths to maintain.
    expect(guard().canActivate(contextFor({ cookies: {} }))).toBe(true);
  });

  it('skips the MT5 bridge, which has cookies from nobody and an HMAC of its own', () => {
    const ctx = contextFor({
      originalUrl: '/webhooks/mt5/deals',
      cookies: {},
      headers: { 'x-bridge-signature': 'abc' },
    });
    expect(guard().canActivate(ctx)).toBe(true);
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
    jwt.sign({ sub }, { secret: 'test-only-access-secret-never-used-outside-vitest' });

  it('lets an admin login through while a portal session is present', () => {
    const ctx = contextFor({
      path: '/admin/auth/login',
      originalUrl: '/admin/auth/login',
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
      path: '/admin/withdrawals/w1/approve',
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
      path: '/admin/withdrawals/w1/approve',
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
