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
  /** Their rung. It names their placement; it no longer decides their rate. */
  level: number;
  /** The programme that DOES decide their rate — FR-IB-06, one per partner. */
  programId: string;
}

/** A resolved earner: who, and at what depth above the client. */
export interface ChainEntry {
  ibUserId: string;
  /** 1 is the partner who introduced the client; 2 is that partner's parent. */
  depth: number;
  level: number;
  programId: string;
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

    chain.push({ ibUserId: node.userId, depth, level: node.level, programId: node.programId });
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

/** Which legs a programme pays — FR-IB-05. */
export type ProgramMode = 'commission_only' | 'rebate_only' | 'hybrid';

/**
 * One programme's terms, as configured on `ib_programs`.
 *
 * ## The rate is chosen by DEPTH, not by the holder's rung
 *
 * `level1Rate` applies when the trade belongs to the holder's OWN client;
 * `level2Rate` when it belongs to a sub-partner's client. That is what makes a
 * programme portable — it pays the same way wherever in a chain its holder
 * stands — and it is the thing the old rung-keyed ladder could not say: under
 * that model what you earned depended on which rung you occupied rather than on
 * whose client had traded.
 *
 * Every value is a PERCENTAGE of the broker's revenue. One unit, always:
 * `payoutModel` used to sit beside the rate and decide whether the number meant
 * 70% or $70-per-lot, and migration 0055 removed it because a cut of what the
 * broker earned is a percentage by definition.
 */
export interface ProgramTerms {
  id: string;
  mode: ProgramMode;
  level1Rate: string;
  level2Rate: string;
  /** What returns to the TRADING CLIENT, as a percentage of the same revenue. */
  rebateRate: string;
  enabled: boolean;
}

export interface Accrual {
  ibUserId: string;
  depth: number;
  level: number;
  /** Which programme paid it, and at what rate — both recorded on the row. */
  programId: string;
  rateValue: string;
  /** A fixed-scale decimal string, never a number. */
  amount: string;
}

/**
 * The client's leg — money returning to the person who traded.
 *
 * `ibUserId` is the partner whose programme PRODUCED it, not who receives it.
 * The beneficiary is the trading client, and there is only ever one of them per
 * event, which is why this is a single value rather than a list.
 *
 * It comes from the INTRODUCER's programme — the depth-1 partner — because that
 * is the relationship the client is actually in. A partner further up the chain
 * setting the rebate would be altering terms in a relationship they do not own,
 * and two partners in one chain with different rebate rates would otherwise have
 * no defined answer at all.
 */
export interface RebateLeg {
  ibUserId: string;
  programId: string;
  rateValue: string;
  amount: string;
}

export interface CommissionResult {
  accruals: Accrual[];
  /** Absent unless the introducer's programme pays a rebate and it rounds above zero. */
  rebate?: RebateLeg;
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
  /** Every programme held by anybody in `chain`, keyed by id. */
  programs: Map<string, ProgramTerms>,
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
  /*
   * `greaterThan(0)`, NOT `!isPositive()`.
   *
   * decimal.js gives ZERO a sign of 1, so `new Decimal(0).isPositive()` is TRUE
   * and this guard never fired on a zero base — the same quirk `transferToMain`
   * documents, and it read correctly here while doing nothing. A zero-revenue
   * deal fell through to the loop, produced legs that rounded to nothing, and
   * returned an empty result with NO explanation, which is indistinguishable
   * from "nobody was owed anything" to the operator reading the log.
   */
  if (!gross.greaterThan(0)) {
    return { accruals: [], skippedReason: 'non-positive revenue base' };
  }

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

    const program = programs.get(entry.programId);

    if (!program) {
      skipped.push(`partner at depth ${entry.depth} has no configured programme`);
      continue;
    }
    /*
     * A DISABLED programme takes no share. Same rule the placement logic
     * enforces on a rung: an operator who switches terms off has stopped them
     * paying, and honouring them anyway would make the switch decorative.
     */
    if (!program.enabled) {
      skipped.push(`programme ${program.id} is disabled`);
      continue;
    }
    /*
     * `rebate_only` pays the CLIENT and nobody else. It is a real model — the
     * broker buys volume by handing the spread back — and the partner earning
     * nothing on it is the point, not an omission.
     */
    if (program.mode === 'rebate_only') {
      skipped.push(`programme ${program.id} is rebate-only, so no commission accrues`);
      continue;
    }

