import { createHash } from 'node:crypto';

/**
 * The one hash for emailed single-use tokens — password reset AND email
 * verification.
 *
 * ## Why it is shared rather than written where it is used
 *
 * It lived inside `auth.service.ts` while reset was its only caller. Email
 * verification then became a second caller, and `AdminClientsService.changeEmail`
 * a third — at which point an inline `createHash('sha256')…` had been copied
 * into a module that cannot see the original. Two independent spellings of the
 * same digest is not a style problem: the day either one changes, links issued
 * by one path stop matching rows written by the other, and the symptom is
 * "verification is broken for clients whose email an admin edited" — a bug that
 * reads like anything except a hash mismatch.
 *
 * A shared function makes the two physically the same.
 *
 * ## Why SHA-256 and not argon2id
 *
 * A fast hash on purpose, for the reason `hashApiKey` gives: the token is 122
 * bits of randomness from `randomUUID`, so there is no guessable secret for a
 * slow KDF to protect. argon2 here would buy nothing and add latency to an
 * UNAUTHENTICATED lookup an attacker can trigger at will.
 *
 * What this defends against is a database dump, a leaked backup or a read-only
 * SQL injection being replayable as working reset and verification links — and
 * for that, a digest of a high-entropy value is sufficient.
 *
 * It is also what lets `users.email_verification_token_hash` OUTLIVE its own
 * redemption, which is what makes a second click answerable with "already
 * verified" instead of "invalid". A hash is not a credential; the token it came
 * from was. See the column comment in `schema.ts`.
 */
export function hashEmailedToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
