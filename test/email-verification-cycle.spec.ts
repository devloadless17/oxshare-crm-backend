import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import { eq } from 'drizzle-orm';
import { MoneyTestContext, startMoneyTestDb, stopMoneyTestDb } from './money-setup';
import { closeDb, getDb, resetDb } from '../src/database/db';
import { users } from '../src/database/schema';
import { UsersStore } from '../src/store/users.store';
import { AuthService } from '../src/modules/identity/auth.service';
import { PasswordService } from '../src/common/security/password.service';
import { ValidationError, VerificationTokenExpiredError } from '../src/common/errors/domain-errors';
import { storedFilesStub } from './storage-stub';
import { SIGN_UP_DETAILS } from './support/registration';

/**
 * Email verification, end to end against real Postgres — UX-BACKLOG UX-01.
 *
 * ## What was wrong
 *
 * `verifyEmail` deleted the token from the row the instant it worked, so "this
 * token was redeemed a minute ago" and "this token never existed" became the
 * same state. A refresh, the Back button, a restored tab, or a corporate mail
 * scanner prefetching the link re-POSTed a spent token and got
 * `Invalid or expired verification token.` — a red **Verification Failed** on
 * an account that was verified.
 *
 * ## Why these tests need a real database
 *
 * The fix is not one function; it is a lifecycle spread across a column that now
 * outlives its own redemption, a conditional UPDATE that decides who was first,
 * and three writers that must each end the previous cycle. `auth-service.spec.ts`
 * covers the branching with stubs. Every assertion here is about what is
 * ACTUALLY STORED and what two concurrent statements actually do — neither of
 * which a mock can be wrong about convincingly.
 */

let ctx: MoneyTestContext;
let auth: AuthService;
let store: UsersStore;
const mailed: { to: string; token: string }[] = [];

const sha256 = (v: string) => createHash('sha256').update(v, 'utf8').digest('hex');

async function register(email: string) {
  mailed.length = 0;
  await auth.register({
    email,
    password: 'AGoodPassword123!',
    firstName: 'Test',
    lastName: 'Client',
    ...SIGN_UP_DETAILS,
  });
  const token = mailed.at(-1)!.token;
  const row = await reloadByEmail(email);
  return { token, row };
}

async function reloadByEmail(email: string) {
  const [row] = await ctx.db.select().from(users).where(eq(users.email, email.toLowerCase()));
  return row;
}

beforeAll(async () => {
  resetDb();
  ctx = await startMoneyTestDb();
  resetDb();

  store = new UsersStore(getDb());
  const email = {
    sendVerificationEmail: (to: string, token: string) => {
      mailed.push({ to, token });
      return Promise.resolve();
    },
    sendAccountExistsEmail: () => Promise.resolve(),
  };
  const loginAttempts = {
    lockedFor: () => Promise.resolve(null),
    recordFailure: () => Promise.resolve(undefined),
    recordSuccess: () => Promise.resolve(undefined),
  };

  auth = new AuthService(
    {} as never, // jwt — unused on these paths
    // Only the key the 6-digit email code is hashed under (0138) is read here.
    {
      get: (key: string) =>
        key === 'JWT_ACCESS_SECRET' ? 'test-email-code-secret-at-least-32-chars' : undefined,
    } as never,
    email as never,
    store,
    {} as never, // csrf — unused
    { revokeAllForSubject: () => Promise.resolve(1) } as never,
    new PasswordService(),
    loginAttempts as never,
    storedFilesStub(),
  );
});

afterAll(async () => {
  await closeDb();
  if (ctx) await stopMoneyTestDb(ctx);
});

describe('the token is never stored in plaintext', () => {
  it('stores the SHA-256 and mails the token', async () => {
    const { token, row } = await register('hash-check@test.local');

    expect(row.emailVerificationTokenHash).toBe(sha256(token));
    expect(row.emailVerificationTokenHash).not.toBe(token);
  });

  it('leaves no column anywhere in the row containing the token', async () => {
    /*
     * The point of the change, stated as the property rather than as a column
     * name: a database dump must not be a set of working verification links. A
     * whole-row scan rather than one assertion, so moving the credential to a
     * different column cannot quietly pass.
     */
    const { token, row } = await register('no-plaintext@test.local');

    expect(JSON.stringify(row)).not.toContain(token);
  });
});

