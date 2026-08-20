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
 *    Hence the full `oxshare_crm_<surface>_<kind>` shape: the product (`oxshare`),
 *    the SYSTEM (`crm` — OxShare runs other websites, and none of them should
 *    ever see or clash with a cookie belonging to this one), the surface
 *    (`admin` or `portal`, which are separate sessions per R-3.1), and the kind.
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
  adminAccess: () => name('oxshare_crm_admin_at'),
  adminRefresh: () => name('oxshare_crm_admin_rt'),
  clientAccess: () => name('oxshare_crm_portal_at'),
  clientRefresh: () => name('oxshare_crm_portal_rt'),
  /**
   * Readable by JS on purpose — an anti-forgery token, not a credential.
   *
   * ONE PER SURFACE, not one shared. Cookies are scoped by host and path and
   * **ignore the port**, so in development `localhost:3000` and `localhost:3002`
   * share a single cookie jar: a single `oxshare_csrf` meant logging into the
   * portal silently overwrote the admin app's token and vice versa. Separate
   * names also match R-3.1 — the two surfaces are meant to be entirely separate,
   * and an anti-forgery token is part of a session, not a global.
   */
  adminCsrf: () => name('oxshare_crm_admin_csrf'),
  portalCsrf: () => name('oxshare_crm_portal_csrf'),
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
  adminAccess: 'oxshare_crm_admin_at',
  adminRefresh: 'oxshare_crm_admin_rt',
  clientAccess: 'oxshare_crm_portal_at',
  clientRefresh: 'oxshare_crm_portal_rt',
  adminCsrf: 'oxshare_crm_admin_csrf',
  portalCsrf: 'oxshare_crm_portal_csrf',
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

/**
 * The response header the token is ALSO returned in.
 *
 * Same name as the request header the frontends send it back in, because it is
 * the same value travelling the other way. Listed in `exposedHeaders` in
 * main.ts — a response header a browser is not told to expose is invisible to
 * JS, with no error anywhere.
 */
export const CSRF_RESPONSE_HEADER = 'X-OxShare-CSRF';

/**
 * Issue the anti-forgery token: as a cookie, AND as a header the page can read.
 *
 * ── Why the header exists, when the cookie is already JS-readable ────────────
 *
 * `document.cookie` is scoped to the HOST of the page reading it, and the
 * `__Host-` prefix forbids a `Domain` attribute — so this cookie is locked to
 * the API's hostname. When the frontends call the API directly (which they must:
 * a Next rewrite cannot proxy the realtime WebSocket upgrade, see
 * admin/src/proxy.ts), the page is on a DIFFERENT host and cannot read it. It
 * then sends no `X-OxShare-CSRF` header and every write is refused with a 403 —
 * deterministically, on every state change, for every operator.
 *
 * That was invisible in development for the usual reason: cookies ignore the
 * PORT, so `localhost:3001` and `localhost:3002` are one cookie host and the
 * page could read it perfectly well.
 *
 * The header closes exactly that gap and nothing else. The SERVER side of the
 * double-submit is untouched — the cookie is still sent to the API (both hosts
 * are same-site, `SameSite=Lax`), so `CsrfGuard` still compares header against
 * cookie AND still verifies the token was minted for this session. This only
 * lets the client learn a value that was never secret from it: the cookie is
 * `httpOnly: false` by design, and a foreign origin cannot read this response
 * at all, because CORS only exposes it to the two allowlisted origins.
 */
export function issueCsrfToken(
  res: Response,
  cookieName: string,
  token: string,
  maxAgeMs: number,
): void {
  res.cookie(cookieName, token, csrfCookieOptions(maxAgeMs));
  res.setHeader(CSRF_RESPONSE_HEADER, token);
}

/**
 * Cookie names this system used BEFORE the R-3.2 migration.
 *
 * They must be actively deleted, not left to expire, and this is not cosmetic:
 * they were set with `httpOnly: false` and they hold real JWTs — an 8-hour
 * access token and a 30-day refresh token. Every browser that used the old build
 * is still carrying them, readable by any script on the origin, for up to 30
 * days after the deploy that was supposed to end exactly that exposure.
 *
 * Purging them on the next login or logout is what makes the migration actually
 * take effect for existing users rather than only for new ones.
 */
export const LEGACY_COOKIE_NAMES = [
  'access_token',
  'refresh_token',
  'admin_access_token',
  'admin_refresh_token',
  // Short-lived intermediate names from the first cut of this migration, before
  // the CSRF cookie was split per surface and before `crm` entered the name.
  'oxshare_csrf',
  'oxshare_admin_at',
  'oxshare_admin_rt',
  'oxshare_admin_csrf',
  'oxshare_portal_at',
  'oxshare_portal_rt',
  'oxshare_portal_csrf',
] as const;

/**
 * Deletes every superseded cookie this system has ever set.
 *
 * Called on login and on logout — the two moments a browser is guaranteed to be
 * talking to us and a stale credential is guaranteed to be worthless.
 */
export function clearLegacySessionCookies(res: Response): void {
  for (const legacy of LEGACY_COOKIE_NAMES) {
    // No attributes beyond path: these were written with varying flags, and a
    // clear only matches on name/path/domain. Path '/' is what all of them used.
    res.clearCookie(legacy, { path: '/' });
  }
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
