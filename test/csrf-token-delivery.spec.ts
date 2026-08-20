import { describe, expect, it } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { CsrfEchoMiddleware } from '../src/common/security/csrf-echo.middleware';
import { CSRF_RESPONSE_HEADER, issueCsrfToken } from '../src/common/security/session-cookies';

/**
 * How the anti-forgery token REACHES the page.
 *
 * The double-submit needs the frontend to echo the token into a header, and it
 * used to get the value from `document.cookie`. That only works while the page
 * and the API share a hostname. They do on localhost — cookies ignore the PORT,
 * so :3001 and :3002 are one cookie host — and they do not in any real
 * deployment, where the browser calls the API directly (a Next rewrite cannot
 * proxy the realtime WebSocket upgrade) and the `__Host-` prefix locks the
 * cookie to the API's host.
 *
 * The result was a 403 on EVERY state-changing request in production, from a
 * mechanism that passes every test on a developer's machine. These pin the
 * second delivery path that closes it.
 */

function fakeResponse(): Response & {
  cookies: Record<string, string>;
  headers: Record<string, string>;
} {
  const cookies: Record<string, string> = {};
  const headers: Record<string, string> = {};
  return {
    cookies,
    headers,
    cookie(name: string, value: string) {
      cookies[name] = value;
      return this;
    },
    setHeader(name: string, value: string) {
      headers[name] = value;
      return this;
    },
  } as unknown as Response & { cookies: Record<string, string>; headers: Record<string, string> };
}

function requestFor(path: string, cookies: Record<string, string> = {}) {
  return { path, cookies } as unknown as Request;
}

const next: NextFunction = () => undefined;

describe('issueCsrfToken — the token is returned, not only set', () => {
  it('sets the cookie AND a header carrying the same value', () => {
    const res = fakeResponse();

    issueCsrfToken(res, '__Host-oxshare_crm_admin_csrf', 'nonce.signature', 1000);

    expect(res.cookies['__Host-oxshare_crm_admin_csrf']).toBe('nonce.signature');
    // The header is the only route to a page on a different host. If these two
    // ever disagree the guard's cookie-vs-header comparison refuses every write.
    expect(res.headers[CSRF_RESPONSE_HEADER]).toBe('nonce.signature');
  });
});

describe('CsrfEchoMiddleware — a cold load re-learns the token', () => {
  const middleware = new CsrfEchoMiddleware();

  it('returns the admin token on an admin route', () => {
    const res = fakeResponse();
    middleware.use(
      requestFor('/v1/admin/currencies/USDT', { '__Host-oxshare_crm_admin_csrf': 'admin-token' }),
      res,
      next,
    );

    expect(res.headers[CSRF_RESPONSE_HEADER]).toBe('admin-token');
  });

  it('returns the portal token on a portal route', () => {
    const res = fakeResponse();
    middleware.use(
      requestFor('/v1/auth/me', { '__Host-oxshare_crm_portal_csrf': 'portal-token' }),
      res,
      next,
    );

    expect(res.headers[CSRF_RESPONSE_HEADER]).toBe('portal-token');
  });

  it('chooses the surface by ROUTE, never by whichever cookie is present', () => {
    /*
     * The same reasoning as CsrfGuard.resolveSession: on localhost both apps
     * share one cookie jar, so "whichever cookie exists" would hand an admin
     * request the portal's token and produce a header that can never match.
     */
    const res = fakeResponse();
    middleware.use(
      requestFor('/v1/admin/currencies/USDT', { '__Host-oxshare_crm_portal_csrf': 'portal-token' }),
      res,
      next,
    );

    expect(res.headers[CSRF_RESPONSE_HEADER]).toBeUndefined();
  });

  it('reads the unprefixed spelling too, so plain-HTTP localhost still works', () => {
    const res = fakeResponse();
    middleware.use(
      requestFor('/v1/admin/clients', { oxshare_crm_admin_csrf: 'dev-token' }),
      res,
      next,
    );

    expect(res.headers[CSRF_RESPONSE_HEADER]).toBe('dev-token');
  });

  it('is case-insensitive about the admin prefix, as the guards are', () => {
    // `/v1/Admin/...` reached the admin controller while a case-sensitive test
    // went false — that is how the admin branch of CsrfGuard was once disarmed.
    const res = fakeResponse();
    middleware.use(
      requestFor('/v1/Admin/clients', { '__Host-oxshare_crm_admin_csrf': 'admin-token' }),
      res,
      next,
    );

    expect(res.headers[CSRF_RESPONSE_HEADER]).toBe('admin-token');
  });

  it('echoes nothing when the caller sent no token — it must not mint one', () => {
    const res = fakeResponse();
    middleware.use(requestFor('/v1/admin/clients', {}), res, next);

    expect(res.headers[CSRF_RESPONSE_HEADER]).toBeUndefined();
  });

  it('always calls next, so a request with no cookies is not stalled', () => {
    let called = false;
    middleware.use(requestFor('/v1/auth/login', {}), fakeResponse(), () => {
      called = true;
    });

    expect(called).toBe(true);
  });
});