    /*
     * DEPTH decides the rate, not the rung. Depth 1 is the partner's own
     * client; depth 2 is a sub-partner's. `MAX_CHAIN_DEPTH` is 2, so there is
     * no third case to fall through to.
     */
    const rateValue = entry.depth === 1 ? program.level1Rate : program.level2Rate;
    const rate = toDecimal(rateValue);
    // `greaterThan(0)` for the reason the base check above records: a rate of
    // exactly zero is `isPositive()` in decimal.js, so a programme deliberately
    // paying nothing at this depth would silently produce an unexplained empty
    // result instead of saying so.
    if (!rate.greaterThan(0)) {
      skipped.push(`programme ${program.id} pays nothing at depth ${entry.depth}`);
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
      programId: program.id,
      rateValue,
      amount,
    });
  }

  /*
   * ── THE CLIENT'S LEG ─────────────────────────────────────────────────────
   *
   * Read from the INTRODUCER's programme — see `RebateLeg` for why it is that
   * partner's and not anyone else's in the chain.
   *
   * A suspended introducer breaks the chain before this runs, so a client whose
   * partner has been switched off stops receiving a rebate too. That is the
   * conservative reading and it is deliberate: the rebate is a term of the
   * relationship the operator has just suspended.
   */
  let rebate: RebateLeg | undefined;
  const introducer = chain.find((entry) => entry.depth === 1);
  const introducerProgram = introducer ? programs.get(introducer.programId) : undefined;

  if (
    introducer &&
    introducerProgram?.enabled &&
    introducerProgram.mode !== 'commission_only' &&
    event.source !== 'deposit'
  ) {
    const rebateRate = toDecimal(introducerProgram.rebateRate);
    if (rebateRate.greaterThan(0)) {
      const amount = money(gross.times(rebateRate).dividedBy(100));
      // Rounded first, then tested — the same order, and the same reason, as
      // the commission legs above.
      if (!toDecimal(amount).isZero()) {
        rebate = {
          ibUserId: introducer.ibUserId,
          programId: introducerProgram.id,
          rateValue: introducerProgram.rebateRate,
          amount,
        };
      }
    }
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
  /*
   * ── The REBATE is inside the cap, not beside it ──────────────────────────
   *
   * It is a share of the same revenue as every commission leg, so a cap that
   * scaled the partners and left the client's leg untouched would let the total
   * paid out exceed the broker's floor by exactly the rebate — while reporting
   * that it had enforced the floor. Everything that comes out of this revenue
   * is scaled together, and the proportions between the legs survive it.
   */
  if (maxSharePct !== undefined && (accruals.length > 0 || rebate)) {
    const cap = toDecimal(maxSharePct);
    if (cap.isPositive()) {
      const ceiling = gross.times(cap).dividedBy(100);
      const total = accruals
        .reduce((sum, a) => sum.plus(toDecimal(a.amount)), new Decimal(0))
        .plus(rebate ? toDecimal(rebate.amount) : 0);

      if (total.greaterThan(ceiling)) {
        const factor = ceiling.dividedBy(total);
        for (const accrual of accruals) {
          accrual.amount = money(toDecimal(accrual.amount).times(factor));
        }
        if (rebate) rebate.amount = money(toDecimal(rebate.amount).times(factor));
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
        /*
         * The client's leg is dropped by the same rule as a partner's: a rebate
         * scaled below what the column can store is worth nothing, and inventing
         * a satoshi to keep the row would pay an amount the cap says is not
         * owed.
         */
        if (rebate && toDecimal(rebate.amount).isZero()) {
          skipped.push('the rebate scaled below the storable minimum and was dropped');
          rebate = undefined;
        }

        return {
          accruals: survivors,
          rebate,
          skippedReason: skipped.length > 0 ? skipped.join('; ') : undefined,
        };
      }
    }
  }

  return {
    accruals,
    rebate,
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
  /**
   * The client's leg, counted with the rest.
   *
   * It leaves the broker by the same door and comes out of the same revenue, so
   * a unit error in `rebateRate` is exactly as expensive as one in a commission
   * rate — and a check that ignored it would pass a programme paying 900% back
   * to the client while refusing one paying 101% to a partner.
   */
  rebate?: RebateLeg,
): { ok: true } | { ok: false; reason: string } {
  const gross = toDecimal(event.grossAmount);
  const total = accruals
    .reduce((sum, accrual) => sum.plus(toDecimal(accrual.amount)), new Decimal(0))
    .plus(rebate ? toDecimal(rebate.amount) : 0);

  /*
   * ## The lot count does NOT exempt an event from this check
   *
   * Two guards used to stand here, both keyed on `event.lots`: an early
   * `if (event.lots !== undefined) return { ok: true }` and a second condition
   * repeating it. Both dated from `per_lot`, which paid a rate × a volume and
   * genuinely was not bounded by the revenue — a broker may pay $7/lot on a
   * trade it earned $5 on, buying volume at a loss.
   *
   * `per_lot` was REMOVED in migration 0055. Lots no longer enter the
   * arithmetic anywhere ("it ignores the lot count entirely", commission.spec),
   * so every accrual this function ever sees is now a share of broker revenue —
   * and the exemption had become a hole rather than a rule.
   *
   * It was not a theoretical hole. The deal feed is the ONLY live accrual path,
   * and it always sets `lots` (deal-commission.service.ts passes `deal.volume`),
   * so this guard returned `ok: true` on 100% of real accruals: the §12.4
   * ceiling refusal and its COMMISSION_CEILING_BREACH page were dead code in
   * production. Every test that "covered" it used a fixture with no lots, which
   * is exactly how it survived review — the same failure mode the docblock in
   * `calculate` above describes for the identical bug it already fixed once.
   */
  if (total.greaterThan(gross)) {
    return {
      ok: false,
      reason:
        `Total payout ${money(total)} exceeds the ${event.source}'s own value ` +
        `${money(gross)}. A share cannot exceed the thing it is a share OF, so this is a rate ` +
        'unit error rather than a large event. Nothing has been accrued.',
    };
  }

  return { ok: true };
}
