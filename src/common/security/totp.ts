import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Time-based one-time passwords (RFC 6238) — the codes Google Authenticator,
 * Microsoft Authenticator, 1Password and every other authenticator app show.
 *
 * Written against `node:crypto` rather than pulled in as a package because the
 * whole algorithm is an HMAC over a counter, and the parameters are fixed by
 * what the apps accept without asking: SHA-1, 6 digits, 30-second steps. Those
 * are the `otpauth://` defaults; Google Authenticator ignores anything else, so
 * "configurable" here would only mean "able to issue codes the app cannot read".
 *
 * Pure: no DB, no clock of its own (the caller passes `now`), so every branch —
 * the window edges, the replay floor — is asserted directly in totp.spec.ts.
 */

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;

/**
 * Steps either side of "now" a code is still accepted for — one, i.e. a code
 * is good for up to ~90 seconds. RFC 6238 §5.2 recommends at most one step of
 * skew; a phone whose clock drifts further than that is a phone to fix, and a
 * wider window is more codes an attacker gets to try per guess.
 */
const WINDOW = 1;

/** 160 bits — the RFC 4226 §4 recommendation, and what the apps generate themselves. */
const SECRET_BYTES = 20;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** Lenient on the way in — spaces, lower case and `=` padding — as people type secrets. */
export function base32Decode(input: string): Buffer {
  const clean = input.replace(/[\s=]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new Error('Not a base32 secret.');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh secret, base32 — the form the QR code and the "enter manually" text both carry. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES));
}

/** The 30-second step `now` falls in. */
export function totpStepAt(now: Date): number {
  return Math.floor(now.getTime() / 1000 / TOTP_PERIOD_SECONDS);
}

/** The code for one step (RFC 4226 HOTP with the step as the counter). */
export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/**
 * The step a code belongs to, or `null` when it matches none in the window.
 *
 * `lastStep` is the step of the last code this secret accepted. Anything at or
 * below it is refused — RFC 6238 §5.2: "the verifier MUST NOT accept the second
 * attempt of the same OTP". Without it a code read over a shoulder, or out of a
 * proxy log, signs in a second time for the next minute and a half. The caller
 * must then RECORD the returned step, conditionally, so two requests racing
 * with the same code cannot both win.
 */
export function verifyTotp(
  secret: string,
  code: string,
  now: Date,
  lastStep: number | null = null,
): number | null {
  const typed = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(typed)) return null;
  const current = totpStepAt(now);
  // Every candidate is computed and compared, so the time taken does not say
  // which step (if any) matched.
  let matched: number | null = null;
  for (let step = current - WINDOW; step <= current + WINDOW; step++) {
    if (lastStep !== null && step <= lastStep) continue;
    if (timingSafeEqual(Buffer.from(totpCode(secret, step)), Buffer.from(typed))) {
      matched ??= step;
    }
  }
  return matched;
}

/**
 * The `otpauth://` URI an authenticator app reads from the QR code.
 *
 * The label is `Issuer:account` AND the `issuer` parameter is set: the apps
 * group and name entries by the parameter, older ones by the label prefix.
 */
export function totpUri(issuer: string, account: string, secret: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
