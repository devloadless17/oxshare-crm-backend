import { afterEach, describe, expect, it } from 'vitest';
import {
  adminNetworkAdmits,
  ipAllowlistEnforced,
  resolveNetworkAccess,
} from '../src/common/security/admin-network';
import { isAdminSurface } from '../src/common/api-prefix';
import { ValidationError } from '../src/common/errors/domain-errors';

/**
 * RBAC-08 — the properties that stop this feature hurting anybody.
 *
 * ## Why this file exists at all
 *
 * The allowlist was deleted once because it caused problems in practice, and
 * the shape of that problem is inherent rather than a bug: a guard can only see
 * the address of whoever opened the socket. In development that is the Next.js
 * rewrite, so the API correctly reports `::1` while the operator is looking at
 * their own public address in a browser. A rule for the address they can see is
 * a rule the server can never match.
 *
 * Restoring the feature without addressing that would be re-introducing the
 * same trap. So every safety property is asserted here rather than trusted to
 * the comments that describe it, and each case says what it costs if it breaks.
 */

const ORIGINAL = process.env['ADMIN_IP_ALLOWLIST_ENABLED'];

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env['ADMIN_IP_ALLOWLIST_ENABLED'];
  else process.env['ADMIN_IP_ALLOWLIST_ENABLED'] = ORIGINAL;
});

const ANYWHERE = { accessAnywhere: true, allowedIps: [] };
const OFFICE = { accessAnywhere: false, allowedIps: ['203.0.113.0/24'] };

describe('an administrator who may connect from anywhere', () => {
  it('is admitted from every address, including one that cannot be determined', () => {
    expect(adminNetworkAdmits(ANYWHERE, '203.0.113.5')).toBe(true);
    expect(adminNetworkAdmits(ANYWHERE, '::1')).toBe(true);
    expect(adminNetworkAdmits(ANYWHERE, undefined)).toBe(true);
  });

  it('is the reading of a row that predates the column (and of an API key)', () => {
    // An identity with no setting at all — an API key, a row from before 0224 —
    // must not be locked out by a field nobody set.
    expect(adminNetworkAdmits({}, '198.51.100.9')).toBe(true);
  });
});

describe('a restricted administrator', () => {
  it('is admitted from inside one of their own ranges', () => {
    expect(adminNetworkAdmits(OFFICE, '203.0.113.5')).toBe(true);
  });

  it('is refused outside every one of their ranges', () => {
    expect(adminNetworkAdmits(OFFICE, '198.51.100.9')).toBe(false);
  });

  it('is REFUSED from an unknown address rather than failing open', () => {
    expect(adminNetworkAdmits(OFFICE, undefined)).toBe(false);
  });

  it('with no address at all is refused everywhere', () => {
    expect(adminNetworkAdmits({ accessAnywhere: false, allowedIps: [] }, '203.0.113.5')).toBe(
      false,
    );
  });
});

describe('what the invite and edit screens may store', () => {
  it('canonicalises, trims and de-duplicates', () => {
    expect(
      resolveNetworkAccess({
        accessAnywhere: false,
        allowedIps: [' 198.51.100.7 ', '10.0.0.5/8', '198.51.100.7', ''],
      }),
    ).toEqual({ accessAnywhere: false, allowedIps: ['198.51.100.7/32', '10.0.0.0/8'] });
  });

  it('clears the list when access is from anywhere', () => {
    expect(resolveNetworkAccess({ accessAnywhere: true, allowedIps: ['10.0.0.1'] })).toEqual({
      accessAnywhere: true,
      allowedIps: [],
    });
  });

  it('refuses a restricted administrator with no address', () => {
    expect(() => resolveNetworkAccess({ accessAnywhere: false, allowedIps: [' '] })).toThrow(
      ValidationError,
    );
  });

  it('refuses something that is not an address, and a /0 posing as one', () => {
    for (const bad of ['office', '300.1.1.1', '0.0.0.0/0', '10.0.0.1/0']) {
      expect(() => resolveNetworkAccess({ accessAnywhere: false, allowedIps: [bad] })).toThrow(
        ValidationError,
      );
    }
  });
});

describe('the way back in', () => {
  it('is ON by default — absent configuration enforces', () => {
    delete process.env['ADMIN_IP_ALLOWLIST_ENABLED'];
    expect(ipAllowlistEnforced()).toBe(true);
    expect(adminNetworkAdmits(OFFICE, '198.51.100.9')).toBe(false);
  });

  it('admits everyone when enforcement is switched off, addresses and all', () => {
    process.env['ADMIN_IP_ALLOWLIST_ENABLED'] = 'false';
    expect(adminNetworkAdmits(OFFICE, '198.51.100.9')).toBe(true);
    expect(adminNetworkAdmits(OFFICE, undefined)).toBe(true);
  });

  it('treats any value other than the exact string "false" as enabled', () => {
    // A typo must fail SAFE. `ADMIN_IP_ALLOWLIST_ENABLED=no` leaving the control
    // silently off is the opposite of what the operator intended.
    for (const value of ['no', '0', 'FALSE', 'off', '']) {
      process.env['ADMIN_IP_ALLOWLIST_ENABLED'] = value;
      expect(ipAllowlistEnforced()).toBe(true);
    }
  });
});

describe('nothing outside the admin surface is affected', () => {
  it('does not treat portal or public routes as admin', () => {
    // The portal is public by nature; an allowlist there would lock out the
    // customers the platform exists to serve.
    for (const path of [
      '/v1/auth/login',
      '/v1/kyc/status',
      '/v1/wallet',
      '/v1/dashboard',
      '/health',
      '/health/ready',
      '/v1/webhooks/mt5/deals',
    ]) {
      expect(isAdminSurface(path)).toBe(false);
    }
  });

  it('matches the admin surface through the version prefix and any casing', () => {
    // A literal `'/admin'` comparison against `req.path` is what silently
    // disarmed CsrfGuard when `/v1` was introduced, and later did the same to
    // this guard over a single uppercase letter.
    for (const path of ['/v1/admin/clients', '/admin/clients', '/v1/ADMIN/Clients']) {
      expect(isAdminSurface(path)).toBe(true);
    }
  });

  it('DOES claim a path merely starting with the same letters, on purpose', () => {
    /*
     * `/administrators` is not the admin surface and is matched anyway, because
     * `isAdminSurface` is prefix-based by design — see test/api-prefix.spec.ts,
     * which pins this deliberately.
     *
     * I tried to tighten this to a segment match while restoring RBAC-08 and
     * that test refused it, correctly. For a guard, over-matching is the
     * fail-safe direction: a route added at `/admin-tools` tomorrow that quietly
     * escaped CSRF and this allowlist is far worse than `/administrators` being
     * gated when it did not need to be. The rule is that a non-admin route must
     * be renamed rather than this loosened.
     */
    expect(isAdminSurface('/v1/administrators')).toBe(true);
  });
});
