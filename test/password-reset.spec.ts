import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import { eq } from 'drizzle-orm';
import { MoneyTestContext, startMoneyTestDb, stopMoneyTestDb } from './money-setup';
import { closeDb, getDb, resetDb } from '../src/database/db';
import { users } from '../src/database/schema';
import { UsersStore } from '../src/store/users.store';
import { AuthService } from '../src/modules/identity/auth.service';
import { PasswordService } from '../src/common/security/password.service';
import { ValidationError } from '../src/common/errors/domain-errors';
import { storedFilesStub } from './storage-stub';

/**
 * Password reset — FR-CORE-09 · PLATFORM-CONVENTIONS R-3.5.
 *
 * The portal has had a working reset UI with no endpoint behind it: both calls
 * 404'd, so a client who forgot their password had no recovery path and nothing
 * explaining why. This is the other half.
 *
 * What is pinned here is the security shape, not the happy path — the happy path
 * is one line and would pass against a naive implementation too:
 *
 *  - the response NEVER distinguishes a known address from an unknown one,
 *  - the database stores a HASH, so a dump is not a set of working reset links,
 *  - a token is single-use and time-boxed,
 *  - completing a reset revokes every existing session.
 *
 * Real Postgres, because three of those four are assertions about what is
 * actually stored.
 */

let ctx: MoneyTestContext;
let auth: AuthService;
let store: UsersStore;
const sentTokens: string[] = [];
const revoked: { surface: string; id: string }[] = [];

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

async function makeUser(email: string, status: 'active' | 'suspended' = 'active') {
  const [row] = await ctx.db
    .insert(users)
    .values({
      email,
      passwordHash: await new PasswordService().hash('OriginalPass123!'),
      firstName: 'Test',
      lastName: 'User',
      status,
    })
    .returning();
  return row;
}

async function reload(id: string) {
  const [row] = await ctx.db.select().from(users).where(eq(users.id, id));
  return row;
}

beforeAll(async () => {
  resetDb();
  ctx = await startMoneyTestDb();
  resetDb();

  store = new UsersStore(getDb());
  const email = {
    sendPasswordResetEmail: (_to: string, token: string) => {
      sentTokens.push(token);
      return Promise.resolve();
    },
  };
  const refreshTokens = {
    revokeAllForSubject: (surface: string, id: string) => {
      revoked.push({ surface, id });
      return Promise.resolve(1);
    },
  };
  // R-3.5 lockout — not what this spec is about; never locked.
  const loginAttempts = {
    lockedFor: () => Promise.resolve(null),
    recordFailure: () => Promise.resolve(undefined),
    recordSuccess: () => Promise.resolve(undefined),
  };

  auth = new AuthService(
    {} as never, // jwt — unused on these paths
    { get: () => undefined } as never,
    email as never,
    store,
    {} as never, // csrf — unused
    refreshTokens as never,
    new PasswordService(),
    loginAttempts as never,
    storedFilesStub(),
  );
});

afterAll(async () => {
  await closeDb();
  if (ctx) await stopMoneyTestDb(ctx);
});

describe('requesting a reset does not reveal who has an account', () => {
  it('answers identically for a known and an unknown address', async () => {
    const user = await makeUser('known@test.local');

    const known = await auth.requestPasswordReset(user.email);
    const unknown = await auth.requestPasswordReset('nobody@test.local');

    // An endpoint that says "no account with that email" is a membership
    // oracle: anyone can test an address list against it and learn who banks
    // here. The honest-looking error IS the vulnerability.
    expect(known).toEqual(unknown);
  });

  it('answers the same for a suspended account, and issues nothing', async () => {
    const user = await makeUser('suspended@test.local', 'suspended');
    const before = sentTokens.length;

    await auth.requestPasswordReset(user.email);

    // Reinstating a suspended account is an admin decision; a working reset
    // would route around it.
    expect(sentTokens.length).toBe(before);
    expect((await reload(user.id)).passwordResetTokenHash).toBeNull();
  });
});

describe('the stored token is a hash, not the token', () => {
  it('never writes the emailed value to the database', async () => {
    const user = await makeUser('hash@test.local');
    await auth.requestPasswordReset(user.email);
    const token = sentTokens.at(-1)!;

    const row = await reload(user.id);

    // THE assertion. A dump, a leaked backup or a read-only injection must not
    // yield a working reset link for every user with one outstanding.
    expect(row.passwordResetTokenHash).not.toBe(token);
    expect(row.passwordResetTokenHash).toBe(sha256(token));
  });

  it('expires in 30 minutes, not longer', async () => {
    const user = await makeUser('ttl@test.local');
    await auth.requestPasswordReset(user.email);

    const row = await reload(user.id);
    const minutes = (row.passwordResetExpiry!.getTime() - Date.now()) / 60_000;
    // Long enough to find the email, short enough that a link left sitting in an
    // inbox is not a standing key to the account (R-3.5).
    expect(minutes).toBeGreaterThan(25);
    expect(minutes).toBeLessThanOrEqual(30);
  });
});

