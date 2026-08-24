import { describe, expect, it } from 'vitest';
import { LEDGER_REFERENCE } from '../../database/ledger-reference';
import { LIVE_REVENUE_FEED, REVENUE_FEEDS, isLiveRevenueFeed } from './revenue-feed';

/**
 * The rule that stops one trade paying a partner twice.
 *
 * `accrueForDeal` and `accrueForClosedPosition` key their accruals on two id
 * spaces over the same event, so `ib_accruals_source_earner_uq` cannot see one
 * from the other: run both and the database holds two accruals for one round
 * turn and is right to. The only thing standing between here and there is that
 * exactly one feed is live, which is what these three cases pin.
 *
 * They are cheap and they are about a CONSTANT, which is the point — the defect
 * they guard against arrives as a one-line edit that looks harmless.
 */
describe('exactly one revenue feed pays', () => {
  it('names the deal feed as the live one, because nothing writes positions', () => {
    expect(LIVE_REVENUE_FEED).toBe(LEDGER_REFERENCE.deal);
  });

  it('makes every other feed dormant, whichever one is live', () => {
    const live = REVENUE_FEEDS.filter(isLiveRevenueFeed);

    /*
     * The assertion is "exactly one", not "position is off". Flipping the
     * constant when the bridge lands must keep this test meaningful rather than
     * turning it into a test of the old wiring.
     */
    expect(live).toEqual([LIVE_REVENUE_FEED]);
  });

  it('speaks the same vocabulary as the accrual source types', () => {
    /*
     * The feeds ARE ledger reference types. If they drift apart, the guards in
     * `CommissionService` compare a feed against a source type that no longer
     * means the same thing, and both paths would go live together with the
     * comparison quietly false on each.
     */
    expect([...REVENUE_FEEDS].sort()).toEqual(
      [LEDGER_REFERENCE.deal, LEDGER_REFERENCE.position].sort(),
    );
  });
});
