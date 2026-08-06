import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { ValidationError } from '../errors/domain-errors';

/**
 * Authenticated encryption for the handful of secrets this system stores at rest.
 *
 * Today that is exactly one column — `smtp_settings.password_ciphertext`. It
 * earns a real primitive rather than an inline `createCipheriv` call because the
 * mistakes here are silent: a reused IV, a dropped auth tag, a decrypt that
 * accepts tampered input. None of those produce a failing test unless the
 * primitive is written to make them impossible.
 *
 * ── Why GCM, and why the tag is not optional ────────────────────────────────
 *
 * AES-256-CBC would encrypt this fine and would let anyone with write access to
 * the database FLIP BITS in the ciphertext without detection. For an SMTP host
 * that is not academic: the row already decides where this system's
 * password-reset and admin-invite links get delivered. GCM authenticates, so a
 * modified row fails to decrypt instead of silently decrypting to something an
 * attacker steered.
 *
 * ── The encoding ───────────────────────────────────────────────────────────
 *
 * `v1.<iv>.<tag>.<ciphertext>`, each part base64url.
 *
 * VERSIONED FROM THE FIRST WRITE, because the alternative is discovering at
 * rotation time that every stored value is in an unmarked format and there is no
 * way to tell old from new. A `v2` reader can dispatch on the prefix; a reader
 * of unmarked blobs can only guess.
 *
 * ── The key ────────────────────────────────────────────────────────────────
 *
 * `APP_ENCRYPTION_KEY`, hashed to 32 bytes with SHA-256 so any sufficiently long
 * passphrase works and the caller is never asked to produce exactly 32 raw
 * bytes. `env.validation.ts` enforces a 32-character minimum on the input and
 * requires it in production.
 *
 * There is deliberately NO fallback key. A default here would mean every
 * deployment that forgot to set one shares a key published in this repository,
 * which is the same defect `env.validation.ts` documents for `JWT_SECRET` — and
 * it would be worse, because the failure is invisible until someone reads the
 * source. Encrypting without a key throws instead.
 */

/** The current format tag. Bump only alongside a reader that knows both. */
const VERSION = 'v1';

/** GCM's standard 96-bit nonce — the size the mode is defined and analysed for. */
const IV_BYTES = 12;

function keyFrom(rawKey: string | undefined): Buffer {
  if (!rawKey) {
    throw new ValidationError(
      'APP_ENCRYPTION_KEY is not set, so this secret cannot be stored. It is the key that ' +
        'encrypts the SMTP password at rest; generate one with `openssl rand -base64 48` and ' +
        'add it to the environment. There is no default on purpose — a built-in key would be ' +
        'published in this repository and shared by every deployment that forgot to set one.',
    );
  }
  return createHash('sha256').update(rawKey, 'utf8').digest();
}

/**
 * Encrypt a secret for storage. Returns the `v1.…` encoding above.
 *
 * A fresh random IV per call, which is the property GCM's security depends on:
 * reusing one under the same key leaks the XOR of the two plaintexts and breaks
 * the authentication outright.
 */
export function sealSecret(plaintext: string, rawKey: string | undefined): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(rawKey), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/**
 * Decrypt a stored secret.
 *
 * Throws on a wrong key, a tampered value, or an unknown version — never
 * returns a partial or a best guess. The caller is sending mail with whatever
 * comes back, so "probably the password" is not a useful answer.
 */
export function openSecret(sealed: string, rawKey: string | undefined): string {
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new ValidationError(
      `Stored secret is not in the expected ${VERSION} format and cannot be read.`,
    );
  }

  const [, ivPart, tagPart, ciphertextPart] = parts;
  const decipher = createDecipheriv(
    'aes-256-gcm',
    keyFrom(rawKey),
    Buffer.from(ivPart, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));

  try {
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextPart, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    /*
     * The underlying error is "Unsupported state or unable to authenticate
     * data", which names neither cause. Both causes matter and the operator can
     * act on both, so say them — while deliberately not echoing any part of the
     * ciphertext or the key into the message.
     */
    throw new ValidationError(
      'The stored SMTP password could not be decrypted. Either APP_ENCRYPTION_KEY has changed ' +
        'since it was saved, or the stored value was modified. Re-enter the password to store ' +
        'it again under the current key.',
    );
  }
}
