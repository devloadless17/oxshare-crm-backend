/**
 * Is this destination a Whish-payable phone number? — a pure seam.
 *
 * Ported from Rival's own validation (`transactions-system`,
 * `packages/shared/src/schemas/payout-method.ts`), deliberately BYTE-COMPATIBLE
 * with it: the CRM refuses at REQUEST time exactly what Rival would refuse at
 * SUBMIT time, so a typo bounces on the client who made it, in the moment they
 * can fix it — not days later on the admin whose approval suddenly fails for a
 * reason the client never sees.
 *
 * Two layers, matching Rival's:
 *
 *  1. SHAPE — tolerant of formatting (+, spaces, dashes, parens: every way a
 *     person writes their own number) but it must actually be phone-shaped:
 *     6–15 digits, no letters. "N/A" and a name fail here, early.
 *  2. LEBANESE 961 — a number that EXPLICITLY claims the Lebanese country code
 *     must be a well-formed Lebanese mobile (8-digit national part, or exactly
 *     7 starting with 3). This caught a real production failure at Rival
 *     (961 + 7 digits, non-3 prefix) that otherwise dies late at Whish as an
 *     opaque `auth.wrong_phone_format`. Other country codes pass the shape
 *     check alone — W2W is not Lebanese-only, and a valid international
 *     recipient must never be blocked.
 */

export function isPhoneShaped(raw: string): boolean {
  const value = raw.trim();
  if (value.length === 0 || value.length > 30) return false;
  if (!/^[+(\d][\d\s().+-]*$/.test(value)) return false;
  const digits = (value.match(/\d/g) ?? []).length;
  return digits >= 6 && digits <= 15;
}

/** The national significant number, once an explicit 961 prefix is stripped. */
function lebaneseMobileNsn(raw: string): string {
  let digits = raw.replace(/\D/g, '');
  if (digits.startsWith('00961')) digits = digits.slice(5);
  else if (digits.startsWith('961')) digits = digits.slice(3);
  if (digits.startsWith('0')) digits = digits.slice(1);
  return digits;
}

function claimsLebanon(raw: string): boolean {
  const digits = raw.replace(/\D/g, '');
  return digits.startsWith('961') || digits.startsWith('00961');
}

/**
 * The one question `requestWithdrawal` asks. Returns a refusal message for
 * the client, or null when the destination is acceptable.
 */
export function wishDestinationIssue(raw: string): string | null {
  if (!isPhoneShaped(raw)) {
    return (
      'The destination for a Whish withdrawal must be a phone number — 6 to 15 digits, ' +
      'optionally with +, spaces, dashes or parentheses.'
    );
  }
  if (claimsLebanon(raw)) {
    const nsn = lebaneseMobileNsn(raw);
    const valid = nsn.startsWith('3') ? nsn.length === 7 : nsn.length === 8;
    if (!valid) {
      return (
        'That does not look like a valid Lebanese mobile number. After +961 there should be ' +
        '8 digits (or 7 when the number starts with 3).'
      );
    }
  }
  return null;
}
