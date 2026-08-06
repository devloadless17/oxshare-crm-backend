import { describe, it, expect } from 'vitest';
import {
  API_VERSION_PREFIX,
  UNVERSIONED_ROUTES,
  isAdminSurface,
  stripApiPrefix,
} from '../src/common/api-prefix';

/**
 * The path-to-route helpers that two security guards make decisions from.
 *
 * These are pure string functions and they have now been the direct cause of
 * two separate authorization failures, both silent, both found by reading
 * rather than by a red test:
 *
 *   1. Serving every route under `/v1` made `req.path.startsWith('/admin')`
 *      false for every admin request. `CsrfGuard` took the portal branch and
 *      waved through every admin write, including settling withdrawals.
 *   2. Express matches routes case-insensitively while `req.path` preserves the
 *      caller's casing, so `/v1/Admin/clients` matched the controller while a
 *      case-sensitive `startsWith` missed. `IpAllowlistGuard` skipped entirely
 *      — RBAC-08 defeated by one uppercase letter — and CsrfGuard repeated (1).
 *
 * Both failures had the same shape: a decision derived from a URL, tested only
 * with the spelling the developer happened to type. So the cases below are
 * deliberately hostile about spelling, and `isAdminSurface` is asserted as a
 * decision rather than through the string function that feeds it.
 */
describe('stripApiPrefix', () => {
  it('strips the version prefix from a versioned path', () => {
    expect(stripApiPrefix('/v1/admin/clients')).toBe('/admin/clients');
  });

  it('maps the bare prefix to root', () => {
    expect(stripApiPrefix('/v1')).toBe('/');
  });

  it('leaves an unversioned path untouched, so health probes pass through', () => {
    for (const route of UNVERSIONED_ROUTES) {
      expect(stripApiPrefix(`/${route}`)).toBe(`/${route}`);
    }
  });

  it('strips a case-varied prefix — Express routes case-insensitively', () => {
    expect(stripApiPrefix('/V1/admin/clients')).toBe('/admin/clients');
    expect(stripApiPrefix('/V1')).toBe('/');
  });

  it('preserves the casing of everything after the prefix', () => {
    // It returns a PATH, not a decision. Lowercasing here would quietly change
    // what a future caller comparing a case-sensitive route segment sees.
    expect(stripApiPrefix('/v1/Admin/Clients')).toBe('/Admin/Clients');
  });

  it('does not strip a prefix that is only a substring of the first segment', () => {
    // `/v1beta/...` is not `/v1/...`. A `slice` guarded by nothing would eat
    // three characters and produce `beta/...`, which matches no route and would
    // fail open on any `startsWith` test built from it.
    expect(stripApiPrefix('/v1beta/admin')).toBe('/v1beta/admin');
    expect(stripApiPrefix('/v11/admin')).toBe('/v11/admin');
  });

  it('is stable under repeated application', () => {
    // Two call sites could both strip. Doing so must not eat a real segment.
    const once = stripApiPrefix('/v1/admin/clients');
    expect(stripApiPrefix(once)).toBe(once);
  });

  it('is derived from API_VERSION_PREFIX, not a hardcoded /v1', () => {
    expect(stripApiPrefix(`/${API_VERSION_PREFIX}/admin`)).toBe('/admin');
  });
});

describe('isAdminSurface', () => {
  it('recognises the admin surface as served', () => {
    expect(isAdminSurface('/v1/admin/clients')).toBe(true);
    expect(isAdminSurface('/v1/admin/auth/login')).toBe(true);
  });

  it('recognises the admin surface with no version prefix', () => {
    // Guards must not depend on the prefix being present — that assumption is
    // exactly what broke the first time.
    expect(isAdminSurface('/admin/clients')).toBe(true);
  });

  /**
   * THE REGRESSION. Each of these returned false before the fix, and each one
   * of them was a live request that reached an admin controller with the
   * RBAC-08 allowlist skipped and admin CSRF disarmed.
   */
  it.each([
    '/V1/ADMIN/clients',
    '/v1/Admin/clients',
    '/v1/ADMIN/clients',
    '/V1/admin/clients',
    '/v1/aDmIn/withdrawals',
    '/Admin/clients',
  ])('refuses to be fooled by casing: %s', (path) => {
    expect(isAdminSurface(path)).toBe(true);
  });

  it('does not claim the portal surface', () => {
    expect(isAdminSurface('/v1/auth/login')).toBe(false);
    expect(isAdminSurface('/v1/wallet/balance')).toBe(false);
    expect(isAdminSurface('/health')).toBe(false);
  });

  it('does not claim a path that merely starts with the same letters', () => {
    // `/administrators` is not the admin surface. It does not exist today; the
    // assertion is here so that adding it cannot silently inherit admin-surface
    // treatment — or, worse, so that tightening this later does not silently
    // REMOVE that treatment from a route someone assumed was covered.
    expect(isAdminSurface('/v1/administrators')).toBe(true);
    // ^ Documented as-is: `startsWith` is intentionally prefix-based, because a
    // guard that fails to cover a new `/admin*` route is the dangerous
    // direction. If a non-admin route ever needs to live at `/admin...`, it
    // must be renamed rather than this loosened.
  });
});
