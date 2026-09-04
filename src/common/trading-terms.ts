import type { TradingSettingsRow } from '../store/app-settings.store';
import {
  DEFAULT_IB_MAX_LEVELS,
  DEFAULT_IB_MAX_TOTAL_PAYOUT_PCT,
  normaliseIbMaxLevels,
  normaliseIbMaxTotalPayoutPct,
  normaliseIbMaxPayoutPerLot,
  DEFAULT_IB_MAX_PAYOUT_PER_LOT,
  DEFAULT_IB_COMMISSION_INTERVAL_SECONDS,
  normaliseIbCommissionInterval,
} from './ib-levels';

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
  /*
   * ── NO IB TERMS HERE ANY MORE (0103, 0104) ──────────────────────────────
   *
   * Four fields were declared on this interface and each decided what partners
   * are paid:
   *
   *   ibMaxRevenueSharePct   the broker's floor, which scaled every leg pro
   *                          rata to fit under it. GONE — `checkPlausible`
   *                          refuses an over-payment instead of scaling it.
   *   ibCommissionHoldHours  the settlement window → `IB_COMMISSION_HOLD_HOURS`
   *   ibAccrualStart         the backlog decision → `IB_ACCRUAL_START`
   *   ibRevenueBasis         what a rate applies to → `DEFAULT_REVENUE_BASIS`
   *
   * Each arrived here on the reasoning that a commercial decision belongs where
   * an operator can see it — right about the decision, wrong about the SCREEN.
   * Commission is configured on the Commission Programmes page, and four
   * controls on the Trading settings form that also change partner pay are a
   * second place for two answers to disagree.
   *
   * What remains on this interface is what a CLIENT is offered — plus one IB
   * number that is not a payment rule, below.
   */

  /**
   * How many levels a commission programme's ladder may reach.
   *
   * The committed two (Feature List Rev 9, IB-17) by default. It BOUNDS the
   * Commission Programmes page rather than competing with it, which is the
   * distinction that lets it live here when the four above could not — see
   * `common/ib-levels.ts` for the three different bounds this is one of.
   */
  ibMaxLevels: number;

  /**
   * How often commission is paid, in SECONDS — the maturation delay and the
   * payout period at once (0113).
   *
   * One number for both because either alone leaves the other as the real
   * delay: a one-minute job against a 24-hour hold still pays nothing for a
   * day. Set it to 60 and a partner is credited about a minute after the trade
   * closes.
   *
   * ⚠️ A short interval REMOVES the review grace the 24h default existed for.
   * See the column's own note in `database/schema.ts`.
   */
  ibCommissionIntervalSeconds: number;

  /**
   * The most one TRADE may pay out in total, as a % of its revenue.
   *
   * A decimal STRING, like every other rate here — it is multiplied by the
   * broker's revenue, and §6.1 keeps anything that touches an amount out of
   * a float. It belongs beside `ibMaxLevels` for the same reason: it BOUNDS
   * what the Commission Programmes page may cost rather than restating what
   * that page decides.
   */
  ibMaxTotalPayoutPct: string;
  /**
   * The most one trade may pay out per standard lot, across every per-lot leg.
   *
   * The percentage ceiling above cannot bound per-lot terms — those are not a
   * share of anything — so this is the same unit-error backstop expressed in the
   * units they are quoted in. A decimal STRING, like every figure here that is
   * multiplied by an amount.
   */
  ibMaxPayoutPerLot: string;
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
  /* HISTORICAL since 0113 — nothing reads it. Kept so the shape of a stored
     row and the shape of the defaults stay the same object. */
  ibMaxLevels: DEFAULT_IB_MAX_LEVELS,
  /* Hourly: exactly what IB_COMMISSION_HOLD_HOURS=1 and the hourly cron did
     together, so a database with no row behaves as the platform always has. */
  ibCommissionIntervalSeconds: DEFAULT_IB_COMMISSION_INTERVAL_SECONDS,
  /* 100: refuses only a chain costing more than the trade earned. */
  ibMaxTotalPayoutPct: DEFAULT_IB_MAX_TOTAL_PAYOUT_PCT,
  /* Far above any real rate card: a unit-error guard, not a commercial limit. */
  ibMaxPayoutPerLot: DEFAULT_IB_MAX_PAYOUT_PER_LOT,
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
    /*
     * Narrowed on the way OUT of the database, not on the way in. The CHECK
     * stops a bad value being STORED; this stops one that predates the CHECK —
     * or arrives from a restored dump — from reaching the programmes service as
     * a ceiling it should not honour. An unusable value reads as the committed
     * default rather than as the maximum, so a bad row cannot widen what
     * partners are paid.
     */
    ibMaxLevels: normaliseIbMaxLevels(row.ibMaxLevels),
    /*
     * Narrowed on the way OUT, like the rest. A value below the floor here
     * would schedule a job that cannot finish before its next tick, and one
     * from a restored dump predates the CHECK that would have refused it.
     */
    ibCommissionIntervalSeconds: normaliseIbCommissionInterval(row.ibCommissionIntervalSeconds),
    /* Narrowed on the way OUT for the same reason, and to the DEFAULT for a
     * stronger one: a bad row that read as the minimum would refuse every
     * chain on the platform and stop paying everybody. */
    ibMaxTotalPayoutPct: normaliseIbMaxTotalPayoutPct(row.ibMaxTotalPayoutPct),
    ibMaxPayoutPerLot: normaliseIbMaxPayoutPerLot(row.ibMaxPayoutPerLot),
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
