import { describe, expect, it } from 'vitest';
import { openSecret, sealSecret } from '../src/common/security/secret-box';

/**
 * The at-rest encryption behind `smtp_settings.password_ciphertext`.
 *
 * Every assertion here is about a failure that is SILENT if the primitive is
 * written carelessly: a reused nonce, a dropped authentication tag, a decrypt
 * that accepts a modified value. None of them break a happy-path test, which is
 * exactly why they are pinned individually.
 */

const KEY = 'a-test-key-that-is-at-least-32-characters-long';
const OTHER_KEY = 'a-different-key-also-at-least-32-characters-long';

describe('sealSecret / openSecret', () => {
  it('round-trips a password', () => {
    const sealed = sealSecret('hunter2', KEY);
    expect(openSecret(sealed, KEY)).toBe('hunter2');
  });

  it('never stores the plaintext', () => {
    // The obvious catastrophe, and the cheapest thing to assert.
    expect(sealSecret('hunter2', KEY)).not.toContain('hunter2');
  });

  it('produces different ciphertext each time for the same input', () => {
    /*
     * A fresh IV per call. GCM's security collapses if a nonce repeats under one
     * key — it leaks the XOR of the plaintexts and breaks the authentication —
     * and a deterministic output would also let anyone with read access to the
     * column tell that two deployments share an SMTP password.
     */
    const a = sealSecret('hunter2', KEY);
    const b = sealSecret('hunter2', KEY);
    expect(a).not.toBe(b);
    expect(openSecret(a, KEY)).toBe(openSecret(b, KEY));
  });

  it('carries a version tag so the format can change later', () => {
    expect(sealSecret('hunter2', KEY).startsWith('v1.')).toBe(true);
  });

  it('refuses a value encrypted under a different key', () => {
    const sealed = sealSecret('hunter2', KEY);
    expect(() => openSecret(sealed, OTHER_KEY)).toThrow(/could not be decrypted/i);
  });

  it('refuses a modified ciphertext rather than returning garbage', () => {
    /*
     * The property CBC would not give us. Anyone with write access to the row
     * could otherwise flip bits in the stored password, and the failure would
     * surface as a mysterious authentication error at the relay rather than as
     * evidence the row was tampered with.
     */
    const sealed = sealSecret('hunter2', KEY);
    const [version, iv, tag, ciphertext] = sealed.split('.');
    const flipped = Buffer.from(ciphertext, 'base64url');
    flipped[0] ^= 0xff;
    const tampered = [version, iv, tag, flipped.toString('base64url')].join('.');

    expect(() => openSecret(tampered, KEY)).toThrow(/could not be decrypted/i);
  });

  it('refuses a modified authentication tag', () => {
    const sealed = sealSecret('hunter2', KEY);
    const [version, iv, tag, ciphertext] = sealed.split('.');
    const flipped = Buffer.from(tag, 'base64url');
    flipped[0] ^= 0xff;

    expect(() =>
      openSecret([version, iv, flipped.toString('base64url'), ciphertext].join('.'), KEY),
    ).toThrow(/could not be decrypted/i);
  });

  it('refuses an unknown format instead of guessing', () => {
    expect(() => openSecret('v2.a.b.c', KEY)).toThrow(/expected v1 format/i);
    expect(() => openSecret('not-sealed-at-all', KEY)).toThrow(/expected v1 format/i);
  });

  it('refuses to encrypt with no key, and says how to make one', () => {
    /*
     * There is deliberately no fallback key. A default would be published in
     * this repository and shared by every deployment that forgot to set one —
     * the same defect `env.validation.ts` refuses to boot over for JWT_SECRET.
     */
    expect(() => sealSecret('hunter2', undefined)).toThrow(/APP_ENCRYPTION_KEY is not set/);
    expect(() => sealSecret('hunter2', '')).toThrow(/openssl rand/);
  });

  it('handles a password with characters that would break a naive encoding', () => {
    const awkward = 'p@ss.word.with.dots+and/slashes=and-emoji-🔐';
    expect(openSecret(sealSecret(awkward, KEY), KEY)).toBe(awkward);
  });

  it('handles an empty string distinctly from no password', () => {
    // The store maps "no password" to a null column, so an empty plaintext must
    // still round-trip rather than being conflated with absence here.
    expect(openSecret(sealSecret('', KEY), KEY)).toBe('');
  });
});
