import Decimal from 'decimal.js';
import {
  basisCountsCharges,
  basisCountsSpread,
  type RevenueBasis,
} from '../../common/revenue-basis';

/**
 * What the broker actually KEPT on a trade — the only base a partner is paid on.
 *
 * ## The sign convention, and the mistake it invites
 *
 * MT5 reports both figures from the CLIENT's point of view: a charge to the
 * client is NEGATIVE, and money credited to them is positive. The broker's
 * earning is therefore the negated value of whatever was charged, and nothing
 * at all when the client was the one who received it.
 *
 * The obvious-looking `|commission| + |swap|` gets this wrong in one direction
 * only, which is why it survives a reading: it is correct for every deal where
 * both figures are charges, and those are most of them. On a deal where swap
 * was credited TO the client — a long position on the positive side of an
 * interest-rate differential, held overnight, which is an ordinary trade and
 * not an exotic one — it counts money the broker PAID OUT as money the broker
 * earned, and then pays a partner a share of it. The broker is out the swap and
 * out the commission on the swap.
 *
 * So each leg is floored at zero SEPARATELY. Flooring only the total would let
 * a credited swap cancel a real commission charge, which is the same error
 * wearing the opposite sign: the partner earns nothing on a trade the broker
 * was paid for.
 *
 * ## Why this is a function and not two lines at each call site
 *
 * It was two lines at one call site, and they did not match the docblock
 * directly above them — that comment already described flooring a credited swap
 * at zero while the code took its magnitude. A money rule that lives in prose
 * beside its own contradiction is a rule that is not enforced anywhere, and
 * there are now two paths that need it: the CRM's own position close and the
 * MT5 deal feed. Two copies of a formula this easy to state wrongly would
 * eventually pay two different amounts for one trade.
 *
 * ## Not the client's profit, ever
 *
 * `profit` is deliberately not a parameter. A client winning does not cost
 * their partner a commission and a client losing does not enrich them — tying
 * partner pay to client losses is the incentive nobody should build. The house
 * earns its commission and its swap either way, and that is the whole base.
 *
 * @param deal Amounts as MT5 reports them, decimal strings (§6.1).
 * @returns The broker's revenue as a decimal string, never negative.
 */
export function brokerRevenueOf(deal: { commission: string; swap: string }): string {
  const charged = (amount: string): Decimal => Decimal.max(new Decimal(amount).negated(), 0);

  return charged(deal.commission).plus(charged(deal.swap)).toFixed(8);
}

/**
 * The spread the broker earned on one closed lot-count.
 *
 * `lots × markupPerLot`, and the two rules that keep it honest:
 *
 * **It is the DESK's figure, not MT5's.** Migration 0095 checked whether this
 * could mirror the server and it cannot: MT5 carries `AskMarkup`/`BidMarkup`
 * per group AND symbol, in points, split by side, and converting any of it to
 * currency-per-lot needs each symbol's contract size and tick value at a price.
 * So this is what the business says a product is sold on — which is exactly why
 * it must not be switched on by anyone but the business.
 *
 * **It is computed on the CLOSING deal's volume, once — never summed over the
 * position's legs.** A round turn's opener and closer each carry the same lot
 * count, so summing them would charge the markup twice for one trade. The
 * closing volume is also what makes a PARTIAL close right: closing 0.5 of a 1.0
 * lot position earns markup on 0.5, and the remaining half earns its own when it
 * closes. This is the same number `per_lot` payouts already price on.
 *
 * Floored at zero for the same reason `brokerRevenueOf` floors each leg: the
 * column's CHECK refuses a negative markup, but a floor here means a future
 * writer that skips the constraint cannot turn a trade into a partner debt.
 *
 * @param lots Lot count as a decimal string. `mt5_deals.volume` is already in
 *   lots — the bridge divides MT5's integer volume by 10,000 on the way in.
 * @param markupPerLot `trading_products.spread_markup_per_lot`, a decimal string.
 */
export function spreadRevenueOf(lots: string, markupPerLot: string): string {
  const size = Decimal.max(new Decimal(lots), 0);
  const rate = Decimal.max(new Decimal(markupPerLot), 0);

  return size.times(rate).toFixed(8);
}

/**
 * The whole base one closed position pays a partner on, under the chosen basis.
 *
 * ## Why every caller must pass all four fields
 *
 * There is no default for `spreadMarkupPerLot` and no default for `basis`. That
 * is the point: the two call sites that compute a partner's base — the MT5 deal
 * feed and the CRM's own position close — must each state what they know, so a
 * future one cannot inherit `commission + swap` by omission the day the operator
 * has chosen otherwise. A silent partial application of a repricing is worse
 * than either pricing.
 *
 * ## A missing PRODUCT is refused, a zero markup is not
 *
 * `spread_markup_per_lot` is `NOT NULL DEFAULT 0`, so a product always has a
 * figure and zero is a legitimate one — a raw-spread product genuinely carries
 * no markup. `null` here means something different and worse: the trading
 * account is linked to **no product at all**, so nothing in the system knows
 * what it is sold on. Under a spread-inclusive basis that is a configuration
 * hole, not a price, and it comes back as `ok: false` so the caller can defer
 * the deal on the existing backoff rather than mark it decided-and-unpaid. The
 * money is owed either way; what is missing is the setting.
 *
 * Returned rather than thrown, matching `checkPlausible` in the sibling pure
 * seam: the decision of what a refusal costs belongs to the service that knows
 * whether this deal can be retried.
 */
export function brokerRevenueFor(input: {
  basis: RevenueBasis;
  /** The position's unconsumed legs, as `brokerRevenueOf` takes them. */
  legs: readonly { commission: string; swap: string }[];
  /** The CLOSING deal's volume, in lots. Never the sum of the legs'. */
  lots: string;
  /** The product's markup, or `null` when the account is linked to no product. */
  spreadMarkupPerLot: string | null;
}): { ok: true; revenue: string } | { ok: false; reason: string } {
  let total = new Decimal(0);

  if (basisCountsCharges(input.basis)) {
    total = input.legs.reduce((sum, leg) => sum.plus(brokerRevenueOf(leg)), total);
  }

  if (basisCountsSpread(input.basis)) {
    if (input.spreadMarkupPerLot === null) {
      return {
        ok: false,
        reason:
          `The revenue basis is '${input.basis}', which prices on the product's spread markup, ` +
          'but this trading account is linked to no product so no markup is defined for it. ' +
          'Link the account to a product, or change the revenue basis on the Trading settings.',
      };
    }

    total = total.plus(spreadRevenueOf(input.lots, input.spreadMarkupPerLot));
  }

  return { ok: true, revenue: total.toFixed(8) };
}
