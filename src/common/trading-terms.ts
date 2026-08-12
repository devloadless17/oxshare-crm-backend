import { ValidationError } from './errors/domain-errors';
import type { TradingSettingsRow } from '../store/app-settings.store';

/**
 * The terms self-service account opening runs on, in one place.
 *
 * ## Why this is a plain module and not a service
 *
 * Two things need these numbers and they sit on opposite sides of the app:
 * `SettingsService` shows and edits them, and the trading module ENFORCES them
 * on every create. Making either import the other builds a cycle, and giving
 * each its own copy of "what does an empty leverage list mean" is how the
 * screen ends up promising something the endpoint refuses.
 *
 * Nothing here touches the database or the container, so both sides can call it
 * and a test can call it with a literal.
 *
 * ## Where the defaults come from
 *
 * A missing row means nobody has opened the Trading tab yet. The fallback is
 * the environment's `MT5_CLIENT_LEVERAGES` when it is set — the variable these
 * settings replaced — so a deployment configured before this table existed
 * keeps offering exactly what it offered yesterday, and the admin screen shows
 * that rather than a default nobody chose.
 */
export interface TradingTerms {
  /** The ladder, in the order the client sees it. Never empty. */
  leverages: number[];
  maxLiveAccounts: number;
  maxDemoAccounts: number;
  /** A decimal string, never a number — §6. */
  maxDemoDeposit: string;
  /**
   * The broker's floor: the most of its revenue that may reach partners.
   *
   * Enforced in `calculate`, not merely displayed. `ib_levels` rates are each a
   * share of the FULL revenue and therefore add up, so without this a
   * two-level ladder at 70 + 30 pays out everything the house earned.
   */
  ibMaxRevenueSharePct: string;
}

/** A conventional retail ladder, matching the column default. */
export const DEFAULT_LEVERAGES = [50, 100, 200, 500];

/** What the columns default to, for the case where there is no row at all. */
export const DEFAULT_TRADING_TERMS: TradingTerms = {
  leverages: DEFAULT_LEVERAGES,
  maxLiveAccounts: 5,
  maxDemoAccounts: 5,
  maxDemoDeposit: '1000000',
  ibMaxRevenueSharePct: '50',
};

/**
 * The stored row, or the defaults when there is none.
 *
 * `envLeverages` is the raw `MT5_CLIENT_LEVERAGES` value and is consulted ONLY
 * when no row exists. Once an operator saves the form, the table is the single
 * answer — a variable that keeps overriding a saved setting is the bug this
 * feature exists to remove.
 */
export function tradingTermsFrom(
  row: TradingSettingsRow | null,
  envLeverages?: string,
): TradingTerms {
  if (!row) {
    return {
      ...DEFAULT_TRADING_TERMS,
      leverages: parseLeveragesOr(envLeverages, DEFAULT_LEVERAGES),
    };
  }

  return {
    // Tolerant on the READ path. A row written before a validation rule existed,
    // or edited straight in psql, must still render the settings screen — the
    // operator cannot fix a value on a page that throws while loading it.
    leverages: parseLeveragesOr(row.leverages, DEFAULT_LEVERAGES),
    maxLiveAccounts: row.maxLiveAccounts,
    maxDemoAccounts: row.maxDemoAccounts,
    maxDemoDeposit: row.maxDemoDeposit,
    ibMaxRevenueSharePct: row.ibMaxRevenueSharePct,
  };
}

/**
 * `'50,100,200,500'` → `[50, 100, 200, 500]`, STRICTLY.
 *
 * Throws on anything that is not a positive integer, naming the value. The
 * tempting alternative — filter the bad entries out — turns a typo into a
 * silently shorter offer: the operator saves `50,1OO,200`, the form comes back
 * reading `50,200`, and the missing one looks like something the system decided.
 *
 * Duplicates collapse and order is preserved, because the order is the order the
 * client sees and a repeated entry is a slip rather than a request for two
 * identical dropdown rows.
 */
export function parseLeverages(raw: string): number[] {
  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');

  if (parts.length === 0) {
    throw new ValidationError(
      'Enter at least one leverage, for example 50,100,200,500. A client has to be offered ' +
        'something.',
    );
  }

  const seen = new Set<number>();
  const leverages: number[] = [];
  for (const part of parts) {
    // `Number.parseInt` alone accepts '100abc'; the shape is checked first so a
    // partially-numeric entry is an error rather than a truncation.
    if (!/^\d+$/.test(part)) {
      throw new ValidationError(
        `"${part}" is not a leverage. Enter whole numbers separated by commas, for example ` +
          '50,100,200,500.',
      );
    }
    const value = Number.parseInt(part, 10);
    if (value < 1 || value > 10_000) {
      throw new ValidationError(
        `Leverage ${value} is out of range. Use a value between 1 and 10000.`,
      );
    }
    if (seen.has(value)) continue;
    seen.add(value);
    leverages.push(value);
  }

  return leverages;
}

/** `parseLeverages`, but a bad value yields the fallback instead of throwing. */
function parseLeveragesOr(raw: string | undefined, fallback: number[]): number[] {
  if (!raw?.trim()) return fallback;
  try {
    return parseLeverages(raw);
  } catch {
    return fallback;
  }
}

/** `[50, 100]` → `'50,100'`, for storing what the operator meant. */
export function formatLeverages(leverages: number[]): string {
  return leverages.join(',');
}
