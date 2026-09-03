/**
 * How many LEVELS a commission programme's ladder may reach.
 *
 * ## The committed scope is two, and the default says so
 *
 * Feature List Rev 9, IB-17: "Two-level structure (L1 + L2) — both earn; no
 * level beyond L2", and the document's own header: "The IB structure is fixed
 * at two levels, L1 and L2, both earning." A platform nobody has configured
 * therefore carries exactly what was agreed.
 *
 * ## Why it is a SETTING, and why it is on the settings page
 *
 * The number is a COMMERCIAL decision. It used to be `MAX_CHAIN_DEPTH = 2` in
 * the engine, which meant a broker who negotiated a third level needed a code
 * change — and worse, that constant and the console's own notion of depth could
 * disagree, so enabling a third level told an operator earnings travelled three
 * levels while the third partner silently earned nothing on every trade.
 *
 * ARCHITECTURE §8.6 argued for removing the cap outright and 0102 did. That was
 * an engineering document overruling committed scope, which it does not get to
 * do — it wins on implementation, and how deep a broker pays is scope. 0105 is
 * the repair.
 *
 * It briefly lived in `IB_MAX_LEVELS`, an environment variable. That was the
 * wrong home for the reason every other commercial control on the Trading
 * settings form has one: the people who make this decision do not have shell
 * access, and a variable records no actor, no timestamp and no reason. It is
 * `trading_settings.ib_max_levels` and it is audited like the numbers beside it.
 *
 * ## Three bounds, and they are NOT the same thing
 *
 * | bound                          | value  | what it is                        |
 * | ------------------------------ | ------ | --------------------------------- |
 * | `trading_settings.ib_max_levels` | 2    | POLICY — how deep a ladder may go  |
 * | `ib_program_tiers_depth_range` | 1..10  | STRUCTURE — what the column stores |
 * | `MAX_CHAIN_DEPTH`              | 10     | CYCLE GUARD — where the walk stops |
 *
 * The database bound is deliberately WIDER than the policy, so that raising the
 * ceiling is a form somebody fills in rather than a migration somebody writes.
 * The column holds what the engine can physically pay; the setting decides what
 * an operator may configure inside that.
 *
 * The walk is bounded separately and for a different reason: a self-referencing
 * foreign key cannot be stopped from forming a loop, so `resolveChain` needs a
 * stop even when every programme is well formed. It decides nobody's pay — the
 * tier count on each earner's own programme does that, and no programme can
 * hold more tiers than the setting allows.
 */

/** Feature List Rev 9, IB-17. A platform nobody configured gets the agreed scope. */
export const DEFAULT_IB_MAX_LEVELS = 2;

/**
 * The widest ladder the DATABASE can hold, mirroring the two depth CHECKs and
 * the CHECK on the setting itself.
 *
 * A stored value above this cannot exist — `trading_settings_ib_max_levels_ck`
 * refuses it — so `normaliseIbMaxLevels` treating it as unset is a second door
 * rather than the only one. It is kept because that function is also reachable
 * from tests and scripts that construct a row by hand.
 */
export const ABSOLUTE_IB_MAX_LEVELS = 10;

/**
 * A stored ceiling, or the committed default when there is nothing usable.
 *
 * ## An unusable value falls back to the DEFAULT, never to the maximum
 *
 * The direction matters. Falling back to 10 would let a bad value quietly widen
 * what partners can be paid — a scope change nothing reported. Falling back to
 * 2 keeps the platform on the terms that were actually agreed, which is the
 * answer somebody would have chosen.
 *
 * Written as a normaliser over a plain number rather than a database read, so
 * it stays in `common/` — which lint forbids from importing `modules/` — and so
 * every boundary case is one assertion with no container. `tradingTermsFrom`
 * is what calls it.
 */
