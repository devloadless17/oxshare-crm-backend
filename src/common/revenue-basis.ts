/**
 * WHICH of the broker's earnings a partner is paid a share of — FR-IB-16.
 *
 * ## Why this is a setting and not a constant
 *
 * The FSD says commission is "spread-based" (FR-IB-04, FR-IB-16). What ships is
 * `commission + swap`, and that was not an oversight: MT5 reports no per-deal
 * spread revenue, so there is neither a figure to compute from nor a figure to
 * check a result against. `brokerRevenueOf`'s docblock and migration 0095 both
 * close the argument the same way — wiring the product's markup into the base
 * "changes what every partner is paid on every future trade", and **"that needs
 * a person, not a column"**.
 *
 * This is that person's switch. It does not decide the answer; it makes the
 * answer sayable by somebody accountable, recorded with both sides, on the same
 * form as the settlement window and the backlog decision. Which is what the
 * FSD's acceptance criterion actually turns on: it asks that the agreed method
 * be "documented and configured", not that it be hardcoded.
 *
 * | value                     | the base a partner's rate applies to        |
 * | ------------------------- | ------------------------------------------- |
 * | `commission_swap`         | what MT5 says the broker charged (DEFAULT)  |
 * | `spread`                  | lots × the product's markup per lot         |
 * | `commission_swap_spread`  | both, summed — everything the broker earned |
 *
 * ## Why the VOCABULARY lives in `common/` and the ARITHMETIC does not
 *
 * Four layers need to name a basis — the settings DTO, the settings service,
 * `trading-terms.ts` and `app-settings.store.ts` — and two of those are
 * `common/` and `store/`, which lint forbids from importing `modules/`. That
 * rule is right: a store reaching up into a feature module is the layering
 * inversion that turns a dependency graph into a knot.
 *
 * So the three-word vocabulary comes down here, where everything may see it,
 * and the money arithmetic that consumes it stays in
 * `modules/trading/broker-revenue.ts`, where it sits beside the sign convention
 * it has to honour. The split is along the same line ARCHITECTURE §8.6 draws
 * everywhere else: naming a thing is not the same as computing with it.
 */
export type RevenueBasis = 'commission_swap' | 'spread' | 'commission_swap_spread';

/** Every legal value, for the DTO, the CHECK constraint and the admin form. */
export const REVENUE_BASES = ['commission_swap', 'spread', 'commission_swap_spread'] as const;

/**
 * What ships, and what an unreadable stored value falls back to.
 *
 * Falling back to the CURRENT behaviour rather than refusing is deliberate, and
 * is the opposite of `ibAccrualStart`'s rule — there, an unparseable value holds
 * the engine because paying the wrong history cannot be undone. Here every
 * candidate value pays SOMETHING plausible, so refusing would stop commission
 * platform-wide over a typo, while falling back merely keeps paying what was
 * being paid before the typo was saved.
 */
export const DEFAULT_REVENUE_BASIS: RevenueBasis = 'commission_swap';

/** Narrow a stored string. Anything else is the default — see above. */
export function revenueBasisOf(raw: string | null | undefined): RevenueBasis {
  return (REVENUE_BASES as readonly string[]).includes(raw ?? '')
    ? (raw as RevenueBasis)
    : DEFAULT_REVENUE_BASIS;
}

/** Does this basis count what MT5 says was charged? */
export function basisCountsCharges(basis: RevenueBasis): boolean {
  return basis === 'commission_swap' || basis === 'commission_swap_spread';
}

/** Does this basis count the desk's spread markup? */
export function basisCountsSpread(basis: RevenueBasis): boolean {
  return basis === 'spread' || basis === 'commission_swap_spread';
}