describe('redeeming a link', () => {
  it('verifies the account and RECORDS the redemption rather than erasing it', async () => {
    const { token, row } = await register('first-click@test.local');
    expect(row.emailVerified).toBe(false);
    expect(row.emailVerificationConsumedAt).toBeNull();

    const result = await auth.verifyEmail(token);

    expect(result.status).toBe('verified');
    const after = await reloadByEmail('first-click@test.local');
    expect(after.emailVerified).toBe(true);
    expect(after.emailVerificationConsumedAt).toBeInstanceOf(Date);
    // The hash SURVIVES. This is the whole fix: without it, the next click is
    // indistinguishable from a forged token.
    expect(after.emailVerificationTokenHash).toBe(sha256(token));
  });

  it('answers ALREADY VERIFIED on the second click, not "invalid"', async () => {
    /*
     * UX-01 itself. Before this change the second call threw and the portal
     * painted a red "Verification Failed" over a verified account.
     */
    const { token } = await register('second-click@test.local');

    const first = await auth.verifyEmail(token);
    const second = await auth.verifyEmail(token);

    expect(first.status).toBe('verified');
    expect(second.status).toBe('already_verified');
  });

  it('keeps answering honestly long after the original 24 hours', async () => {
    /*
     * The redeemed check runs BEFORE the expiry check. A link redeemed on day
     * one must not start reporting "expired" on day two — that would be the
     * same lie in slower motion.
     */
    const { token } = await register('stale-but-used@test.local');
    await auth.verifyEmail(token);

    await ctx.db
      .update(users)
      .set({ emailVerificationExpiry: new Date(Date.now() - 30 * 86_400_000) })
      .where(eq(users.email, 'stale-but-used@test.local'));

    await expect(auth.verifyEmail(token)).resolves.toMatchObject({
      status: 'already_verified',
    });
  });

  it('does not redeem a token that was never issued', async () => {
    await expect(auth.verifyEmail('a-token-nobody-issued')).rejects.toThrow(ValidationError);
  });
});

describe('an expired link', () => {
  it('is refused with its OWN code, and the dead cycle is cleared', async () => {
    const { token } = await register('expired@test.local');
    await ctx.db
      .update(users)
      .set({ emailVerificationExpiry: new Date(Date.now() - 1000) })
      .where(eq(users.email, 'expired@test.local'));

    await expect(auth.verifyEmail(token)).rejects.toThrow(VerificationTokenExpiredError);

    const after = await reloadByEmail('expired@test.local');
    expect(after.emailVerified).toBe(false);
    // Nothing left behind: half a record of a cycle that ended in nothing is
    // worse than no record.
    expect(after.emailVerificationTokenHash).toBeNull();
    expect(after.emailVerificationExpiry).toBeNull();
    expect(after.emailVerificationConsumedAt).toBeNull();
  });
});

