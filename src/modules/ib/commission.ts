import Decimal from 'decimal.js';
import { money, toDecimal } from '../wallet/money';
import { DEFAULT_REVENUE_BASIS, type RevenueBasis } from '../../common/revenue-basis';

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
 * What this one computes from is what the system actually HAS: an ingested MT5
 * deal, attributed to a partner by `users.referred_by_ib_user_id`, paid out
 * along the tier ladder of each earner's own named programme
 * (`ib_programs` + `ib_program_tiers`).
 *
 * The second catalogue this used to read — `ib_levels`, a rung-keyed ladder —
 * was dropped in 0102. The FSD describes one catalogue and this schema had two;
 * see the header of the IB block in `database/schema.ts` for the full account.
 *
 * ## Both payout models work, and each has its own base
 *
 * `revenue_share` takes a percentage of the BROKER'S revenue on a closed trade.
 * `per_lot` pays a fixed amount per standard lot. Neither can be computed from
 * a deposit, and `calculate` refuses one rather than inventing a base — see the
 * deposit branch, which exists because taking 70% of a client's own deposit was
 * live and losing the broker money on every funded account.
 */

/**
 * A CYCLE GUARD, and deliberately not a payout policy.
 *
 * This used to be 2 — the two-level cap, written into the engine as a constant
 * while the console derived a payout depth from a rung count. The two disagreed
 * in the direction that costs money quietly: enabling a third level told an
 * operator earnings travelled three levels, and the third ancestor silently
 * earned nothing on every trade.
 *
 * How far earnings travel is now the number of tiers on the EARNER'S programme
 * (`ib_program_tiers`), which is FR-IB-17's "configured per the agreed program
 * ladder". What remains here is the reason a walk over a self-referencing
 * foreign key needs a stop at all: Postgres cannot prevent a cycle in
 * `parent_ib_user_id`, and this is the money path.
 *
 * `seen` below already terminates a true cycle. This bounds the other shape —
 * a chain so deep that walking it costs more than any programme could ever pay
 * on — and matches `ib_program_tiers_depth_range` and `ib_accruals_depth_range`
 * so a configurable depth can never exceed what the database will store.
 */
export const MAX_CHAIN_DEPTH = 10;

/** One partner in the chain above an earning event. */
export interface ChainNode {
  userId: string;
  parentIbUserId: string | null;
  /** A suspended partner keeps their tree and stops earning. */
  active: boolean;
  /**
   * The partner's RUNG, and what decides their terms — 0112.
   *
   * A property of the partner rather than of any trade: it is written when they
   * are appointed, from their parent's level, and only changes if somebody
   * re-parents them.
   */
  level: number;
  /** HISTORICAL — the programme they used to be paid on. Decides nothing now. */
  programId?: string;
}

/** A resolved earner: who, and at what depth above the client. */
export interface ChainEntry {
  ibUserId: string;
  /**
   * How many hops above the trading client this partner stands.
   *
   * 1 is the introducer, 2 is their parent, and so on. It is a property of THIS
   * TRADE, not of the partner: the same partner is at depth 1 on their own
   * client's trade and at depth 2 on a sub-partner's, and is paid the matching
   * tier of their own programme in each case.
   */
  depth: number;
  /**
   * HISTORICAL — the programme this partner used to be paid on (pre-0112).
   *
   * Kept on the entry so the accrual row can still record what priced it for
   * partners who have not been re-levelled. Nothing reads it to decide money.
   */
  programId?: string;
  /**
   * The earner's own RUNG in the partner tree — 0112, and what now decides their
   * terms.
   *
   * Distinct from `depth`, and the distinction is the whole change. `depth` is a
   * property of THIS TRADE — how far below this partner it happened. `level` is
   * a property of the PARTNER — how far below the broker they sit. A level 1
   * partner is paid their level 1 terms on their own client's trade and on a
   * sub-partner's alike, because their rung did not move.
   *
   * Programmes chose the rate by depth, so the same partner could earn
   * differently on their own clients than on a sub-partner's. Levels do not, and
   * that is what "static per lot for the main partner, percent for the partner
   * under him" describes.
   */
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
 *  - The walk stops at `MAX_CHAIN_DEPTH`, which is a CYCLE GUARD. It is not
 *    where earnings stop: `calculate` pays each entry from the tier its own
 *    programme configures at that depth, and an entry whose programme does not
 *    reach that far is skipped with a reason.
 *
 * ## Resolving further than a programme pays is the point, not waste
 *
 * A depth-3 ancestor on a three-tier programme must be REACHED before anyone
 * can ask what their programme says, and their own terms are the only thing
 * entitled to answer. Stopping the walk at the introducer's reach would let one
 * partner's contract silently cancel another's.
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

