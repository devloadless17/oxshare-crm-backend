import Decimal from 'decimal.js';
import { money, toDecimal } from '../wallet/money';

/**
 * The commission engine's pure core — data in, data out.
 *
 * No Nest, no Drizzle, no `database/`, no `store/`. Lint blocks those imports
 * here for the same reason it blocks them in `wallet/money.ts`: the two
 * decisions this file owns — WHO earns and HOW MUCH — are the ones worth being
 * able to test exhaustively without a container, and every boundary case in
 * them is arithmetic rather than I/O.
 *
 * ## This is a rebuild, and it is deliberately NOT the engine that was deleted
 *
 * The previous version (removed in migration 0028) computed from MT5 `deals` —
 * spread × volume — through an `ib_programs` table. Both are gone: there is no
 * bridge, no deal feed, and no programs table. Rebuilding against them would be
 * an engine that can never run.
 *
 * What this one computes from is what the system actually HAS: a client
 * deposit, attributed to a partner by `users.referred_by_ib_user_id`, paid out
 * along the `ib_levels` ladder. When a deal feed lands, `RevenueEvent` gains a
 * `deal` source and `poolFor` gains a branch — the chain resolution and the
 * split below do not change.
 *
 * ## `per_lot` cannot be honoured yet, and this file refuses rather than guesses
 *
 * `ib_levels.payout_model` allows `per_lot`, whose rate is an amount per
 * standard lot. A deposit has no lot count — nothing in this database does —
 * so there is no honest number to compute. `calculate` returns an empty accrual
 * set with a stated reason instead of silently treating the rate as a
 * percentage, which would pay a wrong figure that looks correct.
 */

/** How many rungs earnings travel. Matches ARCHITECTURE: resolution stops at L2. */
export const MAX_CHAIN_DEPTH = 2;

/** One partner in the chain above an earning event. */
export interface ChainNode {
  userId: string;
  parentIbUserId: string | null;
  /** A suspended partner keeps their tree and stops earning. */
  active: boolean;
  /** Their rung, which decides their rate. */
  level: number;
}

/** A resolved earner: who, and at what depth above the client. */
export interface ChainEntry {
  ibUserId: string;
  /** 1 is the partner who introduced the client; 2 is that partner's parent. */
  depth: number;
  level: number;
}

/**
 * Walk from the introducing partner upward, at most `MAX_CHAIN_DEPTH` rungs.
 *
 * The rules, each with a reason:
 *
 *  - No attribution, or the partner does not exist → nobody earns.
 *  - A SUSPENDED partner earns nothing AND breaks the chain. Suspension is a
 *    decision about that partner's whole subtree; letting their parent keep
 *    collecting through them would pay somebody for a relationship the operator
 *    has just switched off.
 *  - Anything above depth 2 earns nothing, ever.
 *
 * `lookup` injects the data so this stays pure. A CYCLE — which Postgres cannot
 * prevent on a self-referencing key — terminates the walk rather than hanging
 * it: `seen` is the only thing between a mis-assigned parent and an infinite
 * loop on the money path.
 */
export function resolveChain(
  introducerId: string | null | undefined,
  lookup: (userId: string) => ChainNode | undefined,
): ChainEntry[] {
  if (!introducerId) return [];

  const chain: ChainEntry[] = [];
  const seen = new Set<string>();

  let currentId: string | null = introducerId;
  for (let depth = 1; depth <= MAX_CHAIN_DEPTH && currentId; depth += 1) {
    if (seen.has(currentId)) break;
    seen.add(currentId);

    const node: ChainNode | undefined = lookup(currentId);
    if (!node || !node.active) break;

    chain.push({ ibUserId: node.userId, depth, level: node.level });
    currentId = node.parentIbUserId;
  }

  return chain;
}

/** What generated the revenue a commission is a share of. */
export interface RevenueEvent {
  /**
   * The gross amount the event moved, as a decimal string (§6.1).
   *
   * For a deposit this is what the client funded. It is the base the rate
   * applies to — NOT itself the commission.
   */
  grossAmount: string;
  currency: string;
  /**
   * Where the revenue came from. One value today; a deal feed adds `'deal'`
   * here and a branch in `poolFor`, and nothing else in this file moves.
   */
  source: 'deposit';
}

/** One rung's terms, as configured on `ib_levels`. */
export interface LevelTerms {
  level: number;
  payoutModel: 'revenue_share' | 'per_lot';
  /** Percentage under revenue_share; amount-per-lot under per_lot. */
  rateValue: string;
  enabled: boolean;
}

export interface Accrual {
  ibUserId: string;
  depth: number;
  level: number;
  /** A fixed-scale decimal string, never a number. */
  amount: string;
}

