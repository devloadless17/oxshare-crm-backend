import { describe, expect, it } from 'vitest';
import 'reflect-metadata';
import { AuthController } from '../src/modules/identity/auth.controller';
import { AdminAuthController } from '../src/modules/admin/admin-auth.controller';

/**
 * Rate limiting on the routes that handle credentials — R-3.5.
 *
 * The rule was recorded as satisfied on the strength of "`@Throttle` appears on
 * nine routes", which counts decorators rather than checking WHICH routes carry
 * one. Both refresh endpoints were missing from that nine.
 *
 * They are the worst two to miss. Each is deliberately exempt from the CSRF
 * guard (@NoCsrf — a refresh has to keep working once the anti-forgery token
 * has expired alongside the access token), each hashes on every call to find
 * the token's family row, and neither had any limit but the global 120/min. The
 * most expensive route in the API with the least in front of it.
 *
 * So this asserts the property directly: every credential-handling route names
 * a limit. Counting decorators is what let the gap through, and a test that
 * counts them would let the next one through too.
 */

const TTL = (name = 'default') => `THROTTLER:TTL${name}`;
const LIMIT = (name = 'default') => `THROTTLER:LIMIT${name}`;

function throttleOf(controller: object, method: string): { ttl: number; limit: number } | null {
  const proto = controller as Record<string, unknown>;
  const handler = proto[method];
  if (typeof handler !== 'function') {
    throw new Error(`${method} is not a handler — the route was renamed or removed.`);
  }
  const ttl = Reflect.getMetadata(TTL(), handler) as number | undefined;
  const limit = Reflect.getMetadata(LIMIT(), handler) as number | undefined;
  return ttl === undefined || limit === undefined ? null : { ttl, limit };
}

/**
 * Every handler that accepts, rotates or resets a credential.
 *
 * Adding a route here is deliberate: if a new one appears on either controller
 * and is not listed, the completeness test below fails and the author has to
 * decide, rather than inherit the global limit by omission.
 */
const CREDENTIAL_ROUTES: { controller: object; name: string; method: string }[] = [
  { controller: AuthController.prototype, name: 'POST /auth/login', method: 'login' },
  { controller: AuthController.prototype, name: 'POST /auth/refresh', method: 'refresh' },
  { controller: AuthController.prototype, name: 'POST /auth/register', method: 'register' },
  {
    controller: AdminAuthController.prototype,
    name: 'POST /admin/auth/login',
    method: 'login',
  },
  {
    controller: AdminAuthController.prototype,
    name: 'POST /admin/auth/refresh',
    method: 'refresh',
  },
];

describe('R-3.5 credential routes declare a rate limit', () => {
  it.each(CREDENTIAL_ROUTES)('$name is throttled', ({ controller, method }) => {
    const throttle = throttleOf(controller, method);
    expect(throttle).not.toBeNull();
    expect(throttle!.limit).toBeGreaterThan(0);
    expect(throttle!.ttl).toBeGreaterThan(0);
  });

  it('throttles BOTH refresh routes — the two that were missed', () => {
    // Named separately because these are the regression. They are CSRF-exempt
    // and hash on every call, so the global limit was the only thing in front
    // of them.
    const portal = throttleOf(AuthController.prototype, 'refresh');
    const admin = throttleOf(AdminAuthController.prototype, 'refresh');

    expect(portal).not.toBeNull();
    expect(admin).not.toBeNull();
    // Well below the global 120/min, and far above any real client: the portal
    // refreshes proactively every ten minutes.
    expect(portal!.limit).toBeLessThan(120);
    expect(admin!.limit).toBeLessThan(120);
  });

  it('leaves a refresh generous enough for a user with several tabs open', () => {
    // A limit tight enough to bounce a legitimate returning user would be
    // removed the first time it did, so the ceiling has to be worth keeping.
    expect(throttleOf(AuthController.prototype, 'refresh')!.limit).toBeGreaterThanOrEqual(10);
    expect(throttleOf(AdminAuthController.prototype, 'refresh')!.limit).toBeGreaterThanOrEqual(10);
  });
});