    chain.push({
      ibUserId: node.userId,
      depth,
      level: node.level,
      programId: node.programId,
    });
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
   * The trade's volume in standard lots — what a `per_lot` programme is priced
   * against (0111).
   *
   * This field predates the mode that reads it, carrying the note that per-lot
   * "could never be honoured before". It can now.
   *
   * The CLOSING deal's own volume, never the sum of a position's legs: a round
   * turn's legs each carry the same lot count, so summing them would pay one
   * trade's volume twice. `brokerRevenueFor` takes the same figure for exactly
   * the same reason.
   *
   * Absent on anything that is not a deal, and a per-lot programme with no
   * volume to price against earns nothing AND SAYS SO — reported in `skipped`
   * rather than treated as a zero that pays silently.
   */
  lots?: string;
}

/** Which legs a programme pays — FR-IB-05. */
export type ProgramMode = 'commission_only' | 'rebate_only' | 'hybrid';

/**
 * One programme's terms — `ib_programs` plus its `ib_program_tiers`.
 *
 * ## The rate is chosen by DEPTH, and the LADDER is how many depths there are
 *
 * `tiers` maps depth → rate: depth 1 is what the holder earns when the trade
 * belongs to their OWN client, depth 2 when it belongs to a sub-partner's, and
 * so on. That is what makes a programme portable — it pays the same way wherever
 * in a chain its holder stands — and it is the thing the old rung-keyed ladder
 * could not say: under that model what you earned depended on which rung you
 * occupied rather than on whose client had traded.
 *
 * It replaces a fixed `level1Rate` / `level2Rate` pair, which wrote a two-level
 * ceiling into the type itself. `tiers.size` is now how far this programme's
 * earnings reach, so a broker who wants five levels configures five rows —
 * FR-IB-17's "per-level split ... configured per the agreed program ladder".
 *
 * ## An absent depth is not a zero
 *
 * `tiers.get(3)` returning `undefined` means "this programme does not reach
 * depth 3", which is a different statement from "it pays 0% there" and produces
 * a different message when `calculate` explains itself. The database agrees:
 * `ib_program_tiers_rate_positive` refuses a zero-rate row, so a configured
 * depth always pays something.
 *
 * Every value is a PERCENTAGE of the broker's revenue. One unit, always:
 * `payoutModel` used to sit beside the rate and decide whether the number meant
 * 70% or $70-per-lot, and migration 0055 removed it because a cut of what the
 * broker earned is a percentage by definition.
 */
/**
 * One rung of the commission ladder — 0112, and what decides money now.
 *
 * ## Why this replaced a programme
 *
 * A programme was assigned to a partner and priced by DEPTH — how far below that
 * partner the trade happened — so one partner could earn differently on their
 * own clients than on a sub-partner's. A level is a property of the PARTNER:
 * their rung in the tree. A level 1 partner earns their level 1 terms on
 * everything that reaches them, however deep.
 *
 * The chain walk is unchanged either way, so both rules the business stated
 * still hold by construction: a sub-partner never appears in their parent's own
 * client's chain, and a parent does appear in a sub-partner's.
 *
 * ## One commission term and one rebate term, each either shape
 *
 * A level pays a percentage of broker revenue OR a flat amount per standard lot,
 * chosen per leg. The two are not interchangeable: a percentage is bounded by
 * the revenue it is a share of, and a per-lot amount is deliberately not — see
 * `checkPlausible`, which judges each by the bound natural to it.
 */
export interface LevelTerms {
  /** The `ib_levels` row id, recorded on every accrual it prices. */
  id: string;
  /** The rung this card pays. */
  level: number;
  /**
   * A disabled level takes no share.
   *
   * Same rule a disabled programme followed: an operator who switches terms off
   * has stopped them paying, and honouring them anyway makes the switch
   * decorative.
   */
  enabled: boolean;

  commissionMode: PayoutMode;
  /** A percentage of the broker's revenue. Read only in `percent` mode. */
  commissionRate: string;
  /** Money per standard lot. Read only in `per_lot` mode. */
  commissionAmountPerLot?: string;

  rebateMode: PayoutMode;
  rebateRate: string;
  rebateAmountPerLot?: string;