export function normaliseIbMaxLevels(stored: number | null | undefined): number {
  if (stored === null || stored === undefined) return DEFAULT_IB_MAX_LEVELS;
  if (!Number.isInteger(stored)) return DEFAULT_IB_MAX_LEVELS;
  if (stored < 1 || stored > ABSOLUTE_IB_MAX_LEVELS) return DEFAULT_IB_MAX_LEVELS;
  return stored;
}

/**
 * What one TRADE may cost in total, as a % of the broker's revenue on it —
 * every commission leg in the chain plus the client's rebate (0106).
 *
 * 100 by default, and the reason it is not something prudent like 60 is the
 * same reason `DEFAULT_IB_MAX_LEVELS` is the committed two: a default is what a
 * deployment that configured nothing gets, and this one must not quietly change
 * what a running platform pays. At 100 it refuses only the case with no
 * legitimate reading — paying out more of a trade than the trade earned.
 */
export const DEFAULT_IB_MAX_TOTAL_PAYOUT_PCT = '100';

/**
 * The most one trade may pay out PER STANDARD LOT, across every per-lot leg.
 *
 * Fifty is deliberately far above any real rate card — the industry runs at a
 * few dollars to low double digits a lot — because this is a unit-error guard
 * rather than a commercial limit. It has to refuse a "1000" typed where "10.00"
 * was meant without ever refusing terms somebody actually negotiated.
 */
export const DEFAULT_IB_MAX_PAYOUT_PER_LOT = '50';

/**
 * The stored ceiling, or the default when it is unusable.
 *
 * A DECIMAL STRING in and out. §6.1 forbids `Number()` and `parseFloat` on
 * anything that touches an amount, and this is multiplied by the broker's
 * revenue one call later — a float here reintroduces the error the NUMERIC
 * columns exist to prevent.
 *
 * So the validation is a REGEX and not a parse. `Number.isFinite(Number(x))`
 * would accept `'1e2'`, `' 100 '` and `'0x64'`, and `parseInt('1e1', 10)` is 1
 * — the same trap that made `ibMaxLevels` read 1 for a malformed value.
 *
 * An unusable value falls back to the DEFAULT rather than to the minimum: a bad
 * row must not silently stop paying every partner on the platform.
 */
/**
 * The per-lot ceiling, or the default when the stored value cannot be trusted.
 *
 * Same shape as the percentage normaliser beside it and for the same reason: a
 * bad row must fall back to the DEFAULT rather than to something permissive. On
 * this setting "permissive" would mean a mistyped rate card reaching a wallet,
 * which is the one thing the ceiling exists to prevent.
 *
 * No upper bound, unlike the percentage — there is no natural 100 for an amount
 * of money, and a broker running an unusually rich programme must be able to
 * configure it. The floor is what matters: zero or negative would refuse every
 * per-lot accrual on the platform.
 */
export function normaliseIbMaxPayoutPerLot(stored: string | null | undefined): string {
  if (stored === null || stored === undefined) return DEFAULT_IB_MAX_PAYOUT_PER_LOT;

  const trimmed = stored.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return DEFAULT_IB_MAX_PAYOUT_PER_LOT;

  const asNumber = Number(trimmed);
  if (!Number.isFinite(asNumber) || asNumber <= 0) return DEFAULT_IB_MAX_PAYOUT_PER_LOT;

  return trimmed;
}

export function normaliseIbMaxTotalPayoutPct(stored: string | null | undefined): string {
  if (stored === null || stored === undefined) return DEFAULT_IB_MAX_TOTAL_PAYOUT_PCT;

  const trimmed = stored.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return DEFAULT_IB_MAX_TOTAL_PAYOUT_PCT;

  /*
   * Compared as numbers only to bound it, never to carry it. The value RETURNED
   * is the original string, so no precision is lost on the way through — the
   * comparison is a range test, not an arithmetic step.
   */
  const asNumber = Number(trimmed);
  if (!Number.isFinite(asNumber) || asNumber <= 0 || asNumber > 100) {
    return DEFAULT_IB_MAX_TOTAL_PAYOUT_PCT;
  }

  return trimmed;
}
