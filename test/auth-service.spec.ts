import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { AuthService } from '../src/modules/identity/auth.service';
import { PasswordService } from '../src/common/security/password.service';
import { CsrfService } from '../src/common/security/csrf.service';
import type { EmailService } from '../src/modules/email/email.service';
import type { RefreshTokensService } from '../src/common/security/refresh-tokens.service';
import type { LoginAttemptsService } from '../src/common/security/login-attempts.service';
import type { User, UsersStore } from '../src/store/users.store';
import { storedFilesStub } from './storage-stub';
import {
  AuthenticationError,
  AuthorizationError,
  EmailNotVerifiedError,
  ValidationError,
  VerificationTokenExpiredError,
} from '../src/common/errors/domain-errors';
import { createHash } from 'node:crypto';

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
    portalId: 1000000,
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
  const headers: Record<string, unknown> = {};
  const res = {
    cookie: (name: string, value: unknown) => {
      cookies[name] = value;
      return res;
    },
    clearCookie: (name: string) => {
      cleared.push(name);
      return res;
    },
    // issueCsrfToken echoes the token as a response header too (the cross-host
    // page cannot read the cookie); a fake Response must accept the call.
    setHeader: (name: string, value: unknown) => {
      headers[name] = value;
      return res;
    },
  };
  return { res: res as unknown as Response, cookies, cleared, headers };
}

