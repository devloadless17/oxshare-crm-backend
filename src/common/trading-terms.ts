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
  /*
   * `leverages` was here. The ladder is its own TABLE now (migration 0067) with
   * its own store and its own screen, because a rung has a lifecycle these
   * settings do not — it can be withdrawn without touching the accounts opened
   * on it, which a CSV in a singleton row could not express.
   */
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

/**
 * A conventional retail ladder.
 *
 * Kept as the seed for migration 0067 and the last-resort answer when the
 * `leverages` table is empty — a platform mid-setup must still be able to open
 * an account. It is no longer part of `TradingTerms`.
 */
export const DEFAULT_LEVERAGES = [50, 100, 200, 500];

/** What the columns default to, for the case where there is no row at all. */
export const DEFAULT_TRADING_TERMS: TradingTerms = {
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
export function tradingTermsFrom(row: TradingSettingsRow | null): TradingTerms {
  if (!row) return DEFAULT_TRADING_TERMS;

  return {
    maxLiveAccounts: row.maxLiveAccounts,
    maxDemoAccounts: row.maxDemoAccounts,
    maxDemoDeposit: row.maxDemoDeposit,
    ibMaxRevenueSharePct: row.ibMaxRevenueSharePct,
  };
}

/*
 * `parseLeverages`, `parseLeveragesOr` and `formatLeverages` were here.
 *
 * All three existed to turn `trading_settings.leverages` — a CSV — into numbers
 * and back. That column is gone (migration 0067) and the ladder is a table, so
 * there is no string to parse: a rung is a row with an integer primary key, and
 * "is this a positive whole number" is the whole of the validation, in
 * `LeveragesService.assertRatio`.
 *
 * The strictness they enforced is not lost. `parseLeverages` threw on `1OO`
 * rather than dropping it, because a filter turns a typo into a silently
 * shorter offer the operator never chose; the table reaches the same end by not
 * having a format a typo can hide inside.
 */
