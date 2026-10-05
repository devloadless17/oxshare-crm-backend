import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  generateTotpSecret,
  totpCode,
  totpStepAt,
  totpUri,
  verifyTotp,
} from '../src/common/security/totp';

/** RFC 6238 Appendix B's SHA-1 key: ASCII "12345678901234567890". */
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

describe('TOTP (RFC 6238) — what Google Authenticator computes', () => {
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ])('matches the RFC test vector at T=%i', (seconds, expected) => {
    // The RFC lists 8-digit codes; the apps show the last 6 of the same value.
    expect(totpCode(RFC_SECRET, totpStepAt(new Date(seconds * 1000)))).toBe(expected);
  });

  it('base32 round-trips and decodes leniently (spaces, case, padding)', () => {
    const bytes = Buffer.from('any bytes at all ÿ', 'utf8');
    const encoded = base32Encode(bytes);
    expect(base32Decode(encoded)).toEqual(bytes);
    expect(base32Decode(encoded.toLowerCase().replace(/(.{4})/g, '$1 ') + '==')).toEqual(bytes);
    expect(() => base32Decode('not base32!')).toThrow();
  });

  it('generates 160-bit secrets, a different one each time', () => {
    const a = generateTotpSecret();
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(a)).toHaveLength(20);
    expect(generateTotpSecret()).not.toBe(a);
  });
});

describe('verifyTotp', () => {
  const now = new Date(1_800_000_000_000);
  const step = totpStepAt(now);
  const secret = generateTotpSecret();

  it('accepts the current code, and says which step', () => {
    expect(verifyTotp(secret, totpCode(secret, step), now)).toBe(step);
  });

  it('NO grace window: the previous and next codes are refused', () => {
    expect(verifyTotp(secret, totpCode(secret, step - 1), now)).toBeNull();
    expect(verifyTotp(secret, totpCode(secret, step + 1), now)).toBeNull();
    expect(verifyTotp(secret, totpCode(secret, step - 2), now)).toBeNull();
  });

  it('a code dies the instant its 30 seconds end', () => {
    const start = new Date(step * 30_000);
    const code = totpCode(secret, step);
    expect(verifyTotp(secret, code, new Date(start.getTime() + 29_999))).toBe(step);
    expect(verifyTotp(secret, code, new Date(start.getTime() + 30_000))).toBeNull();
  });

  it('refuses anything at or below the last accepted step — no replay', () => {
    const code = totpCode(secret, step);
    expect(verifyTotp(secret, code, now, step)).toBeNull();
    expect(verifyTotp(secret, code, now, step + 1)).toBeNull();
    expect(
      verifyTotp(secret, totpCode(secret, step + 1), new Date(now.getTime() + 30_000), step),
    ).toBe(step + 1);
  });

  it('refuses another secret’s code and malformed input', () => {
    const other = generateTotpSecret();
    expect(verifyTotp(secret, totpCode(other, step), now)).toBeNull();
    for (const bad of ['', '12345', '1234567', 'abcdef', '12a456']) {
      expect(verifyTotp(secret, bad, now)).toBeNull();
    }
  });

  it('tolerates the space the apps display in the middle', () => {
    const code = totpCode(secret, step);
    expect(verifyTotp(secret, `${code.slice(0, 3)} ${code.slice(3)}`, now)).toBe(step);
  });
});

describe('totpUri', () => {
  it('names the issuer in the label AND the parameter, and escapes the account', () => {
    const uri = totpUri('OxShare Admin', 'ada+ops@bbcorp.trade', 'JBSWY3DPEHPK3PXP');
    expect(uri).toBe(
      'otpauth://totp/OxShare%20Admin%3Aada%2Bops%40bbcorp.trade' +
        '?secret=JBSWY3DPEHPK3PXP&issuer=OxShare+Admin&algorithm=SHA1&digits=6&period=30',
    );
  });
});
