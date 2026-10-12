import Decimal from 'decimal.js';

/**
 * 3pay's JSON, read WITHOUT losing a digit (0174).
 *
 * 3pay sends every amount as a JSON NUMBER (`"amount": 100.10`). `JSON.parse`
 * turns that into a float before any code sees it, and a float is already
 * wrong for money: `12345678901234567.89` arrives as `12345678901234568`. So
 * every number is taken from its own SOURCE TEXT instead (the reviver's
 * `context.source`, Node ≥ 21) and stays a string: amounts become exact
 * decimals through decimal.js, counts become integers where they are counts.
 *
 * A runtime that cannot give the source text is refused outright rather than
 * parsed lossily — a silent float on a money path is the failure this file
 * exists to prevent.
 */

type Reviver = (
  this: unknown,
  key: string,
  value: unknown,
  context?: { source?: string },
) => unknown;

/** Does this runtime hand a reviver each number's own text? Checked once. */
const LOSSLESS = (() => {
  let source: string | undefined;
  JSON.parse('0.10', ((_key, value, context) => {
    source = context?.source;
    return value;
  }) as Reviver);
  return source === '0.10';
})();

const keepSource: Reviver = (_key, value, context) =>
  typeof value === 'number' ? (context?.source ?? value) : value;

/** Parse 3pay's JSON with every number kept as the exact text 3pay sent. */
export function parseLossless(text: string): unknown {
  if (!LOSSLESS) {
    throw new Error(
      'This runtime cannot read JSON numbers exactly (Node 21 or later is required); ' +
        '3pay amounts are refused rather than read as floats.',
    );
  }
  return JSON.parse(text, keepSource);
}

/** A plain decimal, as 3pay writes amounts (no sign, no exponent needed). */
const DECIMAL_TEXT = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

/**
 * An amount 3pay reported, as an exact decimal string — or undefined when it
 * is absent or not a number. Never a float, never rounded: `99.999999` stays
 * `99.999999`; the core decides what to credit.
 */
export function amountOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!DECIMAL_TEXT.test(text)) return undefined;
  return new Decimal(text).toFixed();
}

/** A count (a page number, a total) — an integer, never money. */
export function countOf(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^\d{1,9}$/.test(value.trim())) return undefined;
  return Number.parseInt(value.trim(), 10);
}

/** A string field, trimmed, or undefined. */
export function textOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text.length > 0 ? text : undefined;
}

/** A JSON object, or undefined. */
export function objectOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * A request amount as the exact JSON NUMBER literal 3pay expects. The value
 * goes into the body as text, so `102.00` is sent as `102.00` — never through
 * a float on the way out either.
 */
export function numberLiteral(amount: string): string {
  const fixed = new Decimal(amount).toFixed();
  if (!/^\d+(\.\d+)?$/.test(fixed)) {
    throw new Error(`A 3pay amount must be a positive decimal; got ${amount}.`);
  }
  return fixed;
}

/**
 * A JSON body whose `amount` is an exact number literal: every other field is
 * serialised normally, and the amount is spliced in as text.
 */
export function bodyWithAmount(amount: string, rest: Record<string, string | undefined>): string {
  const fields = Object.entries(rest)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`);
  return `{"amount":${numberLiteral(amount)}${fields.map((field) => `,${field}`).join('')}}`;
}

/** The first of several fields that holds text — 3pay names one thing differently per endpoint. */
export function firstText(
  record: Record<string, unknown> | undefined,
  ...names: readonly string[]
): string | undefined {
  for (const name of names) {
    const text = textOf(record?.[name]);
    if (text !== undefined) return text;
  }
  return undefined;
}

/** A flag 3pay writes as a boolean or as the words "true"/"false", or undefined. */
export function flagOf(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

/** A timestamp 3pay wrote as ISO text, or undefined. */
export function dateOf(value: unknown): Date | undefined {
  const text = textOf(value);
  if (!text) return undefined;
  const at = Date.parse(text);
  return Number.isNaN(at) ? undefined : new Date(at);
}

/**
 * A body as the EXCHANGE LOG may keep it (0175).
 *
 * The log is read unmasked by whoever may view providers, so two things never
 * reach it. A field whose name says it is a credential (3pay's account reply
 * carries its `webhookSecret` in clear — found in production, 12 Oct 2026) is
 * blanked wherever it appears. And the account reply itself, which also names
 * the account's owner, their email and phone, is cut down to the figures this
 * platform reads.
 */
const CREDENTIAL_FIELD =
  /"([A-Za-z0-9_]*(?:secret|password|passwd|privatekey|private_key|mnemonic|seed|otp|token|apikey|api_key)[A-Za-z0-9_]*)"\s*:\s*"(?:[^"\\]|\\.)*"/gi;

const ACCOUNT_FIELDS = [
  'totalAmt',
  'pendingAmt',
  'autoWithdraw',
  'maxAutoWithdrawAmount',
  'depositFeePayer',
  'withdrawalFeePayer',
  'approved',
] as const;

export function loggableBody(path: string, body: string | null): string | null {
  if (body === null) return null;
  if (path.startsWith('/getMerchantDetails')) {
    try {
      const parsed = objectOf(parseLossless(body));
      const data = objectOf(parsed?.['data']);
      if (parsed && data) {
        const kept = ACCOUNT_FIELDS.filter((name) => data[name] !== undefined).map(
          (name) => `${JSON.stringify(name)}:${literalOf(data[name])}`,
        );
        return `{"success":${literalOf(parsed['success'])},"data":{${kept.join(',')}},"note":"cut down for the log"}`;
      }
    } catch {
      // Not JSON: fall through to the field blanking below.
    }
  }
  return body.replace(CREDENTIAL_FIELD, '"$1":"[removed]"');
}

/** A parsed value back as JSON text: a number kept as text is written as the number it was. */
function literalOf(value: unknown): string {
  if (typeof value === 'string' && DECIMAL_TEXT.test(value)) return value;
  return JSON.stringify(value ?? null);
}
