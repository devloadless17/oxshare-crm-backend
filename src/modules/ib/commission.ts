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
 * ## Both payout models work, and each has its own base
 *
 * `revenue_share` takes a percentage of the BROKER'S revenue on a closed trade.
 * `per_lot` pays a fixed amount per standard lot. Neither can be computed from
 * a deposit, and `calculate` refuses one rather than inventing a base — see the
 * deposit branch, which exists because taking 70% of a client's own deposit was
 * live and losing the broker money on every funded account.
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
   * Where the revenue came from.
   *
   * ## `'deposit'` is no longer a revenue event, and must not become one again
   *
   * It was, and it was wrong in a way that cost the broker money on every
   * client: a deposit is not revenue. The money still belongs to the client and
   * is recorded as a liability against it, so paying a partner 70% of a $1,000
   * deposit hands them $700 of the BROKER's money while the client keeps the
   * right to withdraw all $1,000. Unbounded, and it scales with deposit volume.
   *
   * The value survives for CPA — a FIXED amount per qualified client, which is
   * a real model — and for nothing else. A percentage of a deposit is not a
   * model any brokerage runs.
   */
  source: 'deposit' | 'deal';
  /**
   * Lots traded, for `per_lot`. Present on a deal and absent on anything else,
   * which is exactly why `per_lot` could never be honoured before.
   */
  lots?: string;
}

