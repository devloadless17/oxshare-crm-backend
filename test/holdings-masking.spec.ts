import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { applyMask, maskedPathsFor } from '../src/common/security/field-mask';

/**
 * RBAC-03 on the WALLET and TRADING-ACCOUNT desks.
 *
 * Both screens join the client under `user` — the same shape the withdrawal
 * desk uses — and both served `user.email` to an administrator whose role was
 * configured to hide it. `applyMask` is opt-in, nothing on either path called
 * it, and the catalog carried no `wallet.` or `tradingAccount.` prefix, so even
 * adding the call would have masked nothing. Two halves, both missing, and no
 * test in the repo asserted about either.
 *
 * Found by `test/mask-coverage.spec.ts` on the day it was written, which is
 * exactly the argument for that census: the four surfaces that DID mask were
 * the four somebody had already thought about.
 *
 * Asserted at the seam that was actually broken — the expansion — rather than
 * over HTTP. The end-to-end version, an admin holding `wallets.view` with a
 * mask reading a real page, lives in `field-mask-enforcement.spec.ts` and is
 * driven from the route metadata so it cannot go missing.
 */

// Expand exactly as client-fields.service.ts does: key -> [key, ...aliases]
const catalog = JSON.parse(readFileSync('src/config/client-fields.json', 'utf8')) as Record<
  string,
  { fields?: { key?: string; aliases?: string[] }[] }
>;
function expand(keys: string[]): string[] {
  const map = new Map<string, string[]>();
  for (const [g, v] of Object.entries(catalog)) {
    if (g === '$comment' || typeof v !== 'object' || v === null) continue;
    for (const f of v.fields ?? []) if (f.key) map.set(f.key, [f.key, ...(f.aliases ?? [])]);
  }
  return keys.flatMap((k) => map.get(k) ?? [k]);
}

describe('masking client.email reaches the wallet and trading-account desks', () => {
  const mask = expand(['client.email']);

  it('expands to the wallet and tradingAccount aliases', () => {
    expect(mask).toContain('wallet.user.email');
    expect(mask).toContain('tradingAccount.user.email');
  });

  it('removes the address from a wallet row', () => {
    expect(maskedPathsFor('wallet', mask)).toContain('user.email');
    const row = { id: 'w1', user: { id: 'u1', email: 'alpha@x.test', firstName: 'Alpha' } };
    const masked = applyMask('wallet', row, mask);
    expect('email' in masked.user).toBe(false);
    expect(masked.user.firstName, 'it removed more than it was asked to').toBe('Alpha');
  });

  it('removes the address from a trading-account row', () => {
    const row = { id: 'a1', user: { id: 'u1', email: 'alpha@x.test' } };
    const masked = applyMask('tradingAccount', row, mask);
    expect('email' in masked.user).toBe(false);
  });
});