describe('two clicks arriving together', () => {
  it('BOTH succeed, and exactly one of them redeems', async () => {
    /*
     * The case the old per-mount guard in the portal could not cover, and the
     * reason redemption is a conditional UPDATE rather than a read-then-write:
     * React StrictMode double-mounts, a scanner prefetches a moment before the
     * human clicks, a refresh re-sends. Both callers read `consumed_at` as NULL.
     *
     * Run as genuinely concurrent statements against real Postgres — a mock
     * cannot be wrong about this in the way that matters.
     */
    const { token } = await register('race@test.local');

    const [a, b] = await Promise.all([auth.verifyEmail(token), auth.verifyEmail(token)]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(['already_verified', 'verified']);

    const after = await reloadByEmail('race@test.local');
    expect(after.emailVerified).toBe(true);
  });

  it('never answers "invalid" to either of them', async () => {
    const { token } = await register('race-two@test.local');

    const results = await Promise.allSettled([
      auth.verifyEmail(token),
      auth.verifyEmail(token),
      auth.verifyEmail(token),
    ]);

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
  });
});

describe('two accounts can never share a token hash', () => {
  it('the database REFUSES the collision rather than resolving it', async () => {
    /*
     * `findByVerificationTokenHash` takes `limit 1`. Without a unique index, two
     * rows holding the same hash would verify an ARBITRARY one of them —
     * silently, on the control that gates KYC and therefore withdrawals.
     *
     * Tokens are `randomUUID`, so this cannot happen by chance. The constraint
     * exists so that if it ever does — a bug in token generation, a bad
     * backfill, a restored row — it is an error somebody has to look at rather
     * than a client verified into a stranger's account. §6.3: idempotency lives
     * in database constraints.
     *
     * Found by a test harness that reused a fixed token across runs and
     * therefore planted one hash on two rows; run two verified run one's
     * account, and every assertion after it measured the wrong row.
     */
    const { row: first } = await register('collide-one@test.local');
    const { row: second } = await register('collide-two@test.local');

    await expect(
      ctx.db
        .update(users)
        .set({ emailVerificationTokenHash: first.emailVerificationTokenHash })
        .where(eq(users.id, second.id)),
    ).rejects.toThrow();
  });

  it('but any number of accounts may have NO outstanding token', async () => {
    // Nulls do not collide in Postgres, and most rows are null — a constraint
    // that broke that would break every verified account in the system.
    const { row } = await register('null-hash-one@test.local');
    const { row: other } = await register('null-hash-two@test.local');

    await ctx.db
      .update(users)
      .set({ emailVerificationTokenHash: null })
      .where(eq(users.id, row.id));

    await expect(
      ctx.db.update(users).set({ emailVerificationTokenHash: null }).where(eq(users.id, other.id)),
    ).resolves.toBeDefined();
  });
});

describe('issuing a NEW token ends the previous cycle', () => {
  it('clears the redemption marker on resend', async () => {
    /*
     * Without this, the client's first click on a brand-new link is answered
     * `already_verified` — verifying nothing, then refusing them at login on an
     * address that really is unverified, with no reason on screen.
     */
    const { token } = await register('resend@test.local');
    await auth.verifyEmail(token);

    // Force it back to unverified, the state a resend is for, WITHOUT touching
    // the redemption marker — which is exactly the trap.
    await ctx.db
      .update(users)
      .set({ emailVerified: false })
      .where(eq(users.email, 'resend@test.local'));

    mailed.length = 0;
    await auth.resendVerification('resend@test.local');
    const fresh = mailed.at(-1)!.token;

    const row = await reloadByEmail('resend@test.local');
    expect(row.emailVerificationConsumedAt).toBeNull();
    expect(row.emailVerificationTokenHash).toBe(sha256(fresh));

    // And the new link actually verifies, rather than reporting a redemption
    // that belonged to the token before it.
    await expect(auth.verifyEmail(fresh)).resolves.toMatchObject({ status: 'verified' });
  });

  it('the OLD token stops working once a new one is issued', async () => {
    const { token: old } = await register('superseded@test.local');
    // A new cycle begins only once the 30-second resend cooldown has passed
    // (0138) — see the next case for what happens inside it.
    await ctx.db
      .update(users)
      .set({ emailVerificationCodeSentAt: new Date(Date.now() - 31_000) })
      .where(eq(users.email, 'superseded@test.local'));
    await auth.resendVerification('superseded@test.local');

    await expect(auth.verifyEmail(old)).rejects.toThrow(ValidationError);
  });

  it('a resend INSIDE the cooldown issues nothing, so the link already sent keeps working', async () => {
    const { token } = await register('cooldown@test.local');
    mailed.length = 0;
    await auth.resendVerification('cooldown@test.local');

    expect(mailed, 'a resend inside the cooldown mailed').toEqual([]);
    await expect(auth.verifyEmail(token)).resolves.toMatchObject({ status: 'verified' });
  });

  it('the store REFUSES a new token that says nothing about the marker', async () => {
    /*
     * The invariant above is not left to three call sites remembering it. A
     * prose rule in a column comment is not a rule, and the failure it prevents
     * surfaces far away from the line that causes it — so `UsersStore.update`
     * rejects the patch outright.
     */
    const { row } = await register('guard@test.local');

    await expect(
      store.update(row.id, { emailVerificationTokenHash: sha256('brand-new') }),
    ).rejects.toThrow(/emailVerificationConsumedAt/);

    // Explicit is fine — including explicitly keeping it, which is what makes
    // this a guard against forgetting rather than a ban.
    await expect(
      store.update(row.id, {
        emailVerificationTokenHash: sha256('brand-new'),
        emailVerificationConsumedAt: undefined,
      }),
    ).resolves.toBeDefined();
  });

  it('CLEARING the hash needs no such ceremony', async () => {
    // `resetPassword` clears the whole cycle. There is no new token to be born
    // looking redeemed, so the guard must not stand in its way.
    const { row } = await register('clearing@test.local');

    await expect(
      store.update(row.id, {
        emailVerificationTokenHash: undefined,
        emailVerificationExpiry: undefined,
        emailVerificationConsumedAt: undefined,
      }),
    ).resolves.toBeDefined();
  });
});