export interface CommissionResult {
  accruals: Accrual[];
  /**
   * Why nothing was accrued, when the chain was non-empty but the result is.
   *
   * Present so a caller can LOG the refusal rather than recording a silent
   * zero — "this level is per_lot and a deposit has no lots" is a
   * configuration problem somebody must fix, and an empty result with no
   * explanation is indistinguishable from "nobody was owed anything".
   */
  skippedReason?: string;
}

/**
 * Split an earning event across the resolved chain.
 *
 * Each earner is paid at THEIR OWN level's rate, taken from `terms`. That is
 * what the ladder means: an L1 and an L2 on the same deposit are paid different
 * percentages because they occupy different rungs, and reading one rate for
 * both would silently pay the wrong partner the wrong share.
 *
 * Every step is decimal.js. Nothing here touches a JS number — `Number()` and
 * `parseFloat` are lint errors in this module.
 */
export function calculate(
  event: RevenueEvent,
  chain: ChainEntry[],
  terms: Map<number, LevelTerms>,
): CommissionResult {
  if (chain.length === 0) return { accruals: [] };

  const gross = toDecimal(event.grossAmount);
  /*
   * A non-positive base pays nothing. A refunded or zero deposit must not
   * produce a negative accrual — that would be a debit dressed as an earning,
   * and clawbacks are a separate, deliberate operation (a compensating ledger
   * entry), not a side effect of this function.
   */
  if (!gross.isPositive()) return { accruals: [], skippedReason: 'non-positive revenue base' };

  const accruals: Accrual[] = [];
  const skipped: string[] = [];

  for (const entry of chain) {
    const rung = terms.get(entry.level);

    if (!rung) {
      skipped.push(`level ${entry.level} has no configured terms`);
      continue;
    }
    /*
     * A DISABLED level takes no share. Same rule the placement logic enforces:
     * an operator who disables a rung has stopped it earning, and paying it
     * anyway would make the switch decorative.
     */
    if (!rung.enabled) {
      skipped.push(`level ${entry.level} is disabled`);
      continue;
    }
    /*
     * `per_lot` has no honest answer here — see the file note. Refusing is the
     * whole point: treating the rate as a percentage would pay a plausible
     * wrong number, and treating it as a flat amount would pay the same figure
     * on a $10 deposit as on a $10,000 one.
     */
    if (rung.payoutModel === 'per_lot') {
      skipped.push(
        `level ${entry.level} is per_lot, which needs a lot count that a ${event.source} does not carry`,
      );
      continue;
    }

    const rate = toDecimal(rung.rateValue);
    if (!rate.isPositive()) {
      skipped.push(`level ${entry.level} has a non-positive rate`);
      continue;
    }

    /*
     * ROUNDED FIRST, then tested for zero — and that order is the whole point.
     *
     * `money()` fixes the value at the 8 decimal places the column stores. A
     * leg worth 0.000000001 is non-zero as a `Decimal` but is `'0.00000000'`
     * once stored, so testing `amount.isZero()` before rounding lets it through
     * as an accrual of nothing.
     *
     * That is not merely untidy: `ib_accruals_amount_positive` REFUSES a
     * non-positive amount, so the row would fail its insert at runtime — one
     * dust-sized leg taking down the accrual of every legitimate earner in the
     * same statement. Skipping here is what keeps the two consistent.
     */
    const amount = money(gross.times(rate).dividedBy(100));
    if (toDecimal(amount).isZero()) continue;

    accruals.push({
      ibUserId: entry.ibUserId,
      depth: entry.depth,
      level: entry.level,
      amount,
    });
  }

  return {
    accruals,
    skippedReason: skipped.length > 0 ? skipped.join('; ') : undefined,
  };
}

/**
 * Is this set of accruals arithmetically plausible?
 *
 * The backstop against a unit error — a rate entered as `70` meaning 70% versus
 * `70` meaning 70× — reaching a wallet. A commission is a SHARE of revenue, so
 * the total paid out cannot exceed the revenue it is a share of; anything that
 * does is a configuration mistake, not a large deposit.
 *
 * Returns the reason rather than throwing, so the caller decides whether that
 * is a refusal or an alert. Separated from `calculate` because "what is owed"
 * and "is what is owed sane" are different questions, and a caller may want the
 * first without the second in a projection.
 */
export function checkPlausible(
  event: RevenueEvent,
  accruals: readonly Accrual[],
): { ok: true } | { ok: false; reason: string } {
  const gross = toDecimal(event.grossAmount);
  const total = accruals.reduce(
    (sum, accrual) => sum.plus(toDecimal(accrual.amount)),
    new Decimal(0),
  );

  if (total.greaterThan(gross)) {
    return {
      ok: false,
      reason:
        `Total commission ${money(total)} exceeds the ${event.source}'s own value ` +
        `${money(gross)}. A share cannot exceed the thing it is a share OF, so this is a rate ` +
        'unit error rather than a large event. Nothing has been accrued.',
    };
  }

  return { ok: true };
}
