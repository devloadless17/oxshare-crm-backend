import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { AuthService } from '../src/modules/identity/auth.service';
import { PasswordService } from '../src/common/security/password.service';
import { CsrfService } from '../src/common/security/csrf.service';
import type { EmailService } from '../src/modules/email/email.service';
import type { RefreshTokensService } from '../src/common/security/refresh-tokens.service';
import type { User, UsersStore } from '../src/store/users.store';
import {
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  ValidationError,
} from '../src/common/errors/domain-errors';

/**
 * AuthService — the portal's front door, and until now untested.
 *
 * `register`, `verifyEmail`, `login` and `logout` had no behavioural coverage at
 * all: `refresh-reuse.spec.ts` covered rotation, `password-reset.spec.ts`
 * covered reset, and everything else was exercised only incidentally through
 * other suites' fixtures. These are the paths every client passes through.
 *
 * Unit tests over real service code with substituted collaborators — they run
 * without Docker, so they stay cheap enough that nobody skips them. The HTTP
 * behaviour of the same routes is proven separately in auth-http.spec.ts.
 */

const SECRETS: Record<string, string> = {
  ADMIN_JWT_SECRET: 'admin-secret-at-least-32-characters-long',
  JWT_ACCESS_SECRET: 'access-secret-at-least-32-characters-long',
  JWT_REFRESH_SECRET: 'refresh-secret-at-least-32-chars-long!',
  PORTAL_URL: 'http://localhost:3000',
  ADMIN_URL: 'http://localhost:3002',
};

const config = {
  get: (key: string) => SECRETS[key],
  getOrThrow: (key: string) => {
    const value = SECRETS[key];
    if (value === undefined) throw new Error(`missing config: ${key}`);
    return value;
  },
} as unknown as ConfigService;

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'user-1',
    email: 'client@oxshare.com',
    passwordHash: 'stored-hash',
    firstName: 'Jane',
    lastName: 'Doe',
    type: 'individual',
    status: 'active',
    verificationLevel: 0,
    emailVerified: true,
    createdAt: new Date(),
    ...overrides,
  };
}

/** A Response that records what was set on it, without an HTTP server. */
function fakeResponse() {
  const cookies: Record<string, unknown> = {};
  const cleared: string[] = [];
  const res = {
    cookie: (name: string, value: unknown) => {
      cookies[name] = value;
      return res;
    },
    clearCookie: (name: string) => {
      cleared.push(name);
      return res;
    },
  };
  return { res: res as unknown as Response, cookies, cleared };
}

interface Harness {
  service: AuthService;
  users: {
    findByEmail: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    findByVerificationToken: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  email: { sendVerificationEmail: ReturnType<typeof vi.fn> };
  refreshTokens: {
    record: ReturnType<typeof vi.fn>;
    revokeAllForSubject: ReturnType<typeof vi.fn>;
  };
  passwords: PasswordService;
}

function build(overrides: { user?: User | undefined } = {}): Harness {
  const passwords = new PasswordService();
  const users = {
    findByEmail: vi.fn().mockResolvedValue(overrides.user),
    findById: vi.fn().mockResolvedValue(overrides.user),
    findByVerificationToken: vi.fn().mockResolvedValue(undefined),
    create: vi.fn((data: Partial<User>) => Promise.resolve({ id: 'new-user', ...data } as User)),
    update: vi.fn((_id: string, patch: Partial<User>) => Promise.resolve(makeUser(patch))),
  };
  const email = { sendVerificationEmail: vi.fn().mockResolvedValue(undefined) };
  const refreshTokens = {
    record: vi.fn().mockResolvedValue(undefined),
    revokeAllForSubject: vi.fn().mockResolvedValue(undefined),
  };

  const service = new AuthService(
    new JwtService({}),
    config,
    email as unknown as EmailService,
    users as unknown as UsersStore,
    new CsrfService(config),
    refreshTokens as unknown as RefreshTokensService,
    passwords,
  );

  return { service, users, email, refreshTokens, passwords };
}

describe('register', () => {
  const dto = {
    email: 'New.Person@Oxshare.com',
    password: 'a-good-password-123',
    firstName: 'New',
    lastName: 'Person',
  };

  it('refuses an email that already exists', async () => {
    const h = build({ user: makeUser() });
    await expect(h.service.register(dto)).rejects.toThrow(ConflictError);
    expect(h.users.create).not.toHaveBeenCalled();
  });

  it('lowercases the email, so one address cannot become two accounts', async () => {
    const h = build();
    await h.service.register(dto);
    expect(h.users.create).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'new.person@oxshare.com' }),
    );
  });

  it('never stores the password as given', async () => {
    const h = build();
    await h.service.register(dto);
    const stored = h.users.create.mock.calls[0][0] as { passwordHash: string };
    expect(stored.passwordHash).not.toBe(dto.password);
    expect(stored.passwordHash).not.toContain(dto.password);
    await expect(h.passwords.verify(dto.password, stored.passwordHash)).resolves.toMatchObject({
      valid: true,
    });
  });

  it('starts unverified at level 0, whatever the caller sent', async () => {
    const h = build();
    await h.service.register({ ...dto, ...({ verificationLevel: 1, status: 'active' } as object) });
    expect(h.users.create).toHaveBeenCalledWith(
      expect.objectContaining({ emailVerified: false, verificationLevel: 0 }),
    );
  });

  it('emails the verification token and never returns it', async () => {
    // The link is a bearer credential: it goes to the mailbox and nowhere else.
    const h = build();
    const result = await h.service.register(dto);
    expect(h.email.sendVerificationEmail).toHaveBeenCalledOnce();
    const [, token] = h.email.sendVerificationEmail.mock.calls[0] as [string, string];
    expect(token).toBeTruthy();
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it('gives the token a 24-hour expiry rather than leaving it open-ended', async () => {
    const h = build();
    await h.service.register(dto);
    const stored = h.users.create.mock.calls[0][0] as { emailVerificationExpiry: Date };
    const hours = (stored.emailVerificationExpiry.getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23);
    expect(hours).toBeLessThanOrEqual(24);
  });
});