  /** WHICH revenue a percentage here is a share of — FR-IB-16. */
  revenueBasis?: RevenueBasis;
}

/** How one leg is priced — 0111. */
export type PayoutMode = 'percent' | 'per_lot' | 'share_of_parent';

/**
 * How deep a chain of `share_of_parent` rungs may resolve — 0114.
 *
 * A share reads the rung ABOVE, which may itself be a share. The recursion is
 * bounded by the ladder's own height and a ladder cannot contain a cycle (rungs
 * are integers and each reads a strictly smaller one), so this cannot loop.
 * It exists to make that reasoning explicit rather than implicit, and to stop a
 * pathological ladder costing a deep walk on the money path.
 */
const MAX_SHARE_CHAIN = 10;

/**
 * What one lot earns the holder of a rung, following `share_of_parent` upward.
 *
 * A share is a percentage of the rate on the level DIRECTLY ABOVE — level N
 * reads level N-1 — and NOT of the next earner in the chain. Those differ
 * whenever a rung is unconfigured or a partner is suspended, and reading the
 * chain would make one partner's rate depend on which of their ancestors was
 * active that day. A rate card has to be quotable without knowing the tree.
 *
 * Returns `undefined` when the share resolves to nothing payable: level 1 has
 * no rung above it, an ancestor rung is missing, or the rung it lands on is a
 * `percent` one — a percentage of broker revenue is not a per-lot figure, so
 * there is no honest number to take a share OF.
 */
function perLotRateFor(
  level: LevelTerms,
  levels: Map<number, LevelTerms>,
  depth = 0,
): Decimal | undefined {
  if (depth >= MAX_SHARE_CHAIN) return undefined;

  if (level.commissionMode === 'per_lot') {
    return toDecimal(level.commissionAmountPerLot ?? '0');
  }

  if (level.commissionMode !== 'share_of_parent') return undefined;

  const parent = levels.get(level.level - 1);
  if (!parent) return undefined;

  const parentRate = perLotRateFor(parent, levels, depth + 1);
  if (parentRate === undefined) return undefined;

  /* A percentage OF the parent's per-lot rate: 30% of $10 is $3. */
  return parentRate.times(toDecimal(level.commissionRate)).dividedBy(100);
}

export interface ProgramTerms {
  id: string;
  mode: ProgramMode;
  /** depth → rate, as a percentage string. Absent depth = this far and no further. */
  tiers: Map<number, string>;
  /**
   * depth → amount per standard lot, for tiers priced that way — 0111.
   *
   * A depth appears in EITHER this map or `tiers`, never both: the database
   * constraint requires exactly the column its mode reads. A depth in neither
   * is a programme that does not reach that far, which is what `tiers` alone
   * has always meant.
   *
   * Optional so every existing caller — and every in-memory test — keeps
   * working unchanged on percentage terms.
   */
  tiersPerLot?: Map<number, string>;
  /** What returns to the TRADING CLIENT, as a percentage of the same revenue. */
  rebateRate: string;
  /**
   * The client's rebate as a flat amount per standard lot — 0111.
   *
   * Present only when the programme's `rebate_mode` is `per_lot`, in which case
   * it is authoritative and `rebateRate` is not read at all.
   */
  rebateAmountPerLot?: string;
  /**
   * WHICH revenue this programme's rates are a percentage OF — FR-IB-16 (0106).
   *
   * The base is half of what a partner agreed to: "30% of the spread markup"
   * and "30% of commission and swap" are different contracts, and a single
   * platform-wide switch re-prices everybody at once. So it travels with the
   * terms, and `calculate` reads it per earner.
   *
   * Optional on this interface so an in-memory caller that does not care may
   * leave it out; absent means `commission_swap`, which is what every
   * deployment computes on today.
   */
  revenueBasis?: RevenueBasis;
  enabled: boolean;
}

