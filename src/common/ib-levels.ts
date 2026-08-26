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
