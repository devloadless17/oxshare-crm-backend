import { describe, expect, it } from 'vitest';
import { brokerRevenueFor, brokerRevenueOf, spreadRevenueOf } from './broker-revenue';
import {
  DEFAULT_REVENUE_BASIS,
  REVENUE_BASES,
  basisCountsCharges,
  basisCountsSpread,
  revenueBasisOf,
} from '../../common/revenue-basis';

/**
 * The base every partner is paid a share of.
 *
 * These are the cases where `|commission| + |swap|` — the formula this replaced,
 * and the one a reader reaches for first — pays the wrong amount. Each one is a
 * deal a real broker books on an ordinary day, not a contrived edge.
 */
describe('brokerRevenueOf', () => {
  it('takes a commission charged to the client, which is the common deal', () => {
    // MT5 signs from the CLIENT's side: -3.00 means the client was charged 3.
    expect(brokerRevenueOf({ commission: '-3.00000000', swap: '0.00000000' })).toBe('3.00000000');
  });

  it('adds a swap the client was charged', () => {
    expect(brokerRevenueOf({ commission: '-3.00000000', swap: '-1.50000000' })).toBe('4.50000000');
  });

  it('counts NOTHING for a swap credited to the client', () => {
    /*
     * The one that matters. A long position on the paying side of an interest
     * rate differential, held overnight, credits the client — the broker paid
     * that out. `|commission| + |swap|` would report 4.50 of revenue on a deal
     * where the house netted 1.50, and pay a partner a share of its own money.
     */
    expect(brokerRevenueOf({ commission: '-3.00000000', swap: '1.50000000' })).toBe('3.00000000');
  });

  it('does not let a credited swap cancel a commission that was charged', () => {
    // Flooring the TOTAL instead of each leg gives 0 here, and the partner earns
    // nothing on a trade the broker was genuinely paid 3.00 for.
    expect(brokerRevenueOf({ commission: '-3.00000000', swap: '10.00000000' })).toBe('3.00000000');
  });

  it('counts nothing when the broker paid out on both legs', () => {
    expect(brokerRevenueOf({ commission: '2.00000000', swap: '1.00000000' })).toBe('0.00000000');
  });

  it('is zero, never negative, so the accrual check constraint can never be hit', () => {
    // ib_accruals has `CHECK (amount > 0)`. A negative base would either throw
    // at the database or, worse, produce a negative share.
    expect(brokerRevenueOf({ commission: '5.00000000', swap: '5.00000000' })).toBe('0.00000000');
  });

  it('keeps full precision rather than going through a float', () => {
    /*
     * §6.1: the value is a string end to end. `0.1 + 0.2` in binary floating
     * point is 0.30000000000000004, and this figure is the base a percentage is
     * taken from before it is stored to eight decimals.
     */
    expect(brokerRevenueOf({ commission: '-0.10000000', swap: '-0.20000000' })).toBe('0.30000000');
  });

  it('survives a value larger than Number can hold exactly', () => {
    // Not a realistic single deal, but it is the reason none of this path uses
    // Number(): 12345678901234567.89 does not survive the round trip.
    expect(brokerRevenueOf({ commission: '-12345678901234567.89000000', swap: '0' })).toBe(
      '12345678901234567.89000000',
    );
  });

  it('always answers at §6.1 scale, whatever scale it was given', () => {
    expect(brokerRevenueOf({ commission: '-3', swap: '-1' })).toBe('4.00000000');
  });
});

/**
 * The revenue BASIS — FR-IB-16, and the two requirements it closes.
 *
 * The FSD calls commission spread-based; the engine computes on charges, because
 * MT5 reports no per-deal spread revenue to compute from or to check a result
 * against. So the gap between the specification and the system was never missing
 * arithmetic — it was that the arithmetic had no owner. These cases pin the
 * switch that gives it one, and the default that makes turning it on an act
 * rather than an accident.
 */