describe('completing a reset', () => {
  it('sets the new password and clears the token in one write', async () => {
    const user = await makeUser('reset@test.local');
    await auth.requestPasswordReset(user.email);
    const token = sentTokens.at(-1)!;

    await auth.resetPassword(token, 'BrandNewPass123!');

    const row = await reload(user.id);
    expect(row.passwordResetTokenHash).toBeNull();
    expect(row.passwordResetExpiry).toBeNull();

    const passwords = new PasswordService();
    expect((await passwords.verify('BrandNewPass123!', row.passwordHash)).valid).toBe(true);
    expect((await passwords.verify('OriginalPass123!', row.passwordHash)).valid).toBe(false);
  });

  it('VERIFIES the address, because the link proved the mailbox', async () => {
    /*
     * A user who registers, never opens the verification mail, and then uses
     * "forgot password" has just proved they control the mailbox — more
     * strongly than the verification link would, since they also changed the
     * credential with it.
     *
     * Without this they would hold a working password and still be refused at
     * login by the `emailVerified` check, with no explanation for why the reset
     * they just completed did not count. The stale verification token goes too:
     * it is a live credential for a fact now established another way.
     */
    const user = await makeUser('unverified-reset@test.local');
    expect((await reload(user.id)).emailVerified).toBe(false);

    await auth.requestPasswordReset(user.email);
    await auth.resetPassword(sentTokens.at(-1)!, 'BrandNewPass123!');

    const row = await reload(user.id);
    expect(row.emailVerified).toBe(true);
    expect(row.emailVerificationTokenHash).toBeNull();
    expect(row.emailVerificationExpiry).toBeNull();
    expect(row.emailVerificationConsumedAt).toBeNull();
  });

  it('REVOKES every session, because that is why people reset', async () => {
    const user = await makeUser('revoke@test.local');
    await auth.requestPasswordReset(user.email);
    const before = revoked.length;

    await auth.resetPassword(sentTokens.at(-1)!, 'BrandNewPass123!');

    // Someone resetting a password usually believes they are compromised.
    // Leaving the attacker's 30-day refresh token alive makes the reset theatre.
    expect(revoked.length).toBe(before + 1);
    expect(revoked.at(-1)).toEqual({ surface: 'portal', id: user.id });
  });

  it('refuses the same token twice', async () => {
    const user = await makeUser('single-use@test.local');
    await auth.requestPasswordReset(user.email);
    const token = sentTokens.at(-1)!;

    await auth.resetPassword(token, 'FirstNewPass123!');

    await expect(auth.resetPassword(token, 'SecondNewPass123!')).rejects.toBeInstanceOf(
      ValidationError,
    );
    // And the first reset stands — a rejected replay must not roll it back.
    const passwords = new PasswordService();
    expect(
      (await passwords.verify('FirstNewPass123!', (await reload(user.id)).passwordHash)).valid,
    ).toBe(true);
  });

  it('refuses an expired token, and clears it', async () => {
    const user = await makeUser('expired@test.local');
    await auth.requestPasswordReset(user.email);
    const token = sentTokens.at(-1)!;

    // Reach past the TTL rather than waiting 30 minutes.
    await ctx.db
      .update(users)
      .set({ passwordResetExpiry: new Date(Date.now() - 1000) })
      .where(eq(users.id, user.id));

    await expect(auth.resetPassword(token, 'BrandNewPass123!')).rejects.toBeInstanceOf(
      ValidationError,
    );
    // A dead token is cleared rather than left to linger and be retried.
    expect((await reload(user.id)).passwordResetTokenHash).toBeNull();
  });

  it('refuses a token nobody issued', async () => {
    await expect(auth.resetPassword('not-a-real-token', 'BrandNewPass123!')).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('gives the same message for unknown and expired tokens', async () => {
    const user = await makeUser('same-message@test.local');
    await auth.requestPasswordReset(user.email);
    await ctx.db
      .update(users)
      .set({ passwordResetExpiry: new Date(Date.now() - 1000) })
      .where(eq(users.id, user.id));

    const expired = await auth
      .resetPassword(sentTokens.at(-1)!, 'X-Pass123!')
      .catch((e: Error) => e);
    const unknown = await auth.resetPassword('nope', 'X-Pass123!').catch((e: Error) => e);

    // Distinguishing them tells an attacker which of their guesses was once
    // real, which is a slow oracle but an oracle.
    expect((expired as Error).message).toBe((unknown as Error).message);
  });

  it('never logs the token', async () => {
    const lines: string[] = [];
    const { Logger } = await import('@nestjs/common');
    const spies = (['log', 'warn', 'error'] as const).map((lvl) =>
      vi.spyOn(Logger.prototype, lvl).mockImplementation((m: unknown) => {
        lines.push(String(m));
      }),
    );

    const user = await makeUser('nolog@test.local');
    await auth.requestPasswordReset(user.email);
    const token = sentTokens.at(-1)!;
    await auth.resetPassword(token, 'BrandNewPass123!');

    spies.forEach((s) => s.mockRestore());
    // R-6.3: the link is a bearer credential. This is the same leak that was
    // already found and fixed in EmailService — it must not reappear here.
    expect(lines.join('\n')).not.toContain(token);
  });
});
