import { describe, expect, it } from 'vitest';
import { createHmac } from 'crypto';
import { constantTimeEquals } from './mt5-webhook.controller';

// The deal feed mints commission. If a stranger can post to it, they can pay
// themselves — so the signature check gets its own tests.

const sign = (secret: string, body: string) =>
  createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex');

describe('bridge signature verification', () => {
  const secret = 'bridge-secret-value';
  const body = JSON.stringify({ deals: [{ ticket: 1, login: 500001 }] });

  it('accepts a signature produced from the same secret and bytes', () => {
    expect(constantTimeEquals(sign(secret, body), sign(secret, body))).toBe(true);
  });

  it('rejects a signature made with a different secret', () => {
    expect(constantTimeEquals(sign('wrong-secret', body), sign(secret, body))).toBe(false);
  });

  it('rejects a signature for different bytes — a tampered payload', () => {
    const tampered = JSON.stringify({ deals: [{ ticket: 1, login: 999999 }] });
    expect(constantTimeEquals(sign(secret, tampered), sign(secret, body))).toBe(false);
  });

  it('rejects empty and malformed signatures', () => {
    for (const candidate of ['', 'not-hex', 'deadbeef']) {
      expect(constantTimeEquals(candidate, sign(secret, body)), candidate).toBe(false);
    }
  });

  it('compares unequal-length inputs without throwing', () => {
    // timingSafeEqual throws on length mismatch, and the throw itself would
    // leak length — hashing both sides first keeps the comparison uniform.
    expect(() => constantTimeEquals('short', sign(secret, body))).not.toThrow();
    expect(constantTimeEquals('short', sign(secret, body))).toBe(false);
  });

  it('is exact — one flipped character fails', () => {
    const good = sign(secret, body);
    const flipped = (good[0] === 'a' ? 'b' : 'a') + good.slice(1);
    expect(constantTimeEquals(flipped, good)).toBe(false);
  });
});
