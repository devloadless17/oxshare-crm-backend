import { afterEach, describe, expect, it } from 'vitest';
import { adminNetworkAdmits, ipAllowlistEnforced } from '../src/common/security/admin-network';
import { isAdminSurface } from '../src/common/api-prefix';
import { ALERT_KINDS } from '../src/common/logging/alerts';

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

describe('an empty list cannot lock anybody out', () => {
  it('admits every caller while no rule exists (D-10)', () => {
    // The deploy that CREATES the table must not lock out every administrator
    // before anyone can add a rule. Enforcement begins with the first row.
    expect(adminNetworkAdmits([], '203.0.113.5')).toBe(true);
    expect(adminNetworkAdmits([], '::1')).toBe(true);
  });

  it('admits a caller whose address could not be determined, while empty', () => {
    // Unknown address + no rules is still "not configured", not a denial.
    expect(adminNetworkAdmits([], undefined)).toBe(true);
  });
});

describe('a configured list denies what it does not name', () => {
  it('admits an address inside a configured range', () => {
    expect(adminNetworkAdmits(['203.0.113.0/24'], '203.0.113.5')).toBe(true);
  });

  it('denies an address outside every range', () => {
    expect(adminNetworkAdmits(['203.0.113.0/24'], '198.51.100.9')).toBe(false);
  });

  it('DENIES an unknown address rather than failing open', () => {
    // Once somebody has said "only these addresses", admitting a caller we
    // cannot identify defeats the entire control.
    expect(adminNetworkAdmits(['203.0.113.0/24'], undefined)).toBe(false);
  });
});

describe('the way back in', () => {
  it('is ON by default — absent configuration enforces', () => {
    delete process.env['ADMIN_IP_ALLOWLIST_ENABLED'];
    expect(ipAllowlistEnforced()).toBe(true);
    expect(adminNetworkAdmits(['203.0.113.0/24'], '198.51.100.9')).toBe(false);
  });

  it('admits everyone when enforcement is switched off, rules and all', () => {
    /*
     * The recovery path this feature was missing. The lockout protections in the
     * service refuse the two rules that would lock you out AT THE MOMENT YOU
     * WRITE THEM; they cannot help with a dynamic address changing overnight or
     * a laptop moving office. Without this the only way back is a DELETE on the
     * table by somebody with database access, during an incident.
     */
    process.env['ADMIN_IP_ALLOWLIST_ENABLED'] = 'false';
    expect(adminNetworkAdmits(['203.0.113.0/24'], '198.51.100.9')).toBe(true);
    expect(adminNetworkAdmits(['203.0.113.0/24'], undefined)).toBe(true);
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

describe('an unreadable list cannot take the console down', () => {
  /*
   * The failure this feature was deleted over, reproduced and pinned.
   *
   * `IpAllowlistGuard` runs on EVERY admin request, including the login that
   * would let somebody fix it. When the table is missing — migrations pending,
   * a restored backup, `npm run dev` before `npm run db:migrate` — the query
   * throws. Without a catch every admin request answers 500, `POST
   * /admin/auth/login` included, and the console that manages the allowlist is
   * unreachable.
   *
   * A browser found this within a minute while all 1792 backend tests were
   * green: every one of them runs against a MIGRATED database, so none of them
   * models one that is behind.
   */
  it('admits the request when the store throws, rather than 500ing', async () => {
    const { IpAllowlistGuard } = await import('../src/modules/admin/guards/ip-allowlist.guard');
    const store = {
      listCidrs: () => Promise.reject(new Error('relation "admin_ip_allowlist" does not exist')),
    };
    const guard = new IpAllowlistGuard(store as never);

    const context = {
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => ({ path: '/v1/admin/auth/login', ip: '::1' }) }),
    };

    await expect(guard.canActivate(context as never)).resolves.toBe(true);
  });

  it('PAGES when it fails open, instead of failing open quietly', async () => {
    /*
     * The half the catch was missing, and the one its own comment already
     * demanded: "the log line is ERROR, not WARN, because a security control
     * that is not running is worth waking somebody for."
     *
     * An ERROR line wakes nobody. `RedisThrottlerStorage` makes the identical
     * fail-open argument and raises `SECURITY_CONTROL_DISABLED` at `page`; this
     * guard made the argument and stopped there — so RBAC-08 could be off across
     * the whole estate, admitting every admin request regardless of network,
     * with nothing but a log line among thousands to say so.
     *
     * Asserted on the ALERT PAYLOAD rather than on the prose, because the
     * payload is the machine-detectable half — `alert: true` and a kind from a
     * closed set are what a log pipeline can route on.
     */
    const { IpAllowlistGuard } = await import('../src/modules/admin/guards/ip-allowlist.guard');
    const store = {
      listCidrs: () => Promise.reject(new Error('relation "admin_ip_allowlist" does not exist')),
    };
    const guard = new IpAllowlistGuard(store as never);

    const logged: unknown[] = [];
    const logger = (guard as unknown as { logger: { error: (v: unknown) => void } }).logger;
    const original = logger.error.bind(logger);
    logger.error = (value: unknown) => {
      logged.push(value);
    };

    const context = {
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => ({ path: '/v1/admin/auth/login', ip: '::1' }) }),
    };

    try {
      await expect(guard.canActivate(context as never)).resolves.toBe(true);
    } finally {
      logger.error = original;
    }

    const alert = logged.find(
      (entry): entry is { alert: true; kind: string; severity: string } =>
        typeof entry === 'object' && entry !== null && 'alert' in entry,
    );

    expect(alert, 'failing open raised no alert — only a log line').toBeDefined();
    // The CONSTANT, not a string copy of it — a literal here would keep passing
    // if the kind were renamed, which is the drift the closed set exists to stop.
    expect(alert!.kind).toBe(ALERT_KINDS.SECURITY_CONTROL_DISABLED);
    // `page`, not `notify`: the control is off for every admin request in the
    // estate, and nothing else in the system will notice.
    expect(alert!.severity).toBe('page');
  });

  it('still enforces normally when the store answers', async () => {
    // The catch must not have become an unconditional pass.
    const { IpAllowlistGuard } = await import('../src/modules/admin/guards/ip-allowlist.guard');
    const guard = new IpAllowlistGuard({
      listCidrs: () => Promise.resolve(['203.0.113.0/24']),
    } as never);

    const context = {
      getType: () => 'http',
      switchToHttp: () => ({
        getRequest: () => ({ path: '/v1/admin/clients', ip: '198.51.100.9' }),
      }),
    };

    await expect(guard.canActivate(context as never)).rejects.toThrow(/not permitted/i);
  });
});
