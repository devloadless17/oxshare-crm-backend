import { describe, expect, it } from 'vitest';
import { COOKIE_BASES, sessionCookieNames } from '../src/common/security/session-cookies';
import { CSRF_HEADER } from '../src/common/security/csrf.guard';

/**
 * The cross-repo cookie contract, pinned on the side that DEFINES it.
 *
 * ── The gap this closes ────────────────────────────────────────────────────
 *
 * This API computes its cookie names (`session-cookies.ts`). Both frontends
 * hardcode them as string literals, because they are separate repositories with
 * no shared package and nothing to import:
 *
 *   admin   `lib/api/client.ts`  → '__Host-oxshare_crm_admin_csrf' / 'oxshare_crm_admin_csrf'
 *           `proxy.ts`           → '__Host-oxshare_crm_admin_rt'   / 'oxshare_crm_admin_rt'
 *   portal  `lib/api/client.ts`  → '__Host-oxshare_crm_portal_csrf'/ 'oxshare_crm_portal_csrf'
 *           `proxy.ts`           → '__Host-oxshare_crm_portal_rt'  / 'oxshare_crm_portal_rt'
 *
 * Nothing connected the two. Renaming a cookie here would compile, pass every
 * test in this repo, deploy — and then log every user out of both apps with no
 * error anywhere pointing at the cause: the route gate would stop seeing a
 * session, the CSRF header would stop being attached, and every write would come
 * back 403 "failed anti-forgery validation".
 *
 * The generated OpenAPI types (R-1.2) do not help here, because a cookie name is
 * not part of any response body.
 *
 * ── What this does about it ────────────────────────────────────────────────
 *
 * It cannot make a separate repository recompile. What it CAN do is make the
 * rename fail HERE, loudly, with the list of files that must change with it —
 * turning a silent runtime break into a red build and a checklist. Each frontend
 * pins the same literals from its own side, so a change on either side fails on
 * that side.
 *
 * If these values ever need to change, the change is: this file, the two
 * frontends' `client.ts` and `proxy.ts`, and their matching specs — in one
 * coordinated deploy, backend first (R-8.1).
 */

describe('cookie names both frontends hardcode', () => {
  it('is exactly the set the frontends read', () => {
    expect(COOKIE_BASES).toEqual({
      adminAccess: 'oxshare_crm_admin_at',
      adminRefresh: 'oxshare_crm_admin_rt',
      clientAccess: 'oxshare_crm_portal_at',
      clientRefresh: 'oxshare_crm_portal_rt',
      adminCsrf: 'oxshare_crm_admin_csrf',
      portalCsrf: 'oxshare_crm_portal_csrf',
    });
  });

  it('gains a __Host- prefix under TLS, and the frontends read BOTH spellings', () => {
    /*
     * The name CHANGES when a deployment gains HTTPS, which is the property most
     * likely to surprise someone. Both frontends read the prefixed name first
     * and fall back to the bare one, so the transition logs nobody out — but only
     * because they know to. A third client that reads one spelling would work in
     * development and fail in production.
     */
    const secure = { PORTAL_URL: 'https://p.oxshare.com', ADMIN_URL: 'https://a.oxshare.com' };
    const previous = { PORTAL_URL: process.env['PORTAL_URL'], ADMIN_URL: process.env['ADMIN_URL'] };
    Object.assign(process.env, secure);
    try {
      expect(sessionCookieNames.adminRefresh()).toBe('__Host-oxshare_crm_admin_rt');
      expect(sessionCookieNames.portalCsrf()).toBe('__Host-oxshare_crm_portal_csrf');
    } finally {
      process.env['PORTAL_URL'] = previous.PORTAL_URL ?? '';
      process.env['ADMIN_URL'] = previous.ADMIN_URL ?? '';
    }
  });

  it('uses the bare names on plain-HTTP localhost, where __Host- cannot be set', () => {
    const previous = { PORTAL_URL: process.env['PORTAL_URL'], ADMIN_URL: process.env['ADMIN_URL'] };
    Object.assign(process.env, {
      PORTAL_URL: 'http://localhost:3000',
      ADMIN_URL: 'http://localhost:3002',
    });
    try {
      expect(sessionCookieNames.adminRefresh()).toBe('oxshare_crm_admin_rt');
    } finally {
      process.env['PORTAL_URL'] = previous.PORTAL_URL ?? '';
      process.env['ADMIN_URL'] = previous.ADMIN_URL ?? '';
    }
  });
});

describe('the anti-forgery header both frontends send', () => {
  it('is exactly the name they attach', () => {
    // Both apps set `X-OxShare-CSRF`. Express lower-cases incoming header names,
    // which is why this constant is lower-case and the frontends' is not — a
    // difference that looks like a bug and is not.
    expect(CSRF_HEADER).toBe('x-oxshare-csrf');
  });
});
