/**
 * WHICH feed pays a revenue share. Exactly one, ever.
 *
 * ## The problem this is the answer to
 *
 * Two code paths accrue commission from a trade, and they key their accruals on
 * two different id spaces over the SAME underlying event:
 *
 *   - `accrueForDeal` keys on a row in `mt5_deals` — what the live MT5 feed
 *     delivers, and what pays today.
 *   - `accrueForClosedPosition` keys on a row in `positions` — the right key
 *     for a trade the CRM owns end to end, and the shape the bridge will fill.
 *
 * `ib_accruals_source_earner_uq` makes each of them idempotent against ITSELF.
 * It cannot see across them: a position accrual and a deal accrual for one
 * round turn are two different `(source_type, source_id)` pairs, so the
 * database would accept both and one trade would pay a partner twice.
 *
 * Nothing prevented that except the fact that `positions` has no writer — and
 * this repo's own guidance tells a future implementer to start filling it. A
 * safety that rests on a table happening to be empty is not a safety; it is a
 * countdown. So the rule is written down HERE, where both paths read it, rather
 * than in a comment each of them could be changed without reading.
 *
 * ## Flipping it is the whole migration
 *
 * When the bridge starts writing `positions`, this constant becomes
 * `'position'` and the deal path refuses in the same breath — there is no
 * window in which both are live, because there is one value and both sides read
 * it. That is the property a comment cannot give you.
 *
 * A code constant and not an environment variable, deliberately. Which feed
 * pays is a fact about what the system is wired to, decided when the wiring
 * changes and reviewed with it — not a dial an operator can turn at 3am, where
 * the failure mode is paying every partner twice for a day.
 */
export const REVENUE_FEEDS = ['deal', 'position'] as const;

export type RevenueFeed = (typeof REVENUE_FEEDS)[number];

/**
 * The feed that pays today.
 *
 * `deal`, because MT5 delivers deals and nothing writes `positions`. See
 * `LEDGER_REFERENCE.deal` for why a deal is also the better key even once
 * positions exist: the broker charges on the opening deal as well as the
 * closing one, the sweep's 24-hour window means a close often arrives without
 * its open, and a partial close is several closes against one position.
 */
export const LIVE_REVENUE_FEED: RevenueFeed = 'deal';

/** Does this feed pay a revenue share, or is it the dormant one? */
export function isLiveRevenueFeed(feed: RevenueFeed): boolean {
  return feed === LIVE_REVENUE_FEED;
}