describe('revenueBasisOf', () => {
  it('accepts each basis the engine actually implements', () => {
    for (const basis of REVENUE_BASES) {
      expect(revenueBasisOf(basis)).toBe(basis);
    }
  });

  it('falls back to what the platform already paid, never to a new price', () => {
    /*
     * The opposite rule to `ibAccrualStart`, deliberately. There, an unreadable
     * value HOLDS the engine, because paying the wrong history cannot be undone.
     * Here every candidate pays something plausible, so refusing would stop
     * commission platform-wide over a typo — while falling back merely keeps
     * paying what was being paid before the typo was saved.
     */
    expect(revenueBasisOf('SPREAD')).toBe(DEFAULT_REVENUE_BASIS);
    expect(revenueBasisOf('spread_only')).toBe(DEFAULT_REVENUE_BASIS);
    expect(revenueBasisOf('')).toBe(DEFAULT_REVENUE_BASIS);
    expect(revenueBasisOf(null)).toBe(DEFAULT_REVENUE_BASIS);
    expect(revenueBasisOf(undefined)).toBe(DEFAULT_REVENUE_BASIS);
  });

  it('defaults to the behaviour that shipped, so no deployment is re-priced by a migration', () => {
    expect(DEFAULT_REVENUE_BASIS).toBe('commission_swap');
  });

  it('reads each basis as the pair of halves it names', () => {
    expect(basisCountsCharges('commission_swap')).toBe(true);
    expect(basisCountsSpread('commission_swap')).toBe(false);

    expect(basisCountsCharges('spread')).toBe(false);
    expect(basisCountsSpread('spread')).toBe(true);

    expect(basisCountsCharges('commission_swap_spread')).toBe(true);
    expect(basisCountsSpread('commission_swap_spread')).toBe(true);
  });
});

describe('spreadRevenueOf', () => {
  it('prices lots at the desk figure', () => {
    expect(spreadRevenueOf('2.00000000', '7.50000000')).toBe('15.00000000');
  });

  it('keeps full precision on a fractional lot', () => {
    // 0.07 lots at 3.30 is 0.231 — a float answers 0.23100000000000004.
    expect(spreadRevenueOf('0.07000000', '3.30000000')).toBe('0.23100000');
  });

  it('earns nothing on a raw-spread product, which carries no markup', () => {
    expect(spreadRevenueOf('5.00000000', '0.00000000')).toBe('0.00000000');
  });

  it('never turns a trade into a partner debt', () => {
    /*
     * The column's CHECK refuses a negative markup, so this cannot arise today.
     * The floor is here for the writer that skips the constraint — a fixture, a
     * restored dump, a future admin script — because `ib_accruals` has
     * `CHECK (amount > 0)`, and a negative base fails at the database rather
     * than anywhere a person would think to look.
     */
    expect(spreadRevenueOf('2.00000000', '-7.50000000')).toBe('0.00000000');
    expect(spreadRevenueOf('-2.00000000', '7.50000000')).toBe('0.00000000');
  });

  it('answers at §6.1 scale whatever scale it was given', () => {
    expect(spreadRevenueOf('1', '4')).toBe('4.00000000');
  });
});

