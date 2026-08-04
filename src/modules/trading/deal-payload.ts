/**
 * Shape validation for the MT5 bridge payload — a pure seam, like `commission.ts`.
 *
 * No Nest, no Drizzle, no HTTP: this is called by the webhook controller and by
 * the sweep job, and it is unit-testable without a container.
 *
 * ## Why this exists
 *
 * `mt5-webhook.controller.ts` verifies an HMAC over the raw body, which proves
 * WHO sent the batch. It proved nothing about what is in it. The parsed body was
 * then cast — `req.body as { deals?: BridgeDeal[] }` — which is a compile-time
 * assertion that erases at runtime, so every field of every deal reached
 * `ingestAndAccrue` unchecked.
 *
 * The global `ValidationPipe` cannot cover this route: HMAC verification needs
 * the raw bytes, so the handler reads `req.body` directly and never passes
 * through the pipe (see `common/validation.config.ts`).
 *
 * ## The failure that matters
 *
 * JSON has one number type and it is a float. If the bridge sends
 *
 *     { "profit": 12345678901234567.89 }
 *
 * as a JSON NUMBER rather than a string, `JSON.parse` has already destroyed the
 * value before any code here runs — it arrives as 12345678901234568. decimal.js
 * accepts a number happily, so the corrupted figure would flow into an accrual
 * and be paid. Nothing downstream can detect it, because by then the original
 * digits are gone.
 *
 * We cannot recover the value. We CAN refuse to accrue on it. So every monetary
 * field must arrive as a string, and a number is rejected rather than coerced —
 * the one case where being strict about a type is a money rule (ARCHITECTURE
 * §6.1) and not a style preference.
 *
 * `ticket` gets the same treatment for a different reason: it is the
 * `UNIQUE(mt5_ticket)` idempotency key. A ticket past 2^53 arriving as a JSON
 * number would be rounded, and two distinct deals could round to the same key —
 * one deal silently swallowed as a duplicate, which is the "lost deal is an
 * unpaid partner" failure arriving through the front door.
 *
 * ## What this deliberately does NOT do
 *
 * It does not reject unknown fields. The rest of the API sets
 * `forbidNonWhitelisted` so a typo'd key is a loud 400, but the bridge is a
 * system we do not own and its contract may grow a field before we know about
 * it. Refusing the batch for an additive change would lose deals to a
 * non-problem.
 *
 * It also imposes no business rules — no "volume must be positive", no "spread
 * below some bound". Those belong to the commission engine, which owns them and
 * can see the plan. This checks only that a value is the KIND of thing that can
 * be reasoned about at all.
 */

/** The bridge's wire shape for one closed deal (BRIDGE-CONTRACT §3.1). */
export interface BridgeDeal {
  ticket: string;
  login: string;
  symbol: string;
  volume: string;
  spread: string;
  profit?: string;
  opened_at?: string;
  closed_at: string;
}

/**
 * A decimal string that fits `NUMERIC(28,8)`: up to 20 integer digits and up to
 * 8 fractional ones, optionally signed.
 *
 * Exponent notation (`1e5`) is refused even though decimal.js would accept it.
 * The bridge contract specifies plain decimal strings, and allowing both would
 * mean two spellings of the same amount reaching the ledger — which makes an
 * amount harder to grep for during an investigation, at no benefit.
 */
const DECIMAL_STRING = /^-?\d{1,20}(\.\d{1,8})?$/;

/** A rejection carries the field, so the log says what to fix on the bridge. */
export class DealShapeError extends Error {
  constructor(
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'DealShapeError';
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new DealShapeError(field, `${field} must be a string, received ${typeof value}`);
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    throw new DealShapeError(field, `${field} must not be empty`);
  }
  return trimmed;
}

/**
 * A monetary field. The `typeof value !== 'string'` branch is the whole point:
 * a JSON number reaching here has already lost precision, so accepting it would
 * mean accruing on a figure nobody can reconstruct.
 */
function requireDecimalString(value: unknown, field: string): string {
  if (typeof value === 'number') {
    throw new DealShapeError(
      field,
      `${field} must be a string, not a JSON number — a number has already lost precision by ` +
        `the time it is parsed (ARCHITECTURE §6.1)`,
    );
  }
  const text = requireString(value, field);
  if (!DECIMAL_STRING.test(text)) {
    throw new DealShapeError(
      field,
      `${field} must be a plain decimal string with at most 8 decimal places, received "${text}"`,
    );
  }
  return text;
}

/**
 * An identifier that becomes an idempotency key. A string passes through
 * verbatim; a number is accepted only while it is exactly representable, since
 * beyond that two different tickets can collapse onto one key.
 */
function requireIdentifier(value: unknown, field: string): string {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new DealShapeError(
        field,
        `${field} must be a string or a safe integer — ${String(value)} cannot be represented ` +
          `exactly, and two distinct deals could collapse onto one idempotency key`,
      );
    }
    return String(value);
  }
  return requireString(value, field);
}

function requireDate(value: unknown, field: string): Date {
  const text = requireString(value, field);
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    throw new DealShapeError(field, `${field} must be a parseable timestamp, received "${text}"`);
  }
  return date;
}

/** The validated deal, in the shape `CommissionService.ingestAndAccrue` wants. */
export interface ParsedDeal {
  mt5Ticket: string;
  mt5Login: string;
  symbol: string;
  volume: string;
  spread: string;
  profit?: string;
  openedAt?: Date;
  closedAt: Date;
}

/**
 * Validate one deal. Throws `DealShapeError` naming the offending field.
 *
 * Per-deal rather than per-batch on purpose: the controller's contract is that
 * one bad deal must not abort the batch, so the caller catches this and counts
 * the deal as failed while the rest proceed.
 */
export function parseDeal(input: unknown): ParsedDeal {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new DealShapeError('deal', 'each entry in `deals` must be an object');
  }
  const deal = input as Record<string, unknown>;

  const parsed: ParsedDeal = {
    mt5Ticket: requireIdentifier(deal.ticket, 'ticket'),
    mt5Login: requireIdentifier(deal.login, 'login'),
    symbol: requireString(deal.symbol, 'symbol'),
    volume: requireDecimalString(deal.volume, 'volume'),
    spread: requireDecimalString(deal.spread, 'spread'),
    closedAt: requireDate(deal.closed_at, 'closed_at'),
  };

  // Optional fields are validated when present and absent when absent. A `null`
  // is treated as absent: the bridge emits null for "no open time recorded",
  // and rejecting the deal over it would lose a payable trade.
  if (deal.profit !== undefined && deal.profit !== null) {
    parsed.profit = requireDecimalString(deal.profit, 'profit');
  }
  if (deal.opened_at !== undefined && deal.opened_at !== null) {
    parsed.openedAt = requireDate(deal.opened_at, 'opened_at');
  }

  return parsed;
}

/**
 * Pull the `deals` array off a parsed body without trusting any of it.
 *
 * Returns the raw entries rather than parsed ones so the caller keeps its
 * per-deal error handling; this only establishes that there is a non-empty
 * array to iterate.
 */
export function readDealsArray(body: unknown): unknown[] {
  if (typeof body !== 'object' || body === null) {
    throw new DealShapeError('body', 'the request body must be a JSON object');
  }
  const deals = (body as Record<string, unknown>).deals;
  if (!Array.isArray(deals)) {
    throw new DealShapeError('deals', 'expected a `deals` array');
  }
  if (deals.length === 0) {
    throw new DealShapeError('deals', 'expected a non-empty `deals` array');
  }
  return deals;
}
