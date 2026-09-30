import { createHash, createHmac, timingSafeEqual } from 'crypto';

/**
 * Verification for inbound Rival CRM webhook deliveries — a pure seam.
 *
 * No Nest, no Drizzle, no clock of its own (`nowSeconds` is injectable): every
 * boundary case is one assertion in `rival-signature.spec.ts`, and the
 * controller stays a mapping layer. Ported from the PSP portal's
 * `crmSignature.ts`, which has verified the same deliveries in production.
 *
 * Rival authenticates twice on every delivery, and both are checked:
 *
 *   Authorization: Bearer <key>                    — the key WE minted for it
 *   x-crm-signature: t=<unixSeconds>,sha256=<hex>  — HMAC-SHA256 of
 *                                                    `${t}.${rawBody}`, keyed
 *                                                    by that same key
 *
 * The timestamp is repeated in `x-crm-timestamp` and must agree with the
 * signed `t` — disagreement is tampering, not skew. ±300s bounds how long a
 * captured request stays valid; the replay NONCE (claimed by the caller after
 * this returns ok) closes the window it leaves open, per R-5.3.
 *
 * ⚠️ `rawBody` must be the EXACT bytes received (`req.rawBody`; `rawBody: true`
 * is set in main.ts). Re-serialising parsed JSON changes key order and
 * whitespace, and the HMAC will never match — the spec pins this.
 */

export type RivalVerifyResult =
  { ok: true; timestamp: number; signature: string } | { ok: false; reason: string };

export interface RivalVerifyInput {
  rawBody: string;
  /** Lower-cased header lookup — Express's `req.headers` shape. */
  header: (name: string) => string | undefined;
  secret: string;
  /** Max clock skew / replay window, in seconds. */
  toleranceSeconds?: number;
  /** Injectable for tests; defaults to now. */
  nowSeconds?: number;
}

/**
 * Constant-time compare that cannot leak length through an early return.
 * `timingSafeEqual` throws on length mismatch, so both sides are first mapped
 * through a fixed-size keyed digest — equal length, no early exit.
 */
function safeEqual(a: string, b: string): boolean {
  const ah = createHmac('sha256', 'cmp').update(Buffer.from(a, 'utf8')).digest();
  const bh = createHmac('sha256', 'cmp').update(Buffer.from(b, 'utf8')).digest();
  return timingSafeEqual(ah, bh);
}

/**
 * Short, non-reversible fingerprint of a key — safe for log lines and audit
 * rows. It cannot be turned back into the secret, but it tells an operator at
 * a glance whether the caller is sending a DIFFERENT key or a corrupted
 * signature: "they sent fp=…, we expect fp=…" is the difference between
 * "re-paste the key into Rival" and "investigate the delivery".
 */
export function keyFingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

/**
 * A unix-seconds timestamp, parsed STRICTLY: digits only, or null.
 *
 * Not `Number()` — the money-path lint bans it in this module, and although a
 * timestamp is not money, the strictness it was chosen for is still wanted
 * here ("123abc" must not verify as 123). The regex carries that strictness;
 * `Number.parseInt` then cannot be surprised.
 */
function parseUnixSeconds(value: string): number | null {
  if (!/^\d{1,12}$/.test(value)) return null;
  return Number.parseInt(value, 10);
}

/** `t=1781018591,sha256=<hex>` — tolerant of spaces and unknown extra parts. */
function parseSignature(headerValue: string): { t: number; sha256: string } | null {
  let t: number | null = null;
  let sha256: string | null = null;
  for (const part of headerValue.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') {
      t = parseUnixSeconds(value);
    } else if (key === 'sha256') {
      sha256 = value;
    }
  }
  if (t === null || !sha256) return null;
  return { t, sha256 };
}

export function verifyRivalDelivery({
  rawBody,
  header,
  secret,
  toleranceSeconds = 300,
  nowSeconds,
}: RivalVerifyInput): RivalVerifyResult {
  if (!secret) return { ok: false, reason: 'no webhook key configured' };

  const auth = header('authorization') ?? '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!bearer) return { ok: false, reason: 'missing bearer token' };
  if (!safeEqual(bearer, secret)) {
    return {
      ok: false,
      reason:
        `bearer token mismatch (they sent fp=${keyFingerprint(bearer)}, we expect ` +
        `fp=${keyFingerprint(secret)}) — re-paste the key from Settings → Payments into ` +
        'Rival → CRM config',
    };
  }

  const sigHeader = header('x-crm-signature');
  if (!sigHeader) return { ok: false, reason: 'missing x-crm-signature' };

  const parsed = parseSignature(sigHeader);
  if (!parsed) return { ok: false, reason: 'malformed x-crm-signature' };
  const { t, sha256 } = parsed;

  // Sent twice; disagreement means tampering, not skew. A header present but
  // unparseable is a disagreement, not an absence.
  const tsHeader = header('x-crm-timestamp');
  if (tsHeader !== undefined && parseUnixSeconds(tsHeader.trim()) !== t) {
    return { ok: false, reason: 'x-crm-timestamp does not match signature timestamp' };
  }

  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > toleranceSeconds) {
    return { ok: false, reason: `timestamp outside ${toleranceSeconds}s window` };
  }

  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  if (!safeEqual(sha256.toLowerCase(), expected)) {
    return { ok: false, reason: 'signature mismatch' };
  }

  return { ok: true, timestamp: t, signature: sha256.toLowerCase() };
}

/** Sign a body the way Rival does — for the specs and local verification. */
export function signRivalBody(
  rawBody: string,
  secret: string,
  timestamp: number,
): { timestamp: number; signature: string } {
  const sha256 = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return { timestamp, signature: `t=${timestamp},sha256=${sha256}` };
}