describe('brokerRevenueFor', () => {
  /** A round turn where MT5 put the whole charge on the opening leg. */
  const legs = [
    { commission: '-3.00000000', swap: '-1.00000000' },
    { commission: '0.00000000', swap: '0.00000000' },
  ];

  it('pays on charges alone under the default, ignoring the markup entirely', () => {
    const result = brokerRevenueFor({
      basis: 'commission_swap',
      legs,
      lots: '2.00000000',
      spreadMarkupPerLot: '7.50000000',
    });

    /*
     * 4.00 of charges. The 15.00 of markup is present and deliberately unread —
     * this is what every existing deployment must keep paying after migration
     * 0101, and the assertion exists to fail loudly if that ever changes.
     */
    expect(result).toEqual({ ok: true, revenue: '4.00000000' });
  });

  it('does not need a product at all under the default', () => {
    /*
     * The compatibility guarantee, stated as a test. An account linked to no
     * product accrues exactly as it did before the basis existed — otherwise
     * this change would have introduced a refusal on deals that were being paid
     * yesterday, which is the one thing a settings migration must not do.
     */
    expect(
      brokerRevenueFor({
        basis: 'commission_swap',
        legs,
        lots: '2.00000000',
        spreadMarkupPerLot: null,
      }),
    ).toEqual({ ok: true, revenue: '4.00000000' });
  });

  it('pays on the spread alone when that is the agreed method', () => {
    expect(
      brokerRevenueFor({
        basis: 'spread',
        legs,
        lots: '2.00000000',
        spreadMarkupPerLot: '7.50000000',
      }),
    ).toEqual({ ok: true, revenue: '15.00000000' });
  });

  it('sums both halves when the broker is paid both ways', () => {
    expect(
      brokerRevenueFor({
        basis: 'commission_swap_spread',
        legs,
        lots: '2.00000000',
        spreadMarkupPerLot: '7.50000000',
      }),
    ).toEqual({ ok: true, revenue: '19.00000000' });
  });

  it('charges one round turn ONE markup, however many legs it has', () => {
    /*
     * The mistake this shape exists to prevent. The charges half sums the
     * position's legs because MT5 splits a round turn's fees across them however
     * the broker configured it. Lots do NOT split that way — the opener and the
     * closer each carry the full size — so summing the markup across legs would
     * bill one trade's spread twice.
     */
    const threeLegs = [...legs, { commission: '-1.00000000', swap: '0.00000000' }];

    expect(
      brokerRevenueFor({
        basis: 'spread',
        legs: threeLegs,
        lots: '2.00000000',
        spreadMarkupPerLot: '7.50000000',
      }),
    ).toEqual({ ok: true, revenue: '15.00000000' });
  });

  it('prices a PARTIAL close on what actually closed', () => {
    /*
     * Half of a 1.0 lot position. The other half earns its own markup when it
     * closes, which is what makes the two add up to one whole trade's spread.
     */
    expect(
      brokerRevenueFor({
        basis: 'spread',
        legs: [{ commission: '0', swap: '0' }],
        lots: '0.50000000',
        spreadMarkupPerLot: '7.50000000',
      }),
    ).toEqual({ ok: true, revenue: '3.75000000' });
  });

  it('REFUSES a spread basis on an account linked to no product', () => {
    const result = brokerRevenueFor({
      basis: 'spread',
      legs,
      lots: '2.00000000',
      spreadMarkupPerLot: null,
    });

    expect(result.ok).toBe(false);

    /*
     * The message has to name the fix, because it reaches an operator through
     * `commission_last_error` with no other context around it.
     */
    if (!result.ok) {
      expect(result.reason).toContain('linked to no product');
      expect(result.reason).toContain('Trading settings');
    }
  });

  it('refuses under the hybrid basis too, rather than quietly paying the charges half', () => {
    /*
     * The tempting shortcut, and why it is wrong: falling back to charges-only
     * would pay a plausible number that is not the agreed one, on every deal for
     * every unlinked account, and nothing anywhere would say so. A refusal defers
     * the deal on the existing backoff and the money stays owed.
     */
    expect(
      brokerRevenueFor({
        basis: 'commission_swap_spread',
        legs,
        lots: '2.00000000',
        spreadMarkupPerLot: null,
      }).ok,
    ).toBe(false);
  });

  it('accepts a ZERO markup, because that is a price and not a hole', () => {
    /*
     * The distinction the `null` refusal rests on. A raw-spread product genuinely
     * carries no markup, and under a spread-only basis it genuinely earns the
     * broker nothing — which the caller then marks decided. That is correct, and
     * it is also the trap migration 0101 documents: switch the basis before the
     * markups are populated and the queue drains paying nothing, permanently.
     */
    expect(
      brokerRevenueFor({
        basis: 'spread',
        legs,
        lots: '2.00000000',
        spreadMarkupPerLot: '0.00000000',
      }),
    ).toEqual({ ok: true, revenue: '0.00000000' });
  });

  it('has no revenue on a position whose legs were all consumed', () => {
    /*
     * `unconsumedLegs` comes back EMPTY on a partial close where the first close
     * already took both legs — see the caller's own note on why that is not an
     * error.
     */
    expect(
      brokerRevenueFor({
        basis: 'commission_swap',
        legs: [],
        lots: '2.00000000',
        spreadMarkupPerLot: null,
      }),
    ).toEqual({ ok: true, revenue: '0.00000000' });
  });
});
