import { ALL_PERMISSIONS } from './support/all-permissions';
import { describe, expect, it } from 'vitest';
import { UNRESTRICTED } from '../src/common/security/client-scope';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import {
  isTokenKind,
  TOKEN_AUDIENCE,
  TOKEN_ISSUER,
  TOKEN_KIND,
} from '../src/common/security/token-audience';
import { AdminAuthenticator } from '../src/modules/admin/guards/admin.guard';
import { validateEnv } from '../src/config/env.validation';
import { COOKIE_BASES } from '../src/common/security/session-cookies';
import type { AdminsStore } from '../src/store/admins.store';
import type { RolesStore } from '../src/store/roles.store';

/**
 * Access tokens and refresh tokens are different things, and the system has to
 * be able to tell.
 *
 * THE DEFECT. The admin surface signs BOTH kinds with `ADMIN_JWT_SECRET`, with
 * the same `aud` and `iss`, and both carry `sub`. `AdminAuthenticator` verified
 * signature, audience and issuer, then read `sub` — so an admin **refresh**
 * token was a perfectly valid **access** token. A credential meant to live 30
 * days, and to be usable only at `/refresh` where rotation and `jti` reuse
 * detection watch it (R-3.3), could instead be replayed at any admin endpoint
 * for a month, bypassing all of that and leaving no trace.
 *
 * The portal never had the bug, because its refresh token is signed with a
 * different secret. That asymmetry — two secrets on one surface, one on the
 * other — is what exposed it.
 *
 * These are deliberately unit tests over the real signing/verifying code rather
 * than HTTP tests: they must run without Docker, because this is the kind of
 * check that has to stay cheap enough that nobody is tempted to skip it.
 */

const ADMIN_SECRET = 'admin-secret-at-least-32-characters-long';
const ACCESS_SECRET = 'access-secret-at-least-32-characters-long';
const REFRESH_SECRET = 'refresh-secret-at-least-32-chars-long';

const jwt = new JwtService({});

function adminToken(kind: 'access' | 'refresh' | 'unlabelled') {
  const payload: Record<string, unknown> = { sub: 'admin-1' };
  if (kind === 'access') {
    payload['typ'] = TOKEN_KIND.access;
    // The guard refuses an access token carrying no `fam`: it names the login,
    // and a token that cannot be tied to one is a token revocation cannot reach.
    payload['fam'] = 'family-1';
  }
  if (kind === 'refresh') {
    payload['jti'] = 'family-1';
    payload['typ'] = TOKEN_KIND.refresh;
  }
  return jwt.sign(payload, {
    secret: ADMIN_SECRET,
    expiresIn: kind === 'refresh' ? '30d' : '15m',
    audience: TOKEN_AUDIENCE.admin,
    issuer: TOKEN_ISSUER,
  });
}

function buildAuthenticator() {
  const config = {
    getOrThrow: (key: string) => {
      if (key === 'ADMIN_JWT_SECRET') return ADMIN_SECRET;
      throw new Error(`unexpected config key ${key}`);
    },
  };
  const admins = {
    findById: (id: string) =>
      Promise.resolve({
        id,
        email: 'admin@oxshare.com',
        name: 'Master Admin',
        passwordHash: 'x',
        role: 'master_admin' as const,
        permissions: ALL_PERMISSIONS,
        createdAt: new Date(),
      }),
  };
  const roles = {
    resolvePermissions: (_r: unknown, snapshot: string[]) => Promise.resolve(snapshot),
  };

  return new AdminAuthenticator(
    jwt,
    config as unknown as ConfigService,
    admins as unknown as AdminsStore,
    roles as unknown as RolesStore,
    { scopeFor: () => Promise.resolve(UNRESTRICTED) } as never,
    { expand: (m: readonly string[]) => [...m] } as never,
    // The `fam` revocation check. These specs are about token KIND confusion, so
    // the family is held alive rather than being silently absent.
    { familyIsRevoked: () => Promise.resolve(false) } as never,
    // No API key ever matches: these specs authenticate by cookie, and a stub
    // that could return a key would make the credential under test ambiguous.
    {
      findActiveByHash: () => Promise.resolve(null),
      touchLastUsed: () => Promise.resolve(),
    } as never,
  );
}

const requestWith = (token: string) =>
  ({ cookies: { [COOKIE_BASES.adminAccess]: token } }) as never;