describe('verifyEmail', () => {
  it('refuses an unknown token', async () => {
    const h = build();
    h.users.findByVerificationToken.mockResolvedValue(undefined);
    await expect(h.service.verifyEmail('nope')).rejects.toThrow(ValidationError);
  });

  it('refuses an expired token', async () => {
    const h = build();
    h.users.findByVerificationToken.mockResolvedValue(
      makeUser({ emailVerified: false, emailVerificationExpiry: new Date(Date.now() - 1000) }),
    );
    await expect(h.service.verifyEmail('stale')).rejects.toThrow(/expired/i);
    expect(h.users.update).not.toHaveBeenCalled();
  });

  it('verifies and CLEARS the token, so a link cannot be used twice', async () => {
    const h = build();
    h.users.findByVerificationToken.mockResolvedValue(
      makeUser({ emailVerified: false, emailVerificationExpiry: new Date(Date.now() + 10_000) }),
    );
    await h.service.verifyEmail('good');
    expect(h.users.update).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        emailVerified: true,
        emailVerificationToken: undefined,
        emailVerificationExpiry: undefined,
      }),
    );
  });
});

describe('login', () => {
  const PASSWORD = 'a-good-password-123';

  async function withPassword(overrides: Partial<User> = {}) {
    const passwords = new PasswordService();
    const hash = await passwords.hash(PASSWORD);
    return build({ user: makeUser({ passwordHash: hash, ...overrides }) });
  }

  it('rejects an unknown email', async () => {
    const h = build({ user: undefined });
    const { res } = fakeResponse();
    await expect(
      h.service.login({ email: 'nobody@oxshare.com', password: PASSWORD }, res),
    ).rejects.toThrow(AuthenticationError);
  });

  it('rejects a wrong password', async () => {
    const h = await withPassword();
    const { res } = fakeResponse();
    await expect(
      h.service.login({ email: 'client@oxshare.com', password: 'wrong' }, res),
    ).rejects.toThrow(AuthenticationError);
  });

  it('gives an unknown email and a wrong password the SAME message', async () => {
    // Different answers here are a user-enumeration oracle.
    const unknown = build({ user: undefined });
    const known = await withPassword();
    const a = await unknown.service
      .login({ email: 'nobody@oxshare.com', password: PASSWORD }, fakeResponse().res)
      .catch((e: Error) => e.message);
    const b = await known.service
      .login({ email: 'client@oxshare.com', password: 'wrong' }, fakeResponse().res)
      .catch((e: Error) => e.message);
    expect(a).toBe(b);
  });

  it('refuses a suspended account, and only AFTER the password matched', async () => {
    // Checked second on purpose: "your account is suspended" in response to a
    // wrong password would confirm the address exists and the password is right.
    const h = await withPassword({ status: 'suspended' });
    const { res } = fakeResponse();
    await expect(
      h.service.login({ email: 'client@oxshare.com', password: PASSWORD }, res),
    ).rejects.toThrow(AuthorizationError);
    await expect(
      h.service.login({ email: 'client@oxshare.com', password: 'wrong' }, res),
    ).rejects.toThrow(AuthenticationError);
  });

  it('sets the session cookies and records the refresh family', async () => {
    const h = await withPassword();
    const { res, cookies } = fakeResponse();
    await h.service.login({ email: 'client@oxshare.com', password: PASSWORD }, res);
    expect(Object.keys(cookies).length).toBeGreaterThanOrEqual(3); // access, refresh, csrf
    expect(h.refreshTokens.record).toHaveBeenCalledWith(
      expect.objectContaining({ surface: 'portal', subjectId: 'user-1' }),
    );
  });

  it('NEVER returns the tokens in the body', async () => {
    // They live in httpOnly cookies. Returning them hands JavaScript the very
    // credential the flag exists to keep away from it — and a portal running an
    // old build did exactly that, copying them back into a JS-readable cookie.
    const h = await withPassword();
    const { res } = fakeResponse();
    const body = await h.service.login({ email: 'client@oxshare.com', password: PASSWORD }, res);
    const serialised = JSON.stringify(body);
    expect(serialised).not.toMatch(/access_token|accessToken|refreshToken|eyJ/);
  });

  it('never returns the password hash', async () => {
    const h = await withPassword();
    const { res } = fakeResponse();
    const body = await h.service.login({ email: 'client@oxshare.com', password: PASSWORD }, res);
    expect(JSON.stringify(body)).not.toContain('stored-hash');
    expect(JSON.stringify(body)).not.toMatch(/passwordHash/);
  });

  it('upgrades a legacy bcrypt hash on a successful login', async () => {
    // R-3.4 dual-read: nobody is forced to reset a password they already have,
    // and the bcrypt population drains as people sign in.
    const passwords = new PasswordService();
    const bcryptHash = '$2b$10$abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRS';
    const h = build({ user: makeUser({ passwordHash: bcryptHash }) });
    vi.spyOn(passwords, 'verify');
    vi.spyOn(h.passwords, 'verify').mockResolvedValue({ valid: true, needsRehash: true });
    vi.spyOn(h.passwords, 'hash').mockResolvedValue('argon2id-upgraded');

    const { res } = fakeResponse();
    await h.service.login({ email: 'client@oxshare.com', password: PASSWORD }, res);

    expect(h.users.update).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({ passwordHash: 'argon2id-upgraded' }),
    );
  });

  it('does NOT rehash after a failed attempt', async () => {
    const h = build({ user: makeUser() });
    vi.spyOn(h.passwords, 'verify').mockResolvedValue({ valid: false, needsRehash: true });
    const hash = vi.spyOn(h.passwords, 'hash');
    const { res } = fakeResponse();

    await expect(
      h.service.login({ email: 'client@oxshare.com', password: 'wrong' }, res),
    ).rejects.toThrow(AuthenticationError);
    expect(hash).not.toHaveBeenCalled();
    expect(h.users.update).not.toHaveBeenCalled();
  });
});

