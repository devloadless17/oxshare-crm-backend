import { describe, expect, it } from 'vitest';
import { validateEnv } from '../src/config/env.validation';
import { resolveGoogleOauth } from '../src/config/google-oauth';
import { safeGoogleNext } from '../src/modules/admin/google/google-flow-cookie';
import { safeLogPath } from '../src/common/logging/redact';

/**
 * "Sign in with Google" configuration: off unless BOTH halves of the
 * credential are set, refused at boot when only one is, and https-only for
 * the redirect URI in production.
 */

const base = () => ({
  NODE_ENV: 'test',
  ADMIN_JWT_SECRET: 'a'.repeat(40),
  ADMIN_JWT_REFRESH_SECRET: 'b'.repeat(40),
  JWT_ACCESS_SECRET: 'c'.repeat(40),
  JWT_REFRESH_SECRET: 'd'.repeat(40),
  STORAGE_DRIVER: 'disk',
});

const production = () => ({
  ...base(),
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://user:pass@db:5432/app',
  APP_ENCRYPTION_KEY: 'e'.repeat(64),
  PORTAL_URL: 'https://portal.example.com',
  ADMIN_URL: 'https://admin.example.com',
  TRUSTED_PROXY_HOPS: '1',
  MT5_BRIDGE_URL: 'https://bridge.internal:8443',
  MT5_BRIDGE_API_KEY: 'k'.repeat(32),
  MT5_BRIDGE_SECRET: 's'.repeat(32),
  STORAGE_DRIVER: 'r2',
  R2_ACCOUNT_ID: 'acct',
  R2_ACCESS_KEY_ID: 'key',
  R2_SECRET_ACCESS_KEY: 'secret',
  R2_BUCKET: 'bucket',
});

const google = {
  GOOGLE_OAUTH_CLIENT_ID: 'id.apps.googleusercontent.com',
  GOOGLE_OAUTH_CLIENT_SECRET: 'GOCSPX-secret',
};

describe('Google sign-in configuration', () => {
  it('is off, and boots, when neither half is set', () => {
    expect(() => validateEnv(base())).not.toThrow();
    expect(resolveGoogleOauth(base()).status).toBe('disabled');
  });

  it('refuses to boot with the client id alone', () => {
    expect(() =>
      validateEnv({ ...base(), GOOGLE_OAUTH_CLIENT_ID: google.GOOGLE_OAUTH_CLIENT_ID }),
    ).toThrow(/GOOGLE_OAUTH_CLIENT_SECRET is missing/);
  });

  it('refuses to boot with the secret alone', () => {
    expect(() =>
      validateEnv({ ...base(), GOOGLE_OAUTH_CLIENT_SECRET: google.GOOGLE_OAUTH_CLIENT_SECRET }),
    ).toThrow(/GOOGLE_OAUTH_CLIENT_ID is missing/);
  });

  it('refuses to boot enabled with no redirect URI and no API_PUBLIC_URL', () => {
    expect(() => validateEnv({ ...base(), ...google })).toThrow(/no redirect URI/);
  });

  it('defaults the redirect URI from API_PUBLIC_URL', () => {
    const resolved = resolveGoogleOauth({ ...google, API_PUBLIC_URL: 'https://api.example.com/' });
    expect(resolved).toMatchObject({
      status: 'enabled',
      settings: {
        redirectUri: 'https://api.example.com/v1/admin/auth/google/callback',
        cookiePath: '/v1/admin/auth/google',
        allowedDomains: [],
      },
    });
  });

  it('parses the allowed domains and refuses a malformed one', () => {
    const ok = resolveGoogleOauth({
      ...google,
      API_PUBLIC_URL: 'https://api.example.com',
      GOOGLE_OAUTH_ALLOWED_DOMAINS: ' BBCorp.trade, example.com ,',
    });
    expect(ok.status === 'enabled' && ok.settings.allowedDomains).toEqual([
      'bbcorp.trade',
      'example.com',
    ]);
    expect(() =>
      validateEnv({
        ...base(),
        ...google,
        API_PUBLIC_URL: 'http://localhost:3001',
        GOOGLE_OAUTH_ALLOWED_DOMAINS: '@bbcorp.trade',
      }),
    ).toThrow(/not a domain name/);
  });

  it('refuses a redirect URI that is not the callback route', () => {
    expect(() =>
      validateEnv({ ...base(), ...google, GOOGLE_OAUTH_REDIRECT_URI: 'https://api.example.com/x' }),
    ).toThrow(/must end in \/admin\/auth\/google\/callback/);
  });

  it('refuses an http redirect URI in production, accepts https', () => {
    expect(() =>
      validateEnv({ ...production(), ...google, API_PUBLIC_URL: 'http://api.example.com' }),
    ).toThrow(/non-HTTPS Google redirect URI/);
    expect(() =>
      validateEnv({ ...production(), ...google, API_PUBLIC_URL: 'https://api.example.com' }),
    ).not.toThrow();
  });

  it('allows an http localhost redirect in development', () => {
    expect(() =>
      validateEnv({ ...base(), ...google, API_PUBLIC_URL: 'http://localhost:3001' }),
    ).not.toThrow();
  });
});

describe('safeGoogleNext', () => {
  it.each([
    ['/clients?tab=1', '/clients?tab=1'],
    ['//evil.com', '/dashboard'],
    ['https://evil.com', '/dashboard'],
    ['/\\evil.com', '/dashboard'],
    ['/ok\\x', '/dashboard'],
    ['', '/dashboard'],
    [undefined, '/dashboard'],
    [['/a'], '/dashboard'],
  ])('%j → %j', (raw, expected) => {
    expect(safeGoogleNext(raw)).toBe(expected);
  });
});

describe('the Google flow parameters never reach a log', () => {
  it('redacts code, state and invite on the Google routes only', () => {
    expect(safeLogPath('/v1/admin/auth/google/callback?code=abc&state=xyz&scope=email')).toBe(
      '/v1/admin/auth/google/callback?code=[REDACTED]&state=[REDACTED]&scope=email',
    );
    expect(safeLogPath('/v1/admin/auth/google/start?invite=tok&next=/x')).toBe(
      '/v1/admin/auth/google/start?invite=[REDACTED]&next=/x',
    );
    expect(safeLogPath('/v1/admin/transactions?state=pending')).toBe(
      '/v1/admin/transactions?state=pending',
    );
  });
});
