import type { TradingSettingsRow } from '../store/app-settings.store';
import { DEFAULT_REVENUE_BASIS, revenueBasisOf, type RevenueBasis } from './revenue-basis';

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

  /**
   * Hours a commission is held before it becomes spendable.
   *
   * The one rule between earned and spendable, and it lives here rather than
   * in the environment so an operator can both SEE it and change it. A
   * malformed stored value cannot exist — the column is an integer with a
   * CHECK — which is the point: the failure this number must never have is
   * silently becoming zero.
   */
  ibCommissionHoldHours: number;

  /**
   * When commission starts being paid from — the backlog decision.
   *
   * `null` means nobody has decided, and the engine HOLDS rather than guessing.
   * `'all'` pays the whole history deliberately. An ISO instant pays from there.
   *
   * A string rather than a Date because it carries three meanings, only one of
   * which is a moment — and because the parse belongs in `accrualWindow`, which
   * is pure and already treats an unreadable value as "hold" rather than as
   * "nothing is in scope".
   */
  ibAccrualStart: string | null;

  /**
   * WHICH of the broker's earnings a partner's rate applies to — FR-IB-16.
   *
   * The one number deciding what a partner is paid on used to be a constant in
   * `broker-revenue.ts`, reachable only by deploy and invisible to everyone
   * running the platform. It is a setting for the same reason
   * `ibCommissionHoldHours` is: the people who make a commercial decision should
   * be able to see it and make it, and the change should record who made it.
   *
   * Already narrowed by `revenueBasisOf`, so a value that reaches here is one of
   * the three the engine implements — never whatever the column happened to
   * hold.
   */
  ibRevenueBasis: RevenueBasis;
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
  ibCommissionHoldHours: 24,
  /* Undecided, deliberately. A default here would be a decision nobody made. */
  ibAccrualStart: null,
  /*
   * The status quo, and NOT for the reason `ibAccrualStart` is null.
   *
   * That one is undecided because every candidate answer is expensive and
   * irreversible. This one has a right default: whatever the platform was
   * already paying. A new setting that re-prices the book the moment it is
   * deployed is a repricing nobody authorised.
   */
  ibRevenueBasis: DEFAULT_REVENUE_BASIS,
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
    ibCommissionHoldHours: row.ibCommissionHoldHours,
    ibAccrualStart: row.ibAccrualStart,
    /*
     * Narrowed on the way OUT of the database, not on the way in. The CHECK
     * stops a bad value being stored; this stops one that predates the CHECK —
     * or arrives from a restored dump — from reaching the engine as a basis it
     * does not implement.
     */
    ibRevenueBasis: revenueBasisOf(row.ibRevenueBasis),
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