describe('logout', () => {
  it('revokes EVERY refresh family for the user, not just the one presented', async () => {
    // Logging out on one device must not leave the others live (R-3.3).
    const h = build({ user: makeUser() });
    const { res } = fakeResponse();
    await h.service.logout('user-1', res);
    expect(h.refreshTokens.revokeAllForSubject).toHaveBeenCalledWith('portal', 'user-1');
  });

  it('clears the session cookies, including the superseded legacy names', async () => {
    // The old names were httpOnly:false and hold real JWTs; leaving them to
    // expire keeps a readable credential in the browser for up to 30 days.
    const h = build({ user: makeUser() });
    const { res, cleared } = fakeResponse();
    await h.service.logout('user-1', res);
    expect(cleared).toEqual(expect.arrayContaining(['access_token', 'refresh_token']));
    expect(cleared.length).toBeGreaterThan(3);
  });
});

describe('sanitize — what may leave the API', () => {
  /*
   * REGRESSION. `sanitize()` was a deny-list: it destructured four secrets out
   * and returned everything else. So when password reset added
   * `password_reset_token_hash` and `password_reset_expiry`, both immediately
   * started leaking on login, refresh AND me, and nothing noticed — the reset
   * hash is stored hashed precisely so a database leak yields no working reset
   * links (R-3.5), and the API was handing it out anyway.
   *
   * It is an allow-list now. These tests fail if anyone inverts that.
   */
  const LEAKY = makeUser({
    passwordHash: 'stored-hash',
    ...({
      passwordResetTokenHash: 'reset-hash',
      passwordResetExpiry: new Date(),
      emailVerificationToken: 'verify-token',
      refreshToken: 'refresh-hash',
    } as object),
  });

  const forbidden = ['stored-hash', 'reset-hash', 'verify-token', 'refresh-hash'];

  it('me() returns none of the secret fields', () => {
    const serialised = JSON.stringify(build().service.me(LEAKY));
    for (const secret of forbidden) expect(serialised).not.toContain(secret);
  });

  it('login() returns none of them either', async () => {
    const passwords = new PasswordService();
    const hash = await passwords.hash('a-good-password-123');
    const h = build({ user: { ...LEAKY, passwordHash: hash } });
    const body = await h.service.login(
      { email: 'client@oxshare.com', password: 'a-good-password-123' },
      fakeResponse().res,
    );
    const serialised = JSON.stringify(body);
    for (const secret of ['reset-hash', 'verify-token', 'refresh-hash']) {
      expect(serialised).not.toContain(secret);
    }
  });

  it('still returns the fields the portal actually needs', () => {
    // An allow-list that is too tight breaks the UI instead of leaking, which is
    // the better failure — but it is still a failure.
    const profile = build().service.me(LEAKY) as Record<string, unknown>;
    for (const field of ['id', 'email', 'firstName', 'lastName', 'type', 'status']) {
      expect(profile[field]).toBeDefined();
    }
    expect(profile['verificationLevel']).toBe(0);
    expect(profile['emailVerified']).toBe(true);
  });
});

beforeEach(() => {
  vi.restoreAllMocks();
});
