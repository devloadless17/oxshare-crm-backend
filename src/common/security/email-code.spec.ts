import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { hashEmailCode, newEmailCode, sameEmailCodeHash } from './email-code';

/**
 * The 6-digit email code's own rules — see `email-code.ts` for why each one is
 * what makes a code that short safe.
 */

const SECRET = 'a-test-secret-that-is-long-enough-000';

describe('newEmailCode', () => {
  it('is always exactly six digits, leading zeros kept', () => {
    const codes = Array.from({ length: 5_000 }, () => newEmailCode());
    expect(codes.every((code) => /^\d{6}$/.test(code))).toBe(true);
    // A uniform draw over a million puts ~10% of five thousand below 100000.
    expect(codes.some((code) => code.startsWith('0'))).toBe(true);
  });

  it('does not repeat itself in any way a guesser could use', () => {
    expect(new Set(Array.from({ length: 1_000 }, () => newEmailCode())).size).toBeGreaterThan(990);
  });
});

describe('hashEmailCode', () => {
  it('is keyed: the same code hashes differently under another secret, and never to a plain digest', () => {
    const hash = hashEmailCode(SECRET, 1000001, '123456');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(hashEmailCode(`${SECRET}-rotated`, 1000001, '123456'));
    expect(hash).not.toBe(createHash('sha256').update('123456').digest('hex'));
  });

  it('is bound to the user: one row’s hash does not match another’s', () => {
    expect(hashEmailCode(SECRET, 1000001, '123456')).not.toBe(
      hashEmailCode(SECRET, 1000002, '123456'),
    );
  });

  it('is deterministic, so a presented code can be checked', () => {
    expect(hashEmailCode(SECRET, 1000001, '000042')).toBe(hashEmailCode(SECRET, 1000001, '000042'));
  });

  it('refuses to hash without a secret rather than hashing weakly', () => {
    expect(() => hashEmailCode('', 1000001, '123456')).toThrow(/no secret/);
  });
});

describe('sameEmailCodeHash', () => {
  const a = hashEmailCode(SECRET, 1000001, '123456');

  it('matches only the identical hash', () => {
    expect(sameEmailCodeHash(a, a)).toBe(true);
    expect(sameEmailCodeHash(a, hashEmailCode(SECRET, 1000001, '123457'))).toBe(false);
  });

  it('is false, never a throw, for a malformed or empty stored value', () => {
    expect(sameEmailCodeHash(a, '')).toBe(false);
    expect(sameEmailCodeHash(a, 'abcd')).toBe(false);
    expect(sameEmailCodeHash('', '')).toBe(false);
  });
});