describe('AdminAuthenticator — token kind', () => {
  it('accepts an access token', async () => {
    const admin = await buildAuthenticator().authenticate(requestWith(adminToken('access')));
    expect(admin.id).toBe('admin-1');
  });

  it('REGRESSION: refuses a refresh token presented as an access token', async () => {
    // Before the `typ` claim this resolved to a fully-authenticated master
    // admin: same secret, same audience, same issuer, and `sub` is all the
    // authenticator read. The whole 15-minute access-token lifetime was
    // decorative on this surface.
    await expect(
      buildAuthenticator().authenticate(requestWith(adminToken('refresh'))),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('refuses a token minted before the claim existed', async () => {
    // Strict on purpose. Accepting an unlabelled token would keep the hole open
    // for the full 30-day refresh lifetime; there are no production sessions to
    // protect, so the cost is a re-login.
    await expect(
      buildAuthenticator().authenticate(requestWith(adminToken('unlabelled'))),
    ).rejects.toThrow(UnauthorizedException);
  });
});

describe('the two surfaces cannot borrow each other s tokens', () => {
  it('an admin access token does not verify against the portal secret', () => {
    expect(() => {
      jwt.verify(adminToken('access'), {
        secret: ACCESS_SECRET,
        audience: TOKEN_AUDIENCE.portal,
        issuer: TOKEN_ISSUER,
      });
    }).toThrow();
  });

  it('a portal refresh token does not verify against the portal ACCESS secret', () => {
    // The portal's structural immunity to the bug above, pinned so that
    // collapsing the two secrets into one is a test failure and not a silent
    // regression to exactly what the admin surface was doing.
    const portalRefresh = jwt.sign(
      { sub: 'user-1', jti: 'f1', typ: TOKEN_KIND.refresh },
      {
        secret: REFRESH_SECRET,
        expiresIn: '30d',
        audience: TOKEN_AUDIENCE.portal,
        issuer: TOKEN_ISSUER,
      },
    );
    expect(() => {
      jwt.verify(portalRefresh, {
        secret: ACCESS_SECRET,
        audience: TOKEN_AUDIENCE.portal,
        issuer: TOKEN_ISSUER,
      });
    }).toThrow();
  });
});

describe('isTokenKind', () => {
  it('matches only the exact kind', () => {
    expect(isTokenKind({ typ: 'access' }, TOKEN_KIND.access)).toBe(true);
    expect(isTokenKind({ typ: 'refresh' }, TOKEN_KIND.access)).toBe(false);
  });

  it('treats a missing or non-string claim as no match', () => {
    for (const typ of [undefined, null, 1, true, {}, ['access']]) {
      expect(isTokenKind({ typ }, TOKEN_KIND.access)).toBe(false);
    }
  });
});

describe('env.validation — the four signing secrets', () => {
  const distinct = () => ({
    NODE_ENV: 'test',
    ADMIN_JWT_SECRET: 'a'.repeat(40),
    ADMIN_JWT_REFRESH_SECRET: 'b'.repeat(40),
    JWT_ACCESS_SECRET: 'c'.repeat(40),
    JWT_REFRESH_SECRET: 'd'.repeat(40),
  });

  it('accepts four distinct secrets', () => {
    expect(() => validateEnv(distinct())).not.toThrow();
  });

  it('refuses to start when two secrets share a value', () => {
    // The failure this exists for has no other symptom: the config validates,
    // meets the length minimum, and boots — with the separation it was supposed
    // to create silently gone.
    const reused = { ...distinct(), ADMIN_JWT_REFRESH_SECRET: 'a'.repeat(40) };
    expect(() => validateEnv(reused)).toThrow(/same value/);
  });

  it('names both offending variables, so the fix is obvious', () => {
    const reused = { ...distinct(), JWT_REFRESH_SECRET: 'c'.repeat(40) };
    expect(() => validateEnv(reused)).toThrow(/JWT_REFRESH_SECRET.*JWT_ACCESS_SECRET/s);
  });

  it('refuses a missing secret rather than falling back to a constant', () => {
    const { ADMIN_JWT_REFRESH_SECRET: _omitted, ...missing } = distinct();
    expect(() => validateEnv(missing)).toThrow(/ADMIN_JWT_REFRESH_SECRET/);
  });

  it('still refuses a secret shorter than 32 characters', () => {
    expect(() => validateEnv({ ...distinct(), JWT_ACCESS_SECRET: 'short' })).toThrow(
      /at least 32 characters/,
    );
  });
});
