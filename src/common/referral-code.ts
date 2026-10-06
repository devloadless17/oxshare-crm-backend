import { randomBytes } from 'node:crypto';

/**
 * What a referral code is made of, and how to read one a human sent us.
 *
 * ## The alphabet
 *
 * No 0/O, no 1/I/L. Codes get read off a screen, dictated over a phone and
 * typed into a registration form by somebody who is not the partner — a code
 * one glyph away from another person's is an attribution that silently pays the
 * wrong partner, and attribution is permanent per client.
 *
 * It lives HERE rather than beside the generator because two places now depend
 * on it: minting a code, and recognising one. A second copy would be a second
 * answer to "which characters are legal", and the two would drift.
 */
export const REFERRAL_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export const REFERRAL_CODE_LENGTH = 8;

/**
 * Transport debris: everything that is not a letter or a digit.
 *
 * ## Why this is NOT derived from `REFERRAL_CODE_ALPHABET`
 *
 * The obvious rule — "a code can only contain alphabet characters, so strip
 * everything else" — is wrong, and quietly so. The alphabet governs what we
 * MINT. It does not govern what is STORED: seeded, imported and hand-created
 * partner rows predate it or ignore it, and `ib_accounts.referral_code` is a
 * plain text column with no such constraint.
 *
 * Measured rather than assumed. Of the codes in this system today,
 * `E2EPARTL1` and `E2EPARTL2` both contain `L` — excluded from the mint
 * alphabet because it is confusable with `1` and `I`. Stripping by the mint
 * alphabet would have turned them into `E2EPART1` and `E2EPART2`, matched
 * nothing, and broken those partners' links completely. A fix for lost
 * attribution that loses attribution.
 *
 * The first version of this file made exactly that mistake and the existing
 * suite caught it: `referral-attribution.spec.ts` seeds `PROT2345`, whose `O`
 * is not in the mint alphabet either.
 *
 * So the rule is the weaker, true one: a referral code is alphanumeric, and
 * anything else arrived from the transport. That removes every real-world
 * corruption without asserting anything about which letters a code may hold.
 */
const TRANSPORT_DEBRIS = /[^A-Z0-9]/g;

export function normaliseReferralCode(raw: string | null | undefined): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  const cleaned = raw.toUpperCase().replace(TRANSPORT_DEBRIS, '');
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * A fresh code from the mint alphabet — for an administrator's sign-up link
 * (0195). `randomBytes`, not `Math.random`: a code is not a secret, but it is
 * an identifier somebody could enumerate. The caller checks uniqueness (the
 * column is UNIQUE regardless).
 */
export function randomReferralCode(length = REFERRAL_CODE_LENGTH): string {
  const bytes = randomBytes(length);
  let out = '';
  for (const byte of bytes) out += REFERRAL_CODE_ALPHABET[byte % REFERRAL_CODE_ALPHABET.length];
  return out;
}