interface Harness {
  service: AuthService;
  users: {
    findByEmail: ReturnType<typeof vi.fn>;
    findById: ReturnType<typeof vi.fn>;
    findByVerificationTokenHash: ReturnType<typeof vi.fn>;
    consumeEmailVerification: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    issueEmailCode: ReturnType<typeof vi.fn>;
    issueEmailVerification: ReturnType<typeof vi.fn>;
    takeEmailCodeAttempt: ReturnType<typeof vi.fn>;
    consumeEmailCode: ReturnType<typeof vi.fn>;
  };
  email: {
    sendVerificationEmail: ReturnType<typeof vi.fn>;
    sendAccountExistsEmail: ReturnType<typeof vi.fn>;
  };
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
    findByVerificationTokenHash: vi.fn().mockResolvedValue(undefined),
    consumeEmailVerification: vi.fn().mockResolvedValue(true),
    create: vi.fn((data: Partial<User>) => Promise.resolve({ id: 'new-user', ...data } as User)),
    update: vi.fn((_id: string, patch: Partial<User>) => Promise.resolve(makeUser(patch))),
    // The 6-digit code's atomic store methods (0138) — proven against real
    // Postgres in email-code-signin.spec.ts; here they only have to answer.
    issueEmailCode: vi.fn().mockResolvedValue(undefined),
    issueEmailVerification: vi.fn().mockResolvedValue(true),
    takeEmailCodeAttempt: vi.fn().mockResolvedValue(undefined),
    consumeEmailCode: vi.fn().mockResolvedValue(undefined),
  };
  const email = {
    sendVerificationEmail: vi.fn().mockResolvedValue(undefined),
    sendAccountExistsEmail: vi.fn().mockResolvedValue(undefined),
  };
  const refreshTokens = {
    record: vi.fn().mockResolvedValue(undefined),
    revokeAllForSubject: vi.fn().mockResolvedValue(undefined),
  };
  // R-3.5 per-account lockout. Stubbed as "never locked, nothing to record":
  // these cases are about the auth logic, and the lockout has its own spec.
  const loginAttempts = {
    lockedFor: vi.fn().mockResolvedValue(null),
    recordFailure: vi.fn().mockResolvedValue(undefined),
    recordSuccess: vi.fn().mockResolvedValue(undefined),
  };

  const service = new AuthService(
    new JwtService({}),
    config,
    email as unknown as EmailService,
    users as unknown as UsersStore,
    new CsrfService(config),
    refreshTokens as unknown as RefreshTokensService,
    passwords,
    loginAttempts as unknown as LoginAttemptsService,
    storedFilesStub(),
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

  it('does not create a second account for an address that already has one', async () => {
    const h = build({ user: makeUser() });
    await h.service.register(dto);
    expect(h.users.create).not.toHaveBeenCalled();
  });

  it('does NOT disclose that the address already has an account', async () => {
    /*
     * Registration used to answer 409 "An account with this email already
     * exists.", which made it a membership oracle: anyone could test an address
     * list and learn who banks here. `requestPasswordReset` avoids exactly that
     * leak, and registration quietly gave it back.
     *
     * The response must be indistinguishable from a real signup — same message,
     * and no `userId`, because returning the EXISTING user's id would hand back
     * the fact being hidden.
     */
    const existing = build({ user: makeUser() });
    const fresh = build();

    const whenTaken = await existing.service.register(dto);
    const whenNew = await fresh.service.register(dto);

    expect(whenTaken.message).toBe(whenNew.message);
    expect(whenTaken).not.toHaveProperty('userId');
  });

  it('tells the EXISTING account holder by email instead', async () => {
    // Removing the 409 alone would be worse than the leak: the person who forgot
    // they had an account gets a success message, no email, and no way to find
    // out why they cannot sign in. The information still goes out — to the one
    // mailbox entitled to it.
    const h = build({ user: makeUser() });
    await h.service.register(dto);
    expect(h.email.sendAccountExistsEmail).toHaveBeenCalledWith('client@oxshare.com');
  });

  it('sends that email at most once an hour per ADDRESS, however many attempts', async () => {
    /*
     * The route throttle caps ten attempts per hour per IP, which bounds the
     * CALLER and not the VICTIM: ten proxies is ten times the mail to the same
     * mailbox. Keyed on the address instead, so the ceiling follows the person
     * being written to.
     *
     * The ordinary case is not an attack at all — somebody who has forgotten
     * their account and submits the form four times should get one email.
     */
    const h = build({ user: makeUser() });

    for (let i = 0; i < 4; i += 1) await h.service.register(dto);

    expect(h.email.sendAccountExistsEmail).toHaveBeenCalledTimes(1);
  });

  it('still answers identically on every one of those attempts', async () => {
    // The dedupe must not become an oracle of its own: a caller who noticed the
    // second attempt behaving differently would have learned the address exists.
    const h = build({ user: makeUser() });

    const first = await h.service.register(dto);
    const second = await h.service.register(dto);

    expect(second).toEqual(first);
  });

  it('does not let one address suppress another', async () => {
    // The stub answers every lookup with the same user, so the second address has
    // to be given its own — otherwise this asserts that one address suppresses
    // ITSELF, which is the previous test.
    const h = build({ user: makeUser() });
    h.users.findByEmail
      .mockResolvedValueOnce(makeUser())
      .mockResolvedValueOnce(makeUser({ email: 'someone.else@oxshare.com' }));

    await h.service.register(dto);
    await h.service.register({ ...dto, email: 'someone.else@oxshare.com' });

    expect(h.email.sendAccountExistsEmail).toHaveBeenCalledTimes(2);
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
  /*
   * The token is looked up by its SHA-256 now, so a test that wants a lookup to
   * SUCCEED has to key the stub on the same hash the service will compute.
   */
  const hashOf = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

  it('refuses an unknown token', async () => {
    const h = build();
    h.users.findByVerificationTokenHash.mockResolvedValue(undefined);
    await expect(h.service.verifyEmail('nope')).rejects.toThrow(ValidationError);
  });

  it('never sends the PLAINTEXT token to the store', async () => {
    /*
     * The point of hashing: the credential stops at the service that received
     * it and never reaches a query, a query log, or a database dump.
     */
    const h = build();
    h.users.findByVerificationTokenHash.mockResolvedValue(undefined);
    await expect(h.service.verifyEmail('secret-token')).rejects.toThrow(ValidationError);

    const [arg] = h.users.findByVerificationTokenHash.mock.calls[0] as [string];
    expect(arg).not.toBe('secret-token');
    expect(arg).toBe(hashOf('secret-token'));
  });

  it('refuses an expired token, and clears the whole cycle on the way out', async () => {
    /*
     * UPDATED 6 Aug 2026. This asserted that NOTHING was written on the expiry
     * path, which was true and was the defect: the dead token stayed in the row
     * indefinitely — the only one-time credential here that outlived its own
     * expiry, and the only one stored in plaintext rather than hashed.
     *
     * `resetPassword` has always cleared its token on the same path. This is now
     * the same shape. What must NOT change is the refusal itself, so both halves
     * are asserted.
     *
     * UPDATED 21 Aug 2026 for the hashed column and its redemption marker. The
     * marker goes with the hash: half a record of a cycle that ended in nothing
     * is worse than no record.
     */
    const h = build();
    h.users.findByVerificationTokenHash.mockResolvedValue(
      makeUser({ emailVerified: false, emailVerificationExpiry: new Date(Date.now() - 1000) }),
    );
    await expect(h.service.verifyEmail('stale')).rejects.toThrow(/expired/i);

    expect(h.users.update).toHaveBeenCalledWith('user-1', {
      emailVerificationTokenHash: undefined,
      emailVerificationExpiry: undefined,
      emailVerificationConsumedAt: undefined,
    });
    // And emphatically NOT verified — clearing the token must not be mistaken
    // for accepting it.
    expect(h.users.consumeEmailVerification).not.toHaveBeenCalled();
  });

  it('gives an expired link its OWN code, so the screen can say "request a new one"', async () => {
    /*
     * Expired and never-valid used to be the same 400 / VALIDATION_FAILED with
     * different English, and the portal rendered one red box for both. A client
     * whose link had merely aged out was told nothing actionable.
     */
    const h = build();
    h.users.findByVerificationTokenHash.mockResolvedValue(
      makeUser({ emailVerified: false, emailVerificationExpiry: new Date(Date.now() - 1000) }),
    );
    await expect(h.service.verifyEmail('stale')).rejects.toThrow(VerificationTokenExpiredError);
    await expect(h.service.verifyEmail('stale')).rejects.toMatchObject({
      code: 'VERIFICATION_TOKEN_EXPIRED',
    });
  });

  it('verifies through a CONDITIONAL update, not a read-then-write', async () => {
    const h = build();
    h.users.findByVerificationTokenHash.mockResolvedValue(
      makeUser({ emailVerified: false, emailVerificationExpiry: new Date(Date.now() + 10_000) }),
    );

    const result = await h.service.verifyEmail('good');

    expect(result.status).toBe('verified');
    // The token's HASH is what identifies the row to redeem — the same value
    // that found it, so a concurrent re-issue cannot be redeemed by this call.
    expect(h.users.consumeEmailVerification).toHaveBeenCalledWith(
      'user-1',
      hashOf('good'),
      expect.any(Date),
    );
  });

  it('answers ALREADY VERIFIED on a second click instead of "invalid"', async () => {
    /*
     * UX-01, and the reason this whole change exists.
     *
     * A refresh, the Back button, a restored tab, or a mail scanner prefetching
     * the link re-POSTs a token that has already worked. That used to be
     * indistinguishable from a token that never existed, so a verified client
     * was shown a red "Verification Failed" — telling a customer that something
     * failed when it succeeded, in a money product.
     */
    const h = build();
    h.users.findByVerificationTokenHash.mockResolvedValue(
      makeUser({
        emailVerified: true,
        emailVerificationExpiry: new Date(Date.now() + 10_000),
        emailVerificationConsumedAt: new Date(),
      }),
    );

    const result = await h.service.verifyEmail('used-already');

    expect(result.status).toBe('already_verified');
    // Nothing is re-written. The address was already confirmed.
    expect(h.users.consumeEmailVerification).not.toHaveBeenCalled();
  });

  it('answers ALREADY VERIFIED for a link redeemed before its expiry passed', async () => {
    /*
     * The redeemed check runs BEFORE the expiry check, and that order is
     * load-bearing. A link redeemed on day one must not start reporting
     * "expired" on day two because the clock moved past a deadline it had
     * already met — which would reintroduce the same lie in slower motion.
     */
    const h = build();
    h.users.findByVerificationTokenHash.mockResolvedValue(
      makeUser({
        emailVerified: true,
        emailVerificationExpiry: new Date(Date.now() - 86_400_000),
        emailVerificationConsumedAt: new Date(Date.now() - 90_000_000),
      }),
    );

    await expect(h.service.verifyEmail('old-but-used')).resolves.toMatchObject({
      status: 'already_verified',
    });
  });

  it('treats LOSING the redemption race as a success, not a failure', async () => {
    /*
     * Two POSTs carrying the same valid token both read `consumed_at` as NULL —
     * StrictMode's double mount, or a scanner and a human a moment apart. The
     * database picks one. The loser is looking at an address that IS verified,
     * and saying "invalid" to them is the original defect with a narrower window.
     */
    const h = build();
    h.users.findByVerificationTokenHash.mockResolvedValue(
      makeUser({ emailVerified: false, emailVerificationExpiry: new Date(Date.now() + 10_000) }),
    );
    h.users.consumeEmailVerification.mockResolvedValue(false);

    await expect(h.service.verifyEmail('raced')).resolves.toMatchObject({
      status: 'already_verified',
    });
  });

  it('does NOT announce a verification that did not happen', async () => {
    /*
     * The redeemed fast path requires `emailVerified` as well as `consumedAt`.
     * The two are only ever written together, so this state is unreachable by
     * construction — which is exactly why the branch is worth pinning: it must
     * fall through and do the real work rather than assert something false.
     */
    const h = build();
    h.users.findByVerificationTokenHash.mockResolvedValue(
      makeUser({
        emailVerified: false,
        emailVerificationExpiry: new Date(Date.now() + 10_000),
        emailVerificationConsumedAt: new Date(),
      }),
    );
    h.users.consumeEmailVerification.mockResolvedValue(true);

    await expect(h.service.verifyEmail('incoherent')).resolves.toMatchObject({
      status: 'verified',
    });
    expect(h.users.consumeEmailVerification).toHaveBeenCalled();
  });
});

describe('resendVerification', () => {
  it('issues a new link AND code through the one atomic store call that also ends the old cycle', async () => {
    /*
     * The redemption marker outlives redemption by design, so a re-send onto a
     * row that carries one has to clear it — `issueEmailVerification` does, in
     * the same UPDATE that enforces the resend cooldown (pinned against real
     * Postgres in email-code-signin.spec.ts and email-verification-cycle.spec.ts).
     */
    const h = build({ user: makeUser({ emailVerified: false }) });

    await h.service.resendVerification('client@oxshare.com');

    expect(h.users.issueEmailVerification).toHaveBeenCalledOnce();
    const [, , , cooldownMs] = h.users.issueEmailVerification.mock.calls[0] as [
      string,
      unknown,
      Date,
      number,
    ];
    expect(cooldownMs).toBe(30_000);
  });

  it('stores the HASHES and mails the token and the code', async () => {
    const h = build({ user: makeUser({ emailVerified: false }) });

    await h.service.resendVerification('client@oxshare.com');

    const [, mailed, code] = h.email.sendVerificationEmail.mock.calls[0] as [
      string,
      string,
      string,
    ];
    const [, issue] = h.users.issueEmailVerification.mock.calls[0] as [
      string,
      { tokenHash: string; codeHash: string },
    ];
    expect(issue.tokenHash).toBe(hashOf(mailed));
    expect(issue.tokenHash).not.toBe(mailed);
    expect(code).toMatch(/^\d{6}$/);
    // Keyed, never a plain digest a dump could reverse in a second.
    expect(issue.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(issue.codeHash).not.toBe(hashOf(code));
  });

  it('mails nothing when the store says the cooldown has not passed', async () => {
    const h = build({ user: makeUser({ emailVerified: false }) });
    h.users.issueEmailVerification.mockResolvedValue(false);
    await h.service.resendVerification('client@oxshare.com');
    expect(h.email.sendVerificationEmail).not.toHaveBeenCalled();
  });

  const hashOf = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');
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

  it('REFUSES a correct password on an unverified address', async () => {
    /*
     * The check was missing outright, and this is the test that was missing
     * with it: `register` set `emailVerified: false` and mailed a link,
     * `verifyEmail` was its only writer, and login never read the column — so
     * the link was decorative and anyone could sign in to an address they had
     * never proved they owned.
     */
    const h = await withPassword({ emailVerified: false });
    const { res, cookies } = fakeResponse();

    await expect(
      h.service.login({ email: 'client@oxshare.com', password: PASSWORD }, res),
    ).rejects.toThrow(EmailNotVerifiedError);

    // A refused login leaves NO session behind — no cookie, no refresh family.
    expect(Object.keys(cookies)).toHaveLength(0);
    expect(h.refreshTokens.record).not.toHaveBeenCalled();
    // ...but the owner (the password was right) is mailed a code to finish with.
    expect(h.email.sendVerificationEmail).toHaveBeenCalledOnce();
  });

  it('carries EMAIL_NOT_VERIFIED, so the portal can open the code screen', async () => {
    // The login page branches on this code to open the code screen. It used
    // to branch on the English message, which broke the day a translation
    // shipped — so the code is the contract and this pins it.
    const h = await withPassword({ emailVerified: false });
    await expect(
      h.service.login({ email: 'client@oxshare.com', password: PASSWORD }, fakeResponse().res),
    ).rejects.toMatchObject({ code: 'EMAIL_NOT_VERIFIED' });
  });

  it('refuses an unverified address BEFORE checking suspension, but AFTER the password', async () => {
    // Ordering is security-relevant: answering "unverified" to a WRONG password
    // would confirm the address is registered here.
    const h = await withPassword({ emailVerified: false });
    await expect(
      h.service.login({ email: 'client@oxshare.com', password: 'wrong' }, fakeResponse().res),
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
      emailVerificationTokenHash: 'verify-hash',
      refreshToken: 'refresh-hash',
    } as object),
  });

  const forbidden = ['stored-hash', 'reset-hash', 'verify-hash', 'refresh-hash'];

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
