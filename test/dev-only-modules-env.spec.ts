import { describe, expect, it } from 'vitest';
import { NODE_ENVIRONMENTS, validateEnv } from '../src/config/env.validation';

/**
 * What actually keeps the UNAUTHENTICATED fixtures routes off a deployed box.
 *
 * `AppModule` mounts `E2eFixturesModule` — `POST /e2e/fixtures/client` and
 * `POST /e2e/fixtures/review-pool`, both in `PUBLIC_ROUTES` — behind a denylist:
 *
 *     ...(process.env['NODE_ENV'] !== 'production' ? [E2eFixturesModule] : [])
 *
 * `main.ts` gates `runSeeds()`, which creates a known-password admin, the same
 * way. Read alone, that is the shape `admin-auth.service.ts` abandoned after a
 * denylist leaked an admin-minting invite token on staging: it "also matched
 * 'staging' and every typo", so environments must opt IN by being dev.
 *
 * ## Why the same shape is nevertheless safe here
 *
 * Because a second control closes it, and this file is that control's test.
 * `NODE_ENV` is a THREE-VALUE ENUM validated at boot, so a box set to anything
 * else does not serve the fixtures routes — it refuses to start at all. The
 * denylist decides what gets imported; the enum decides whether the process
 * lives. Verified by running it: `NODE_ENV=staging node dist/main` dies with
 * "Invalid environment configuration — refusing to start".
 *
 * Note the ordering, because it is counter-intuitive and does not weaken the
 * guarantee: the `imports` array is evaluated when the module file is IMPORTED,
 * before `ConfigModule` validates anything, so a staging process really does
 * construct `E2eFixturesModule` — and then never listens. Nothing is served.
 *
 * ## So what this file is really protecting
 *
 * The enum. The guarantee above is entirely a consequence of `NODE_ENV` having
 * exactly three legal values, and nothing else says so. Adding a fourth —
 * 'staging' being the obvious candidate, and the one a reader of
 * `env.validation.ts:395` might reach for, since it notes that a staging
 * deployment is `NODE_ENV=production` by necessity — would boot the fixtures
 * routes on that environment with no other test going red.
 *
 * That is why this asserts the accepted set rather than only the rejections.
 */

/**
 * The minimum that satisfies every OTHER rule, so each case fails on the
 * variable it is about rather than on a secret-length refusal underneath it.
 */
const base = () => ({
  ADMIN_JWT_SECRET: 'a'.repeat(40),
  ADMIN_JWT_REFRESH_SECRET: 'b'.repeat(40),
  JWT_ACCESS_SECRET: 'c'.repeat(40),
  JWT_REFRESH_SECRET: 'd'.repeat(40),
  STORAGE_DRIVER: 'disk',
});

/**
 * Everything production ADDITIONALLY requires, so that the only thing separating
 * a passing case from a failing one below is `NODE_ENV` itself.
 *
 * Production refuses development fallbacks by name — the same "silent downgrade"
 * refusal the storage driver and the bridge block make. Supplying them here is
 * not weakening the case: it is removing a second reason to throw, so a throw
 * can only mean the environment value was rejected.
 */
const productionExtras = () => ({
  DATABASE_URL: 'postgres://user:pass@db:5432/app',
  APP_ENCRYPTION_KEY: 'e'.repeat(64),
  PORTAL_URL: 'https://portal.example.com',
  ADMIN_URL: 'https://admin.example.com',
  MT5_BRIDGE_URL: 'https://bridge.internal:8443',
  MT5_BRIDGE_API_KEY: 'k'.repeat(32),
  MT5_BRIDGE_SECRET: 's'.repeat(32),
  // Deliberately explicit in production: the rate limiter, the RBAC-08 IP
  // allowlist and the audit trail all key on the address this resolves.
  TRUSTED_PROXY_HOPS: '1',
  // R2 is the only production object store — the disk driver is refused by name
  // rather than silently accepted (R-7.3).
  STORAGE_DRIVER: 'r2',
  R2_ACCOUNT_ID: 'account',
  R2_ACCESS_KEY_ID: 'access-key',
  R2_SECRET_ACCESS_KEY: 'secret-key',
  R2_BUCKET: 'bucket',
});

/** A complete, legal config for one environment. */
const envFor = (value: string) => ({
  ...base(),
  ...(value === 'production' ? productionExtras() : {}),
  NODE_ENV: value,
});

/** The only environments in which the dev-only modules may be constructed. */
const MOUNTS_DEV_ONLY_MODULES = ['development', 'test'] as const;
/** The environment in which they must not be. */
const PRODUCTION = 'production';

describe('NODE_ENV is a closed set, which is what makes the dev-only denylist safe', () => {
  it('accepts exactly the three legal environments and nothing else', () => {
    for (const value of [...MOUNTS_DEV_ONLY_MODULES, PRODUCTION]) {
      expect(() => validateEnv(envFor(value)), `${value} should boot`).not.toThrow();
    }
  });

  it.each([
    // The historical one. `admin-auth.service.ts` names this exact value as the
    // environment its denylist leaked a bearer token on.
    'staging',
    // A staging box someone spelled differently.
    'stage',
    'uat',
    'qa',
    'preprod',
    // Typos of the legal values — the other half of "and every typo".
    'Production',
    'PRODUCTION',
    'prod',
    'dev',
    'Development',
    '',
  ])('REFUSES to start on NODE_ENV=%j, so the fixtures routes never serve there', (value) => {
    expect(() => validateEnv(envFor(value))).toThrow(/NODE_ENV/);
  });

  it('defaults to development when unset, which is why local dev mounts them', () => {
    /*
     * Not an oversight — it is the reason `npm run dev` works without exporting
     * anything. It also means an unset NODE_ENV is NOT a way to reach a
     * production-shaped boot: the default is the most permissive environment,
     * so a deployment that forgets to set it fails the production-only rules
     * (DATABASE_URL, APP_ENCRYPTION_KEY, the bridge block) rather than quietly
     * serving with them relaxed.
     */
    const parsed = validateEnv({ ...base() }) as { NODE_ENV: string };
    expect(parsed.NODE_ENV).toBe('development');
  });

  it('pins the set itself, so a fourth environment cannot be added silently', () => {
    /*
     * The load-bearing assertion — and the one that was WRONG when this file
     * was first written, which is worth recording because it is the same defect
     * the suite exists to catch.
     *
     * The first version built a list by filtering the three values this spec
     * already names, then asserted the result equalled those three. That is a
     * tautology: it cannot observe a value it never tries. Adding 'staging' to
     * the enum and running it, it PASSED — while the `it.each` case above went
     * red and did the real work. A test that claims to pin a set and merely
     * restates it is decoration.
     *
     * So the set is IMPORTED rather than retyped, which is the convention
     * `admin-sort-indexes.spec.ts` states for the sort allowlists: "a hand-kept
     * list would need the same discipline it exists to replace". This now fails
     * on the one-word edit, whatever the fourth value is called — including the
     * ones nobody thought to add to the rejection list above.
     */
    expect([...NODE_ENVIRONMENTS]).toEqual(['development', 'test', 'production']);
  });
});
