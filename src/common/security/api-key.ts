import { createHash } from 'node:crypto';

/**
 * The API-key primitive: the token format, and the one way to hash it.
 *
 * ── Why this is its own file ───────────────────────────────────────────────
 *
 * `ApiKeysService` (which ISSUES keys) and `AdminAuthenticator` (which VERIFIES
 * them) both need this, and the guard importing the admin service would be a
 * module cycle. More importantly, two spellings of the hash would mean no key
 * ever authenticates — a failure that looks like a broken integration rather
 * than like the mismatch it is. One definition, imported by both sides.
 *
 * ── The token format ───────────────────────────────────────────────────────
 *
 *     oxs_live_<43 chars of base64url>
 *      │    │    └── 32 bytes from randomBytes: the secret
 *      │    └── environment marker, so a staging key is visibly not production
 *      └── vendor tag, so a leaked key is greppable and attributable
 *
 * The fixed prefix is not decoration. Secret scanners key on exactly this shape
 * — a bare random string committed to a public repository is invisible to them,
 * where `oxs_live_…` is a pattern a scanner can be taught and a human can
 * recognise in a log.
 */

/** The vendor + environment tag every key carries. */
export const API_KEY_TOKEN_PREFIX = 'oxs_live_';

/** Bytes of entropy in the secret half. 32 is 256 bits — not brute-forceable. */
export const API_KEY_SECRET_BYTES = 32;

/**
 * How much of the token is stored in the clear, for display.
 *
 * The vendor tag, the environment, and a few characters of entropy: enough to
 * tell two keys apart in a list and to match a key found in a log against a
 * row, and far too little to authenticate with.
 */
export const API_KEY_STORED_PREFIX_LENGTH = 16;

/**
 * SHA-256, hex — NOT argon2id, and the difference is reasoned rather than lazy.
 *
 * `admins.password_hash` uses argon2id because a password is low-entropy and
 * human-chosen, so it must survive an offline crack. This value is 32 bytes of
 * `randomBytes`: brute force is not a threat model, and it is presented on
 * EVERY request, where a deliberately slow hash would be a self-inflicted
 * denial of service. High entropy and a fast hash are one decision, not two.
 */
export function hashApiKey(plaintext: string): string {
  return createHash('sha256').update(plaintext, 'utf8').digest('hex');
}

/**
 * The machine credential on a request, if any — `X-Api-Key`, or a bearer token
 * carrying the key prefix.
 *
 * Lives here rather than in the admin guard because TWO readers need one
 * answer: `AdminAuthenticator` (which authenticates the key) and `CsrfGuard`
 * (which must not demand an anti-forgery token of a caller that holds no
 * cookie). A header credential cannot be attached by a cross-site form, so a
 * request presenting one is outside the CSRF threat model entirely — and the
 * authenticator prefers the key UNCONDITIONALLY when one is present, so a
 * forged key sent beside a real cookie ends in a 401 on the key, never in a
 * cookie-authenticated write that skipped the token check.
 *
 * `headers` is defaulted rather than assumed: this runs FIRST on every admin
 * request, ahead of the cookie path, and a hand-built request object in a unit
 * spec must be refused with a 401 rather than crash with a TypeError.
 */
export function readApiKeyHeader(req: {
  headers?: Record<string, string | string[] | undefined>;
}): string | null {
  const headers = req.headers ?? {};

  const header = headers['x-api-key'];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  if (fromHeader) return fromHeader.trim();

  const auth = headers.authorization;
  const bearer = Array.isArray(auth) ? auth[0] : auth;
  if (bearer?.startsWith('Bearer ')) {
    const value = bearer.slice('Bearer '.length).trim();
    if (value.startsWith(API_KEY_TOKEN_PREFIX)) return value;
  }
  return null;
}
