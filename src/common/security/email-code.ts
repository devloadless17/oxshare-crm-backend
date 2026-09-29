import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

/**
 * The 6-digit code mailed beside the verification link — a pure seam.
 *
 * ## Why a code, when the link already verified the address
 *
 * The client asked for it (25 Sep 2026): register, type the code from the email
 * on the screen in front of you, and be signed straight in. A link opens a new
 * tab, often on a different device, and leaves the registration screen waiting
 * for nothing; a code keeps the person where they started. The link stays in
 * the same email as the fallback.
 *
 * ## Why the code is SAFE despite being six digits
 *
 * A million values is nothing to a computer, so every property below is doing
 * work:
 *
 *   keyed hash      HMAC-SHA256 under a server secret — NOT the plain SHA-256
 *                   `hashEmailedToken` uses for 122-bit links. A digest of a
 *                   6-digit value falls to a dump in a second; this one needs
 *                   the secret too. Bound to the user id and domain-separated,
 *                   so a hash cannot be replayed onto another row or confused
 *                   with any other HMAC made under the same key.
 *   5 attempts      then the code is burned (`UsersStore.takeEmailCodeAttempt`
 *                   counts atomically, before comparing).
 *   15 minutes      a code is for the screen in front of you.
 *   single use      consumed in one conditional statement.
 *   30 s cooldown   between codes, enforced in the issuing UPDATE.
 *
 * Five guesses at one in a million is a 0.0005% chance per code, and every new
 * code costs the attacker a mailed round trip they cannot read.
 */

export const EMAIL_CODE_LENGTH = 6;
export const EMAIL_CODE_TTL_MS = 15 * 60_000;
export const EMAIL_CODE_MAX_ATTEMPTS = 5;
export const EMAIL_CODE_RESEND_COOLDOWN_MS = 30_000;

/** A fresh code — `randomInt` is uniform, and the leading zeros are kept. */
export function newEmailCode(): string {
  return String(randomInt(0, 10 ** EMAIL_CODE_LENGTH)).padStart(EMAIL_CODE_LENGTH, '0');
}

/** The stored form of a code: HMAC-SHA256 under `secret`, bound to the user. */
export function hashEmailCode(secret: string, userId: number, code: string): string {
  if (!secret) throw new Error('hashEmailCode: no secret — refusing to hash a code without one.');
  return createHmac('sha256', secret)
    .update(`oxshare/email-code/v1\u0000${userId}\u0000${code}`, 'utf8')
    .digest('hex');
}

/** Constant-time equality of two stored hashes. */
export function sameEmailCodeHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}
