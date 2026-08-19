import Decimal from 'decimal.js';

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