export interface Accrual {
  ibUserId: string;
  depth: number;
  /**
   * Which LEVEL's terms paid this — 0112, and what the row records now.
   *
   * Optional only so the historical programme path and in-memory tests that
   * predate levels still construct. Every accrual the live engine writes carries
   * it.
   */
  levelId?: string;
  /**
   * HISTORICAL — the programme that priced rows written before 0112.
   *
   * A row carries exactly one of this and `levelId`: whichever produced it.
   * Together they keep the guarantee this type has always made, that the
   * arithmetic behind a credited amount is reproducible from the row alone.
   */
  programId?: string;
  rateValue: string;
  /**
   * The revenue this leg is a share OF, under the earner's own basis (0106).
   *
   * On the row rather than derived from the trade, because since FR-IB-16 there
   * is no single "the revenue" to derive it from: two earners on one trade may
   * price on different bases, so a row stamped with the trade's default figure
   * would claim `amount` is `rateValue`% of a number it is not. That is an
   * accrual nobody can check by arithmetic — the one property a money ledger
   * has to keep.
   */
  baseAmount: string;
  /** A fixed-scale decimal string, never a number. */
  amount: string;
  /**
   * True when this leg was priced per LOT rather than as a share of revenue.
   *
   * `baseAmount` then holds the VOLUME rather than a revenue figure, and
   * `rateValue` an amount per lot rather than a percentage — so a reader cannot
   * interpret either without this flag.
   *
   * `checkPlausible` is the other reason it exists, and the more important one:
   * a per-lot leg is legitimately allowed to exceed the trade's revenue, so it
   * must be bounded in its own units instead. Marking the leg is what lets that
   * function partition a mixed chain rather than applying one rule to both.
   */
  pricedPerLot?: boolean;
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
  /** Which LEVEL's terms produced it — 0112. See `Accrual.levelId`. */
  levelId?: string;
  /** HISTORICAL, for rows priced before levels. See `Accrual.programId`. */
  programId?: string;
  rateValue: string;
  /** The revenue this rebate is a share of — the INTRODUCER's basis. */
  baseAmount: string;
  amount: string;
  /**
   * True when this leg was priced per LOT rather than as a share of revenue.
   *
   * `baseAmount` then holds the VOLUME rather than a revenue figure, and
   * `rateValue` an amount per lot rather than a percentage — so a reader cannot
   * interpret either without this flag.
   *
   * `checkPlausible` is the other reason it exists, and the more important one:
   * a per-lot leg is legitimately allowed to exceed the trade's revenue, so it
   * must be bounded in its own units instead. Marking the leg is what lets that
   * function partition a mixed chain rather than applying one rule to both.
   */
  pricedPerLot?: boolean;
}

export interface CommissionResult {
  accruals: Accrual[];
  /** Absent unless the introducer's RUNG pays a rebate and it rounds above zero. */
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
  /**
   * Legs that could not be priced AT ALL — FR-IB-16 (0106).
   *
   * ## Why this is not just another `skippedReason`
   *
   * `skippedReason` says a partner is owed NOTHING and the trade is finished
   * with: a programme that does not reach depth 3, a disabled programme, a
   * rebate-only programme. The caller marks the deal done and it is done.
   *
   * This says the opposite — the partner IS owed something and the system
   * cannot work out how much, because their programme prices on a basis this
   * trade has no figure for (an account linked to no product, under a spread
   * basis). Marking that deal done discards the commission PERMANENTLY: MT5's
   * amounts are final once reported, so nothing recomputes it when somebody
   * links the product ten seconds later.
   *
   * Collapsing the two is exactly the bug this field exists to prevent, and it
   * was live: a refused leg produced an empty accrual set, which the deal queue
   * read as "nobody was owed anything" and marked processed.
   *
   * The caller must REFUSE the deal so it defers on the 0092 backoff.
   */
  unpriceable?: string[];
}

/**
 * The revenue THIS programme's rates are a percentage of.
 *
 * Three answers, and they are deliberately different things:
 *
 *  - no map          → `fallback`, the single figure the caller computed. This
 *                      is the pre-0106 behaviour and every caller that has one
 *                      revenue still gets exactly it.
 *  - map, basis in   → that basis's figure.
 *  - map, basis out  → `undefined`, meaning REFUSE this leg.
 *
 * The third case must not fall back to `fallback`, and that is the whole reason
 * this is a function rather than a lookup with `??`. A basis missing from the
 * map means the caller could not price it — an account linked to no product,
 * under a basis that needs one — and substituting a different revenue would pay
 * the partner on terms nobody agreed to, silently, at a number that looks
 * perfectly reasonable on the accrual row.
 */
/**
 * WHICH revenue a percentage at this level is a share of — FR-IB-16.
 *
 * `undefined` means UNPRICEABLE and must never fall back to the gross — a basis
 * absent from the map is one the caller could not price, and substituting a
 * different revenue pays the partner on terms nobody agreed to, at a number that
 * reads perfectly reasonably on the accrual row.
 */
