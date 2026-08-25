import { describe, expect, it } from 'vitest';
import { validateEnv } from '../src/config/env.validation';

/**
 * The bridge's address and its two secrets are CONFIG, and config is validated.
 *
 * ## Why this suite exists
 *
 * Nine `MT5_*` variables are read across this codebase and exactly one of them —
 * a cron expression — was declared in the schema. Everything that actually
 * connects the CRM to MT5 was unvalidated, so every way of getting it wrong
 * produced a clean boot and a runtime that quietly does less:
 *
 *   MT5_BRIDGE_URL missing     `isConfigured` is false, so every transfer is
 *                              left PENDING for ever and account creation has
 *                              nothing to call. One warn line per transfer.
 *   MT5_BRIDGE_SECRET missing  `BridgeSecretGuard` fails closed, so every push
 *                              is 401 — and the bridge treats 4xx on a snapshot
 *                              as PERMANENT and drops it.
 *
 * Neither says anything at boot. Both look exactly like a quiet trading day.
 * That is the same "silent downgrade" the STORAGE_DRIVER block refuses by name,
 * on a path that moves money instead of files.
 *
 * ## Why production and development differ on purpose
 *
 * Running the CRM without a bridge is a normal way to work on everything that is
 * not trading, and `TransferExecutor` has a documented, tested path for it. So
 * the variables stay optional in development and are refused in production —
 * the same split, for the same reason, as the storage driver.
 */

/**
 * A config that satisfies everything this file checks EXCEPT the thing each
 * case is about. Without the unrelated fields, a bridge assertion would pass or
 * fail on a secret-length refusal underneath it.
 */
const base = () => ({
  NODE_ENV: 'test',
  ADMIN_JWT_SECRET: 'a'.repeat(40),
  ADMIN_JWT_REFRESH_SECRET: 'b'.repeat(40),
  JWT_ACCESS_SECRET: 'c'.repeat(40),
  JWT_REFRESH_SECRET: 'd'.repeat(40),
  STORAGE_DRIVER: 'disk',
});

const bridge = () => ({
  MT5_BRIDGE_URL: 'https://bridge.internal:8443',
  MT5_BRIDGE_API_KEY: 'k'.repeat(32),
  MT5_BRIDGE_SECRET: 's'.repeat(32),
});

describe('the bridge variables are declared, so a typo is a boot failure', () => {
  it('accepts a complete, well-formed bridge block', () => {
    expect(() => validateEnv({ ...base(), ...bridge() })).not.toThrow();
  });

  it('refuses a MT5_BRIDGE_URL that is not an absolute URL', () => {
    /*
     * The realistic typo: a host and port with no scheme. `fetch` would reject
     * it at the first transfer, hours after the deploy, as "failed to parse
     * URL" in a log nobody is watching.
     */
    const env = { ...base(), ...bridge(), MT5_BRIDGE_URL: 'bridge.internal:8443' };
    expect(() => validateEnv(env)).toThrow(/MT5_BRIDGE_URL/);
  });

  it('refuses a short MT5_BRIDGE_SECRET', () => {
    /*
     * This secret is the ONLY authentication on an endpoint that writes deals to
     * the ledger. A placeholder like "changeme" satisfies "is a string" and
     * satisfies nothing else.
     */
    const env = { ...base(), ...bridge(), MT5_BRIDGE_SECRET: 'changeme' };
    expect(() => validateEnv(env)).toThrow(/MT5_BRIDGE_SECRET/);
  });

  it('refuses a non-numeric timeout', () => {
    const env = { ...base(), ...bridge(), MT5_BRIDGE_TIMEOUT_MS: '10s' };
    expect(() => validateEnv(env)).toThrow(/MT5_BRIDGE_TIMEOUT_MS/);
  });
});

describe('the bridge is optional in development and required in production', () => {
  it('starts without a bridge outside production', () => {
    /*
     * Deliberate: the CRM without a bridge is a working development
     * environment, and the unconfigured path is tested rather than accidental.
     */
    expect(() => validateEnv(base())).not.toThrow();
  });

  it('REFUSES to start in production with no bridge configured', () => {
    const env = {
      ...base(),
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://user:pass@db:5432/app',
      APP_ENCRYPTION_KEY: 'e'.repeat(64),
      PORTAL_URL: 'https://portal.example.com',
      ADMIN_URL: 'https://admin.example.com',
    };

    /*
     * Booting is the WORSE outcome here. A CRM that serves every screen and
     * cannot move a single unit of money to or from MT5 is indistinguishable
     * from a quiet day, and the transfers pile up `pending` while it looks
     * healthy.
     */
    expect(() => validateEnv(env)).toThrow(/MT5_BRIDGE_URL/);
  });

  it('names EVERY missing bridge variable at once, not just the first', () => {
    /*
     * An operator fixing a production boot should not have to redeploy three
     * times to discover three missing variables.
     */
    const env = {
      ...base(),
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://user:pass@db:5432/app',
      APP_ENCRYPTION_KEY: 'e'.repeat(64),
      PORTAL_URL: 'https://portal.example.com',
      ADMIN_URL: 'https://admin.example.com',
      MT5_BRIDGE_URL: 'https://bridge.internal:8443',
    };

    let message = '';
    try {
      validateEnv(env);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toMatch(/MT5_BRIDGE_API_KEY/);
    expect(message).toMatch(/MT5_BRIDGE_SECRET/);
  });
});
