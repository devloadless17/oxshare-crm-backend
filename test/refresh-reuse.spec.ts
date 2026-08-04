import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import * as bcrypt from 'bcryptjs';
import { MoneyTestContext, startMoneyTestDb, stopMoneyTestDb } from './money-setup';
import { closeDb, resetDb } from '../src/database/db';
import { refreshTokens, users } from '../src/database/schema';
import { RefreshTokensService } from '../src/common/security/refresh-tokens.service';
import { PasswordService } from '../src/common/security/password.service';

/**
 * PLATFORM-CONVENTIONS R-3.3 and R-3.4.
 *
 * Rotation was already correct. What these pin is the question rotation leaves
 * open: an already-rotated token comes back — what then?
 *
 * It comes back for exactly one reason: somebody kept a copy. The previous
 * behaviour was "the stored hash no longer matches, so this request fails",
 * which let an attacker holding a stolen token simply use the newer one they had
 * also captured, with nothing anywhere recording that a credential had leaked.
 */

let ctx: MoneyTestContext;
let service: RefreshTokensService;
let subjectId: string;

const TTL = 30 * 24 * 60 * 60 * 1000;
const expires = () => new Date(Date.now() + TTL);

beforeAll(async () => {
  resetDb();
  ctx = await startMoneyTestDb();
  service = new RefreshTokensService(ctx.db);
  const [user] = await ctx.db
    .insert(users)
    .values({ email: 'reuse@test.local', passwordHash: 'x', firstName: 'R', lastName: 'U' })
    .returning();
  subjectId = user.id;
}, 180_000);

afterAll(async () => {
  await closeDb();
  await stopMoneyTestDb(ctx);
});

/** Starts a session and returns the first token in its family. */
async function login() {
  const jti = randomUUID();
  const token = `token-${randomUUID()}`;
  const { familyId } = await service.record({
    surface: 'portal',
    subjectId,
    jti,
    token,
    expiresAt: expires(),
  });
  return { jti, token, familyId };
}

/** One legitimate rotation, returning the replacement. */
async function rotate(current: { jti: string; token: string; familyId: string }) {
  const jtiNext = randomUUID();
  const nextToken = `token-${randomUUID()}`;
  const rotated = await service.rotate({
    surface: 'portal',
    jti: current.jti,
    familyId: current.familyId,
    subjectId,
    jtiNext,
    nextToken,
    expiresAt: expires(),
  });
  expect(rotated).not.toBeNull();
  return { jti: jtiNext, token: nextToken, familyId: current.familyId };
}