function basisForLevel(
  level: LevelTerms,
  fallback: Decimal,
  revenueByBasis?: ReadonlyMap<RevenueBasis, string>,
): Decimal | undefined {
  if (!revenueByBasis) return fallback;

  const figure = revenueByBasis.get(level.revenueBasis ?? DEFAULT_REVENUE_BASIS);
  return figure === undefined ? undefined : toDecimal(figure);
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
  /**
   * The ladder, keyed by rung — 0112.
   *
   * Every level anybody in `chain` stands on. A rung with no row pays nothing
   * and says so, which is what "the broker has not configured that level yet"
   * looks like from here.
   */
  levels: Map<number, LevelTerms>,
  /**
   * The broker's revenue on this trade under EACH basis — FR-IB-16 (0106).
   *
   * Optional. When absent every earner is priced on `event.grossAmount`, which
   * is what this function did before programmes carried a basis and what every
   * caller with a single revenue figure still wants.
   *
   * When present, each earner's leg is a percentage of the figure for THEIR
   * RUNG's basis. The caller computes the map because the arithmetic needs
   * MT5 legs and a product markup, and this module is a pure seam that lint
   * keeps away from `modules/` and `store/`.
   *
   * A basis with no entry pays nothing and says so, rather than falling back to
   * the gross: a missing figure means the caller could not price that basis —
   * an unlinked product, most likely — and quietly substituting a different
   * revenue would pay a partner on terms they did not agree to.
   */
  revenueByBasis?: ReadonlyMap<RevenueBasis, string>,
): CommissionResult {
  if (chain.length === 0) return { accruals: [] };

  const gross = toDecimal(event.grossAmount);
  /*
   * Zero when the caller did not supply it, which makes a per-lot leg report
   * "this trade has no volume" rather than accruing nothing without saying why.
   */
  const lots = event.lots === undefined ? toDecimal('0') : toDecimal(event.lots);
  /*
   * A non-positive base pays nothing — TO A PERCENTAGE LEG.
   *
   * A refunded or zero deposit must not produce a negative accrual: that would
   * be a debit dressed as an earning, and clawbacks are a separate, deliberate
   * operation (a compensating ledger entry), not a side effect of this
   * function.
   *
   * ⚠️ NARROWED IN 0114, AND IT WAS A LIVE BUG. This returned early for every
   * ladder, which was right while every payout was a share of revenue and
   * became wrong the moment a rung could be priced PER LOT: $10 a lot is owed
   * on volume and is deliberately indifferent to what the broker earned, which
   * is the whole point of the model.
   *
   * On a raw-spread group — no commission, no swap, an ordinary setup — that
   * made EVERY trade pay nobody, and the caller marked each one done. Nothing
   * reported it: an empty result is also what "nobody was owed anything"
   * looks like.
   *
   * So the early return now applies only when NO rung in this chain is priced
   * per lot. When one is, the loop runs and each leg decides for itself: the
   * per-lot branch pays, and the percentage branch below still refuses a
   * non-positive base with its own reason.
   *
   * `greaterThan(0)`, NOT `!isPositive()`. decimal.js gives ZERO a sign of 1,
   * so `new Decimal(0).isPositive()` is TRUE and this guard never fired on a
   * zero base — the same quirk `transferToMain` documents.
   */
  const anyPerLotLeg = chain.some((entry) => {
    const level = levels.get(entry.level);
    return level?.commissionMode === 'per_lot' || level?.commissionMode === 'share_of_parent';
  });

  if (!gross.greaterThan(0) && !anyPerLotLeg) {
    return { accruals: [], skippedReason: 'non-positive revenue base' };
  }

  const accruals: Accrual[] = [];
  const skipped: string[] = [];
  const unpriceable: string[] = [];

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

    const level = levels.get(entry.level);

    if (!level) {
      skipped.push(
        `partner at level ${entry.level} has no configured terms — that rung is not on the ladder`,
      );
      continue;
    }
    /*
     * A DISABLED level takes no share. An operator who switches a rung off has
     * stopped it paying, and honouring it anyway would make the switch
     * decorative.
     */
    if (!level.enabled) {
      skipped.push(`level ${level.level} is disabled`);
      continue;
    }

    /*
     * ── PER-LOT PAYS FIRST, AND DOES NOT LOOK AT REVENUE AT ALL ──────────
     *
     * A per-lot term is a flat amount for each standard lot traded, priced from
     * the trade's VOLUME and deliberately indifferent to what the broker
     * earned. Over volume it is profitable; on any single trade it may
     * legitimately exceed the revenue. `checkPlausible` bounds it in its own
     * units, because the percentage ceiling cannot.
     *
     * Checked BEFORE the percentage branch, and before the base is required to
     * be positive, because that requirement is a percentage concept: a trade
     * earning the broker nothing still owes a per-lot partner their amount.
     */
    /*
     * `share_of_parent` resolves to a PER-LOT rate and is paid on the same
     * path — 30% of the rung above's $10 is $3 a lot, which is a per-lot
     * figure in every way that matters to the ledger. Sharing the branch keeps
     * one arithmetic for one kind of number.
     */
    if (level.commissionMode === 'per_lot' || level.commissionMode === 'share_of_parent') {
      const perLot = perLotRateFor(level, levels);

      if (perLot === undefined) {
        skipped.push(
          `level ${level.level} is a share of the level above, which is not configured as a ` +
            'per-lot rate',
        );
        continue;
      }

      if (!perLot.greaterThan(0)) {
        skipped.push(`level ${level.level} pays nothing per lot`);
        continue;
      }

      if (!lots.greaterThan(0)) {
        skipped.push(`level ${level.level} prices per lot, and this trade reports no volume`);
        continue;
      }

      const amount = money(perLot.times(lots));
      if (toDecimal(amount).isZero()) continue;

      accruals.push({
        ibUserId: entry.ibUserId,
        depth: entry.depth,
        levelId: level.id,
        programId: entry.programId,
        /*
         * The RESOLVED rate, not the configured percentage. A `share_of_parent`
         * row storing "30" would be unreadable later — 30 of what? — while the
         * $3 it resolved to is the number that produced the amount and the one
         * a disputed payout is settled from.
         */
        rateValue: money(perLot),
        /*
         * The VOLUME, not the revenue. `baseAmount` records what the figure was
         * computed against, and writing a revenue this amount was never derived
         * from produces a row nobody can check by arithmetic — the one property
         * a money ledger has to keep.
         */
        baseAmount: money(lots),
        amount,
        pricedPerLot: true,
      });
      continue;
    }

    const rateValue = level.commissionRate;
    const rate = toDecimal(rateValue);

    /*
     * `greaterThan(0)`, NOT `!isPositive()` — decimal.js gives ZERO a sign of 1,
     * so `isPositive()` is true for zero and the guard would never fire.
     */
    if (!rate.greaterThan(0)) {
      skipped.push(`level ${level.level} pays no commission`);
      continue;
    }

    const base = basisForLevel(level, gross, revenueByBasis);

    if (base === undefined) {
      /*
       * A SENTENCE, not a record. The only consumer joins these into a log line
       * an operator reads, and the two facts that matter — who could not be
       * priced and on which basis — belong in it rather than in a shape the
       * caller has to format.
       */
      unpriceable.push(
        `${entry.ibUserId} prices on ${level.revenueBasis ?? DEFAULT_REVENUE_BASIS}, ` +
          'which this trade carries no figure for',
      );
      continue;
    }

    if (!base.greaterThan(0)) {
      skipped.push(
        `level ${level.level} prices on ${level.revenueBasis ?? DEFAULT_REVENUE_BASIS}, ` +
          'which earned nothing on this trade',
      );
      continue;
    }

    const amount = money(base.times(rate).dividedBy(100));
    if (toDecimal(amount).isZero()) continue;

    accruals.push({
      ibUserId: entry.ibUserId,
      depth: entry.depth,
      levelId: level.id,
      programId: entry.programId,
      rateValue,
      baseAmount: money(base),
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
  const introducerLevel = introducer ? levels.get(introducer.level) : undefined;

  if (introducer && introducerLevel?.enabled && event.source !== 'deposit') {
    /*
     * ── PER-LOT FIRST, as on the commission legs ─────────────────────────
     *
     * Per-lot terms REPLACE the percentage rather than adding to it, so the
     * percentage branch is skipped entirely when this mode applies — including
     * when it produces nothing. A per-lot rebate on a trade with no volume owes
     * nothing; falling through would quietly pay a percentage nobody
     * configured.
     */
    if (introducerLevel.rebateMode === 'per_lot') {
      const perLot = toDecimal(introducerLevel.rebateAmountPerLot ?? '0');

      if (perLot.greaterThan(0) && lots.greaterThan(0)) {
        const amount = money(perLot.times(lots));
        if (!toDecimal(amount).isZero()) {
          rebate = {
            ibUserId: introducer.ibUserId,
            levelId: introducerLevel.id,
            programId: introducer.programId,
            rateValue: introducerLevel.rebateAmountPerLot ?? '0',
            // The volume it was priced against — see the commission leg.
            baseAmount: money(lots),
            amount,
            pricedPerLot: true,
          };
        }
      }
    } else {
      const rebateRate = toDecimal(introducerLevel.rebateRate);
      /*
       * The client's leg is priced on the INTRODUCER's basis, for the same
       * reason the rate comes from their level: it is a term of the one
       * relationship the client is actually in.
       */
      const rebateBase = basisForLevel(introducerLevel, gross, revenueByBasis);

      if (rebateRate.greaterThan(0) && rebateBase?.greaterThan(0)) {
        const amount = money(rebateBase.times(rebateRate).dividedBy(100));
        // Rounded first, then tested — the same order, and the same reason, as
        // the commission legs above.
        if (!toDecimal(amount).isZero()) {
          rebate = {
            ibUserId: introducer.ibUserId,
            levelId: introducerLevel.id,
            programId: introducer.programId,
            rateValue: introducerLevel.rebateRate,
            baseAmount: money(rebateBase),
            amount,
          };
        }
      }
    }
  }

  /*
   * ── THE BROKER'S CEILING IS NOT APPLIED HERE ────────────────────────────
   *
   * `ibMaxRevenueSharePct` used to sit at this point: it summed every leg and
   * scaled them all PRO RATA to fit under a configured percentage. It was
   * removed at the operator's request (0103) and the ceiling came back in 0106
   * — deliberately NOT here, and deliberately not as scaling.
   *
   * ## Why the ceiling lives in `checkPlausible` instead
   *
   * This function answers "what is each partner owed". Every answer it produces
   * is correct in isolation: each leg is that partner's own rate, from their own
   * programme, on their own basis. The ceiling is a fact about the SUM, which
   * does not exist until every leg is known — so enforcing it inside this loop
   * would decide whether a partner earns based on where they fell in an
   * iteration order. That is not a rule anybody could explain to the partner it
   * cut off.
   *
   * ## What bounds what, in one place
   *
   *  - `ib_levels_share_fits` + `IbLevelsService.assertShareFits` bound ONE
   *    RUNG's commission and rebate to 100%, at configuration time, where an
   *    operator can still fix it. It cannot see the other legs on a trade.
   *  - `checkPlausible` bounds the TRADE: first against its own revenue (the
   *    unit-error backstop), then against `ib_max_total_payout_pct`. This is the
   *    only guard that sees a whole chain at once, which is why the ceiling is
   *    there and not on the ladder.
   *
   * A chain over either bound is REFUSED, never scaled. The deal is not lost —
   * it defers on the 0092 backoff with the reason on the row and pays in full
   * once the rates are corrected. The old behaviour paid a reduced amount
   * immediately and told nobody the rate card was wrong.
   */

  return {
    accruals,
    rebate,
    unpriceable: unpriceable.length > 0 ? unpriceable : undefined,
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
  /**
   * `trading_settings.ib_max_total_payout_pct` — the most this ONE TRADE may
   * cost in total, as a percentage of its revenue (0106).
   *
   * Optional, defaulting to 100, so a caller that has no opinion still gets the
   * unit-error backstop below and nothing else. `DealCommissionService` passes
   * the configured value; the pure-seam tests pass whatever they are pinning.
   *
   * ## Why the ceiling is checked HERE and not in `calculate`
   *
   * `calculate` answers "what is each partner owed", and each answer is correct
   * in isolation — every leg is that partner's own rate applied to their own
   * programme's basis. The ceiling is a fact about the SUM, which only exists
   * once every leg is known. Putting it inside the loop would mean deciding
   * whether a partner earns based on where they happen to fall in an iteration
   * order, which is not a rule anybody could explain to them.
   */
  maxTotalPayoutPct: string = '100',
  /**
   * `trading_settings.ib_max_payout_per_lot` — the most this ONE TRADE may pay
   * out per standard lot, across every per-lot leg (0111).
   *
   * The percentage ceiling cannot bound those legs, because a per-lot payout is
   * not a share of revenue: $12 a lot against $8 of spread is the model working,
   * not a fault. But the ceiling's PURPOSE still applies — it is the unit-error
   * backstop — so per-lot terms get the same protection expressed in the units
   * they are quoted in. A "1000" typed where "10.00" was meant is refused.
   */
  maxPayoutPerLot: string = '50',
): { ok: true } | { ok: false; reason: string } {
  const gross = toDecimal(event.grossAmount);

  /*
   * ── THE TWO MODELS ARE BOUNDED SEPARATELY, AND THAT IS THE POINT ────────
   *
   * A percentage leg is a share of revenue and must fit inside it. A per-lot leg
   * is a flat amount times a volume and legitimately may not — over volume the
   * broker is ahead, and on any single trade it can be a deliberate loss.
   *
   * Summing them and applying one rule would either refuse honest per-lot terms
   * or exempt percentage ones. So the chain is partitioned and each half is
   * checked against the bound natural to it.
   *
   * ⚠️ This is deliberately NOT the `event.lots !== undefined` exemption that
   * used to sit here. That one waved the whole check through whenever a lot
   * count was present, which the deal feed always supplies — so the refusal and
   * its alarm were dead code on 100% of real accruals. The lesson was that the
   * exemption must be per LEG and by MODE, never per event.
   */
  const perLotLegs = [...accruals, ...(rebate ? [rebate] : [])].filter(
    (leg) => leg.pricedPerLot === true,
  );
  const shareLegs = [...accruals, ...(rebate ? [rebate] : [])].filter(
    (leg) => leg.pricedPerLot !== true,
  );

  const perLotTotal = perLotLegs.reduce(
    (sum, leg) => sum.plus(toDecimal(leg.amount)),
    new Decimal(0),
  );

  if (perLotLegs.length > 0) {
    const lots = event.lots === undefined ? new Decimal(0) : toDecimal(event.lots);
    const allowance = toDecimal(maxPayoutPerLot).times(lots);

    if (perLotTotal.greaterThan(allowance)) {
      return {
        ok: false,
        reason:
          `Per-lot payout ${money(perLotTotal)} on ${money(lots)} lot(s) exceeds the broker's ` +
          `ceiling of ${maxPayoutPerLot} per lot (${money(allowance)}). A per-lot amount is not ` +
          'bounded by the revenue of the trade, so this is the unit-error guard for those ' +
          'terms — ' +
          'check the amounts on the programme. Nothing has been accrued.',
      };
    }
  }

  /*
   * The revenue-based checks below see the SHARE legs only. A per-lot leg
   * counted here would make an honest chain look like it had exceeded revenue
   * whenever the broker was buying volume at a loss.
   */
  const total = shareLegs.reduce((sum, leg) => sum.plus(toDecimal(leg.amount)), new Decimal(0));

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

  /*
   * ── THE BROKER'S CEILING ─────────────────────────────────────────────────
   *
   * Checked SECOND, after the unit-error guard above, and the order matters at
   * the default: at 100 both thresholds are the same number, and the message
   * that fires should be the one that names the likely cause. "A share cannot
   * exceed the thing it is a share of" sends an operator to the rate; "over
   * your configured ceiling" sends them to the settings form. A rate typed as
   * 7000 is the first problem, not the second.
   *
   * ## This REFUSES; it does not scale
   *
   * `ibMaxRevenueSharePct` (0103) scaled every leg pro rata to fit under the
   * ceiling and paid immediately. That is the friendlier failure and the less
   * honest one: a partner received less than their programme promised, on every
   * trade, and nothing anywhere said so — not the accrual row, which recorded
   * the scaled amount as though it were the rate's own output, and not the
   * operator, who saw commissions being paid.
   *
   * Refusing costs a delay instead. `CommissionRefusedError` defers the deal on
   * the 0092 backoff with this reason on the row, the queue alarm fires once
   * the refusals stack up, and the deal pays IN FULL the moment somebody fixes
   * the rates. Nothing is lost and nobody is quietly short-changed.
   */
  const ceiling = toDecimal(maxTotalPayoutPct);
  const allowed = gross.times(ceiling).dividedBy(100);

  if (total.greaterThan(allowed)) {
    return {
      ok: false,
      reason:
        `Total payout ${money(total)} is over the broker's ceiling of ${maxTotalPayoutPct}% ` +
        `(${money(allowed)} of ${money(gross)}). The partners in this chain hold programmes ` +
        'that together cost more than one trade is allowed to. Nothing has been accrued — ' +
        'correct the programmes or raise the ceiling and it will pay in full.',
    };
  }

  return { ok: true };
}
