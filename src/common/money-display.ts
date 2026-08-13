import Decimal from 'decimal.js';

/**
 * Money formatted for a HUMAN to read, on the server side.
 *
 * ## Why this exists
 *
 * Money is `NUMERIC(28,8)` in Postgres and a decimal string across every
 * boundary (§6.1), which is right for storage, transport and arithmetic — and
 * wrong to put in front of a person. The withdrawal, deposit and wallet-credit
 * emails interpolated the stored string directly, so a client who withdrew
 * eleven dollars was emailed "11.00000000 USD" while every screen in the portal
 * showed them "$11.00". Eight decimal places of trailing zeros is not precision,
 * it is noise, and it made a routine confirmation read like a system dump.
 *
 * ## What it does NOT do, which is the whole reason it is a separate function
 *
 * The templates were right to refuse `Number()` and `toLocaleString`. Those
 * COERCE — `Number('12345678901234567.89')` is wrong before formatting starts,
 * and `Intl.NumberFormat` takes a number, so it cannot be part of any answer
 * here. The rounding below is decimal.js at a display scale, half-up, on a
 * value that is never converted to a float.
 *
 * Rounding for DISPLAY is not rounding the money. The ledger, the API and every
 * calculation keep all eight places; this is the last inch before a sentence in
 * an email.
 *
 * ## It mirrors the portal's `lib/money.ts` deliberately
 *
 * Same display scale, same half-up rounding, same thousands grouping, same
 * symbol table — so the figure in the confirmation email is character-for-
 * character the figure on the screen the client checks it against. A client
 * comparing "$11.00" in the portal with "11.00000000 USD" in their inbox has to
 * work out whether they are the same number.
 */

/** Display scale. The stored scale is 8; round for humans, never for maths. */
const DISPLAY_SCALE = 2;

const SYMBOLS: Record<string, string> = { USD: '$' };

/**
 * `'1234.5'` + `USD` → `'$1,234.50'`; `'1234.5'` + `USDT` → `'1,234.50 USDT'`.
 *
 * An unparseable value falls back to the raw string rather than throwing or
 * printing `NaN`: an email that fails to render is worse than one carrying an
 * unformatted figure, and the raw value is at least the truth.
 */
export function displayMoney(value: string, currency: string): string {
  let amount: Decimal;
  try {
    amount = new Decimal(value);
  } catch {
    return `${value} ${currency}`;
  }
  if (!amount.isFinite()) return `${value} ${currency}`;

  const fixed = amount.toFixed(DISPLAY_SCALE, Decimal.ROUND_HALF_UP);
  const negative = fixed.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? fixed.slice(1) : fixed).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const magnitude = fraction ? `${grouped}.${fraction}` : grouped;

  const symbol = SYMBOLS[currency];
  const body = symbol ? `${symbol}${magnitude}` : `${magnitude} ${currency}`;
  return negative ? `-${body}` : body;
}
