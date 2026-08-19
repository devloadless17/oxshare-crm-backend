import { describe, expect, it } from 'vitest';
import { brokerRevenueOf } from './broker-revenue';

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