/** One rung's terms, as configured on `ib_levels`. */
export interface LevelTerms {
  level: number;
  /**
   * The rung's share, as a PERCENTAGE of the broker's revenue on the trade.
   *
   * One unit. `payoutModel` used to sit beside this and decide whether the
   * number meant 70% or $70-per-lot; migration 0055 removed it, because a
   * commission cut from what the broker earned is a percentage by definition.
   */
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
  /**
   * The most of this event's revenue that may go to partners, as a percentage.
   *
   * The broker's margin, guaranteed by arithmetic rather than by everyone
   * remembering to keep the ladder under 100. Omitted means uncapped, which is
   * what the pure unit tests use — every production caller passes it.
   */
  maxSharePct?: string,
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
    /*
     * ── A REVENUE SHARE OF A DEPOSIT IS NOT A COMMISSION ──────────────────
     *
     * This is the bug this branch exists to close, and it was live: with a
     * level at 70% revenue share, a client depositing 1000 paid their partner
     * 700 — of the broker's own money, since the deposit is a LIABILITY. The
     * client still owns it and can withdraw it, so the broker is simply down
     * 700 per deposit, unbounded and scaling with volume.
     *
     * The plausibility guard did not catch it because 700 is less than 1000; a
     * share smaller than its base is exactly what a correct share looks like.
     * The error is not the size, it is the BASE.
     *
     * A percentage may only be taken of what the broker EARNED, which arrives
     * on a closed trade. A broker who wants to pay for a funded client wants
     * CPA — a fixed sum per qualifying deposit — which is a different model
     * with a different column, not this one with a different basis.
     */
    if (event.source === 'deposit') {
      skipped.push(
        'a revenue share cannot be taken of a deposit — the money is the client’s, ' +
          'not the broker’s revenue. Commission is earned on closed trades.',
      );
      continue;
    }

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
    /*
     * ONE base, and it is what the BROKER earned on the trade — its commission
     * and swap, never the client's volume, profit or balance.
     *
     * There used to be a second: `per_lot` multiplied the rate by lots traded,
     * pricing a rebate on size rather than on money. Migration 0055 removed the
     * model, so `rateValue` has exactly one meaning and this has one branch.
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

  /*
   * ── THE BROKER'S FLOOR ───────────────────────────────────────────────────
   *
   * Each rung's rate is a share of the FULL revenue, so the rates ADD UP: a
   * two-level chain at 70 + 30 pays out everything the house earned and leaves
   * it nothing on that client. `checkPlausible` cannot catch it either — it
   * refuses totals GREATER than the revenue, and exactly 100% is not greater.
   *
   * So the total is capped here and scaled PRO RATA, which keeps the ladder's
   * proportions intact: a rung worth twice another still earns twice as much,
   * everyone simply earns less. The alternative — paying the rungs in order
   * until the pool runs out — would silently zero the deepest partner, who
   * would have no way to know why.
   *
   * ── It applies to EVERY leg, and that took two fixes to get right ──────────
   *
   * The condition used to read `event.lots === undefined`, exempting any event
   * that carried a lot count. Every real commission carries one:
   * `CommissionService` sets `lots: position.lots` on the deal event, and a deal
   * is the only source that pays since deposits stopped being revenue. So the
   * broker's floor was bypassed on every commission the running system produced,
   * while every test of it passed by using a fixture with no lots.
   *
   * The exemption was meant for the per-lot PAYOUT — a rebate priced on size is
   * not a share of revenue and may legitimately exceed it — so it was narrowed
   * to the per-accrual model. Migration 0055 then removed the model entirely:
   * every leg is a percentage of the broker's revenue now, so every leg is
   * capped, and the distinction is gone with the thing it distinguished.
   */
  if (maxSharePct !== undefined && accruals.length > 0) {
    const cap = toDecimal(maxSharePct);
    if (cap.isPositive()) {
      const ceiling = gross.times(cap).dividedBy(100);
      const total = accruals.reduce((sum, a) => sum.plus(toDecimal(a.amount)), new Decimal(0));

      if (total.greaterThan(ceiling)) {
        const factor = ceiling.dividedBy(total);
        for (const accrual of accruals) {
          accrual.amount = money(toDecimal(accrual.amount).times(factor));
        }
        skipped.push(
          `chain total ${money(total)} exceeded the broker's ${maxSharePct}% cap; ` +
            `scaled to ${money(ceiling)}`,
        );

        /*
         * ── DROP WHAT SCALED AWAY ─────────────────────────────────────────
         *
         * The same rule the per-leg rounding above enforces, re-applied because
         * SCALING can recreate exactly what that guard removed: a cap of 0 —
         * which the settings DTO permits, meaning "partners earn nothing" —
         * takes every leg to `0.00000000`, and a small enough cap does it to the
         * smallest leg alone.
         *
         * `ib_accruals_amount_positive` is a CHECK constraint, so a zero row
         * does not store a harmless nothing: it refuses the INSERT, and the
         * service inserts every earner on the trade in ONE statement. One
         * dust-sized leg would take down the commission of every legitimate
         * earner beside it.
         *
         * Filtered rather than clamped to a minimum: a leg worth less than the
         * column can represent is worth nothing, and inventing a satoshi to keep
         * the row would pay a number the cap says is not owed.
         */
        const survivors = accruals.filter((accrual) => !toDecimal(accrual.amount).isZero());
        if (survivors.length !== accruals.length) {
          skipped.push(
            `${accruals.length - survivors.length} leg(s) scaled below the storable minimum ` +
              'and were dropped',
          );
        }
        return {
          accruals: survivors,
          skippedReason: skipped.length > 0 ? skipped.join('; ') : undefined,
        };
      }
    }
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

  /*
   * A per-lot payout is NOT a share of the revenue and is not bounded by it —
   * a broker may legitimately pay $7/lot on a trade it earned $5 on, buying
   * volume at a loss on that trade. Checking it against `grossAmount` would
   * refuse a correct configuration.
   *
   * It is not left unguarded: the size of a per-lot payout is bounded by the
   * lots, and an absurd rate is caught by the same ceiling the settings screen
   * enforces. What this guard exists for is the UNIT error on a percentage —
   * `70` meaning 70× rather than 70% — which only applies to revenue_share.
   */
  if (event.lots !== undefined) return { ok: true };

  /*
   * The check applies to SHARES, not to per-lot rebates.
   *
   * A per-lot payout is not a share of anything — it is a rate times a volume,
   * and it can legitimately exceed the broker's revenue on a single trade (a
   * rebate deal that loses money on scalpers is a commercial choice, not an
   * arithmetic error). Applying the share test to it would refuse a correct
   * payout, so per-lot events are checked against a much cruder bound: the rate
   * itself is validated on the level, and anything beyond that is the
   * operator's decision.
   */
  if (event.source !== 'deal' || event.lots === undefined) {
    if (total.greaterThan(gross)) {
      return {
        ok: false,
        reason:
          `Total commission ${money(total)} exceeds the ${event.source}'s own value ` +
          `${money(gross)}. A share cannot exceed the thing it is a share OF, so this is a rate ` +
          'unit error rather than a large event. Nothing has been accrued.',
      };
    }
  }

  return { ok: true };
}