describe('R-3.3 refresh-token families', () => {
  it('accepts a fresh token and rotates it exactly once', async () => {
    const first = await login();
    await expect(
      service.verify({ surface: 'portal', jti: first.jti, token: first.token }),
    ).resolves.toMatchObject({ outcome: 'ok' });
    const second = await rotate(first);
    expect(second.jti).not.toBe(first.jti);
  });

  it('DETECTS a replayed token and kills the whole family', async () => {
    // The scenario: the token is stolen, the real user refreshes normally, then
    // the thief presents the copy they kept.
    const first = await login();
    const second = await rotate(first);
    const third = await rotate(second);

    const verdict = await service.verify({
      surface: 'portal',
      jti: first.jti,
      token: first.token,
    });
    expect(verdict.outcome).toBe('reused');

    // Every descendant dies, INCLUDING the newest one — which is the token the
    // attacker would otherwise still be holding. Previously the replay just
    // failed and they carried on with the newer copy.
    for (const token of [first, second, third]) {
      const [row] = await ctx.db
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.id, token.jti));
      expect(row.revokedAt, `${token.jti} should be revoked`).not.toBeNull();
    }

    await expect(
      service.verify({ surface: 'portal', jti: third.jti, token: third.token }),
    ).resolves.toMatchObject({ outcome: 'revoked' });
  });

  it('refuses a forged token that merely guesses a real jti', async () => {
    // The jti is NOT secret — it rides in a readable JWT payload. Without the
    // hash check, knowing one would be enough to be told the family is fine.
    const session = await login();
    await expect(
      service.verify({ surface: 'portal', jti: session.jti, token: 'not-the-real-token' }),
    ).resolves.toMatchObject({ outcome: 'unknown' });
  });

  it('will not rotate the same token twice, even under a race', async () => {
    // Two refreshes arriving together must not both succeed: that would put two
    // live children under a token meant to have exactly one.
    const session = await login();

    const attempts = await Promise.all(
      Array.from({ length: 10 }, () =>
        service.rotate({
          surface: 'portal',
          jti: session.jti,
          familyId: session.familyId,
          subjectId,
          jtiNext: randomUUID(),
          nextToken: `token-${randomUUID()}`,
          expiresAt: expires(),
        }),
      ),
    );

    expect(attempts.filter(Boolean)).toHaveLength(1);
  });

  it('keeps the two surfaces separate', async () => {
    // R-3.1: an admin credential must be worthless on the portal. A token id is
    // only ever looked up within its own surface.
    const session = await login();
    await expect(
      service.verify({ surface: 'admin', jti: session.jti, token: session.token }),
    ).resolves.toMatchObject({ outcome: 'unknown' });
  });

  it('revokes every family for a subject, not just the one presenting a token', async () => {
    // Logging out on one device, or being suspended, must end the other devices
    // too — otherwise "log out everywhere" silently means "log out here".
    const laptop = await login();
    const phone = await login();
    expect(laptop.familyId).not.toBe(phone.familyId);

    await service.revokeAllForSubject('portal', subjectId);

    for (const session of [laptop, phone]) {
      await expect(
        service.verify({ surface: 'portal', jti: session.jti, token: session.token }),
      ).resolves.toMatchObject({ outcome: 'revoked' });
    }
  });

  it('treats an expired token as expired rather than valid', async () => {
    const jti = randomUUID();
    const token = `token-${randomUUID()}`;
    await service.record({
      surface: 'portal',
      subjectId,
      jti,
      token,
      expiresAt: new Date(Date.now() - 1000),
    });
    await expect(service.verify({ surface: 'portal', jti, token })).resolves.toMatchObject({
      outcome: 'expired',
    });
  });
});

describe('R-3.4 password hashing', () => {
  const passwords = new PasswordService();

  it('hashes new passwords with argon2id', async () => {
    const hash = await passwords.hash('correct horse battery staple');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(passwords.isLegacy(hash)).toBe(false);
  });

  it('verifies its own hashes and rejects the wrong password', async () => {
    const hash = await passwords.hash('s3cret-passphrase');
    await expect(passwords.verify('s3cret-passphrase', hash)).resolves.toMatchObject({
      valid: true,
      needsRehash: false,
    });
    await expect(passwords.verify('wrong', hash)).resolves.toMatchObject({ valid: false });
  });

  it('still accepts an existing bcrypt hash, and asks to be upgraded', async () => {
    // The whole point of dual-read: every account created before this change
    // keeps working, and nobody is forced to reset a password they already have.
    const legacy = bcrypt.hashSync('legacy-password', 10);
    expect(passwords.isLegacy(legacy)).toBe(true);

    await expect(passwords.verify('legacy-password', legacy)).resolves.toMatchObject({
      valid: true,
      needsRehash: true,
    });
  });

  it('does NOT ask to rehash after a failed attempt', async () => {
    // Rehashing from a failed verify would store a hash of the wrong password.
    const legacy = bcrypt.hashSync('legacy-password', 10);
    await expect(passwords.verify('guess', legacy)).resolves.toMatchObject({
      valid: false,
      needsRehash: false,
    });
  });

  it('fails closed on an unreadable hash instead of throwing', async () => {
    // A corrupt row must not surface as a 500 from the login handler, which
    // tells an attacker they found something interesting.
    await expect(passwords.verify('anything', 'not-a-hash-at-all')).resolves.toMatchObject({
      valid: false,
    });
  });

  it('does not truncate a long passphrase the way bcrypt does', async () => {
    // bcrypt silently ignores everything past 72 bytes, so these two differ only
    // in a region bcrypt never reads — and it would accept either for the other.
    const base = 'x'.repeat(72);
    const hash = await passwords.hash(`${base}FIRST`);
    await expect(passwords.verify(`${base}SECOND`, hash)).resolves.toMatchObject({ valid: false });
  });
});
