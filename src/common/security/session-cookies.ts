import type { CookieOptions, Response } from 'express';

/**
 * Every session cookie this API sets, in one place.
 *
 * PLATFORM-CONVENTIONS §3.0 / R-3.2. OxShare runs many websites under one
 * registrable domain, and that single fact drives every decision in this file:
 *
 *  - `SameSite` is computed on the registrable domain, not the host. So
 *    `promo.oxshare.com` and `admin.oxshare.com` are the SAME SITE, and
 *    SameSite=Lax gives this API no protection whatsoever from another OxShare
 *    property. It is the floor, not the answer — the Origin check and the CSRF
 *    token in csrf.guard.ts are what actually separate them.
 *
 *  - Any page on any `*.oxshare.com` host can set a cookie with
 *    `Domain=.oxshare.com` that this API would then receive alongside its own,
 *    indistinguishable and in no guaranteed order ("cookie tossing"). The
 *    `__Host-` prefix is the answer, and it is the only one the BROWSER
 *    enforces rather than trusting us: a `__Host-` cookie is rejected unless it
 *    is Secure, Path=/ and carries no Domain, so a sibling site cannot create,
 *    overwrite or shadow one.
 *
 *  - Generic names collide. `access_token` is exactly what another OxShare app
 *    would call its own cookie, and two apps under one domain sharing a name is
 *    silent session corruption that only reproduces for users who visited both.
 *    Hence the `oxshare_` product prefix and the per-app suffix.
 *
 * The names are computed here rather than written as literals anywhere, because
 * `__Host-` requires Secure and therefore cannot be used on plain-HTTP
 * localhost. Two spellings of the same cookie is precisely the kind of thing
 * that drifts between a dev machine and production.
 */

/**
 * Whether this process can set `Secure` cookies — and therefore whether the
 * `__Host-` prefix is usable at all.
 *
 * Keyed on "is this localhost", NOT on NODE_ENV: a staging deployment running
 * over HTTPS with NODE_ENV=staging would otherwise ship session cookies with no
 * Secure flag, which is the one environment where that is most likely to go
 * unnoticed.
 */
export function isSecureContext(): boolean {
  const portal = process.env['PORTAL_URL'] ?? 'http://localhost:3000';
  const admin = process.env['ADMIN_URL'] ?? 'http://localhost:3002';
  return [portal, admin].every((url) => url.startsWith('https://'));
}

/** `__Host-` only when the browser would accept it. */
function name(base: string): string {
  return isSecureContext() ? `__Host-${base}` : base;
}

export const sessionCookieNames = {
  adminAccess: () => name('oxshare_admin_at'),
  adminRefresh: () => name('oxshare_admin_rt'),
  clientAccess: () => name('oxshare_portal_at'),
  clientRefresh: () => name('oxshare_portal_rt'),
  /** Readable by JS on purpose — it is an anti-forgery token, not a credential. */
  csrf: () => name('oxshare_csrf'),
};

/**
 * Reads a cookie under both spellings, preferring the prefixed one.
 *
 * A deploy that gains HTTPS changes the cookie NAME, so for one request the
 * browser may still be holding the unprefixed cookie from before. Accepting
 * both on read means that transition logs nobody out; only the prefixed name is
 * ever WRITTEN in a secure context, so the old one expires on its own.
 */
export function readSessionCookie(
  cookies: Record<string, string | undefined> | undefined,
  base: string,
): string | undefined {
  return cookies?.[`__Host-${base}`] ?? cookies?.[base];
}

export const COOKIE_BASES = {
  adminAccess: 'oxshare_admin_at',
  adminRefresh: 'oxshare_admin_rt',
  clientAccess: 'oxshare_portal_at',
  clientRefresh: 'oxshare_portal_rt',
  csrf: 'oxshare_csrf',
} as const;

/**
 * Options for a session credential.
 *
 * `httpOnly: true` is the change this file exists for. These cookies were
 * deliberately readable by JS so the frontends could attach a Bearer header —
 * which meant any XSS, any compromised transitive dependency and any browser
 * extension on either origin could read an 8-hour admin token and a 30-day
 * refresh token. The header was decorative anyway: AdminGuard has only ever
 * read the cookie.
 *
 * No `domain` key, deliberately and permanently: adding one is the only way a
 * CRM cookie could reach another OxShare site, and `__Host-` would make the
 * browser silently drop the cookie if anyone tried.
 */
export function sessionCookieOptions(maxAgeMs: number): CookieOptions {
  return {
    httpOnly: true,
    secure: isSecureContext(),
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeMs,
  };
}

/**
 * Options for the CSRF cookie: identical, except the page must be able to read
 * it to echo it back in a header. That is the whole double-submit mechanism, and
 * it is safe because the token is useless without a matching session — see
 * csrf.service.ts.
 */
export function csrfCookieOptions(maxAgeMs: number): CookieOptions {
  return { ...sessionCookieOptions(maxAgeMs), httpOnly: false };
}

/** Clearing must use the same attributes the cookie was set with, or the
 *  browser keeps it. `__Host-` is unforgiving about this. */
export function clearSessionCookie(res: Response, cookieName: string): void {
  res.clearCookie(cookieName, {
    httpOnly: true,
    secure: isSecureContext(),
    sameSite: 'lax',
    path: '/',
  });
  // Also clear the unprefixed spelling, so a host that has just gained HTTPS
  // does not leave a stale readable cookie behind after logout.
  if (cookieName.startsWith('__Host-')) {
    res.clearCookie(cookieName.slice('__Host-'.length), { path: '/' });
  }
}
