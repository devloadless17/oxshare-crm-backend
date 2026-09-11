import Decimal from 'decimal.js';

// ARCHITECTURE §6.1: decimals, never floats. Monetary columns are
// NUMERIC(28,8); node-postgres returns them as strings and they must STAY
// strings across every boundary. All arithmetic goes through decimal.js.
//
// Never write `a + b`, `Number(x)` or `parseFloat(x)` on a monetary value.
// JavaScript will not warn you — it silently produces a float that looks
// correct until the eighth decimal place.

// 28 significant digits, matching NUMERIC(28,8).
Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

export const MONEY_SCALE = 8;

export type MoneyInput = string | Decimal;

export function toDecimal(value: MoneyInput): Decimal {
  const d = value instanceof Decimal ? value : new Decimal(value);
  if (!d.isFinite()) throw new Error(`Invalid monetary value: ${String(value)}`);
  return d;
}

/** Serialize for storage and for every API boundary — always a string. */
export function money(value: MoneyInput): string {
  return toDecimal(value).toFixed(MONEY_SCALE);
}

/**
 * `lessThan(0)`, not `isNegative()`: decimal.js reads the sign, so `-0` reports
 * as negative while being no money at all. A zero amount is not a debit.
 */
export function isNegative(value: MoneyInput): boolean {
  return toDecimal(value).lessThan(0);
}

export function sum(values: MoneyInput[]): string {
  return money(values.reduce((acc: Decimal, v) => acc.plus(toDecimal(v)), new Decimal(0)));
}

/** Available = balance − on_hold. What a client may actually withdraw. */
export function available(balance: MoneyInput, onHold: MoneyInput): string {
  return money(toDecimal(balance).minus(toDecimal(onHold)));
}
