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
 * ## What a trade pays (0140, re-split 0197)
 *
 *     sub-partner (level 2+)  earns  pool × (their override ?? their level's share) / 100
 *     level 1 partner         earns  pool × (100 − the shares paid beneath them) / 100
 *     the trading client      gets   lots × type.rebatePerLot
 *                                      × (introducer's rebate override ?? their level's) / 100
 *
 * where pool = lots × type.commissionPerLot. So a level 1 partner takes the
 * WHOLE commission on their own clients, and on a sub-partner's clients takes
 * what the sub-partner does not: 70/30 by default, 50/50 for a sub-partner set
 * to 50% (the owner, 6 Oct 2026). Level 1's own share on the ladder decides
 * nothing any more.
 *
 * `type` is the COMMISSION TYPE the traded product is sold on — the product's
 * rate card, money per standard lot — and a level is a PERCENTAGE of it. The
 * absolute figures used to sit on the level itself (0117), which meant one
 * ladder could describe only one product; they moved to the product so one
 * ladder prices the whole catalogue.
 *
 * ## Level 1 takes the rest (0197 — replaces 0114's independent shares)
 *
 * Until 0197 each rung took its own share in full and nothing was carved out
 * of anybody. Now the commission is ONE pool split down the chain: each
 * sub-partner takes their share, and the level 1 partner at the top takes what
 * is left of 100%. A suspended sub-partner breaks the chain (see
 * `resolveChain`), so nothing reaches the level 1 partner through them.
 *
 * ## The chain walk is unchanged
 *
 * `resolveChain` still climbs `parent_ib_user_id` upward from the client's
 * introducer, so a sub-partner never appears in their parent's own clients'
 * chains and a parent always appears in the chain for clients beneath them.
 * Each earner is paid the share of THEIR OWN rung (0112), wherever in the chain
 * the trade happened.
 *
 * ## What is gone, and must not come back by accident
 *
 * Percent-of-broker-revenue pricing, `share_of_parent`, the revenue basis and
 * the spread markup. A share of MT5's charged commission was ZERO on a
 * raw-spread group and paid nobody silently (0117); a share of the rung above
 * was a number nobody could read off a card. Both are replaced by a share of a
 * figure that is written on the product and checkable by looking at it.
 */

/**
 * A CYCLE GUARD, and deliberately not a payout policy.
 *
 * Postgres cannot prevent a cycle in `parent_ib_user_id` — a self-referencing
 * foreign key only checks that the target exists — and this is the money path,
 * so the walk needs a stop even when every rung is well formed. `seen` below
 * already terminates a true cycle; this bounds the other shape, a chain so deep
 * that walking it costs more than any ladder could pay on. It matches
 * `ib_levels_level_range` and `ib_accruals_depth_range`, so a configurable
 * depth can never exceed what the database will store.
 */
export const MAX_CHAIN_DEPTH = 10;

/** One partner in the chain above an earning event. */
export interface ChainNode {
  userId: number;
  parentIbUserId: number | null;
  /** A suspended partner keeps their tree and stops earning. */
  active: boolean;
  /**
   * The partner's RUNG, and what decides their share — 0112.
   *
   * A property of the partner rather than of any trade: it is written when they
   * are appointed, from their parent's level, and only changes if somebody
   * re-parents them.
   */
  level: number;
  /** HISTORICAL — the programme they used to be paid on. Decides nothing now. */
  programId?: string;
  /** 0197 — this partner's own commission share, overriding their level's. */
  commissionShareOverride?: string | null;
  /** 0197 — what this partner's clients get back of the rebate, overriding their level's. */
  rebateShareOverride?: string | null;
}

/** A resolved earner: who, and at what depth above the client. */
export interface ChainEntry {
  ibUserId: number;
  /**
   * How many hops above the trading client this partner stands.
   *
   * 1 is the introducer, 2 is their parent, and so on. It is a property of THIS
   * TRADE, not of the partner: the same partner is at depth 1 on their own
   * client's trade and at depth 2 on a sub-partner's. It is recorded on the
   * accrual so the row stays explainable after the tree is reshaped.
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
   * The earner's own RUNG in the partner tree — what decides their share.
   *
   * Distinct from `depth`, and the distinction is the whole model. `depth` is a
   * property of THIS TRADE; `level` is a property of the PARTNER. A level 1
   * partner is paid their level 1 share on their own client's trade and on a
   * sub-partner's alike, because their rung did not move.
   */
  level: number;
  /** 0197 — see `ChainNode`. */
  commissionShareOverride?: string | null;
  rebateShareOverride?: string | null;
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
 *    where earnings stop: `calculate` pays each entry from its own rung, and an
 *    entry whose rung is not on the ladder is skipped with a reason.
 *
 * `lookup` injects the data so this stays pure. A CYCLE — which Postgres cannot
 * prevent on a self-referencing key — terminates the walk rather than hanging
 * it: `seen` is the only thing between a mis-assigned parent and an infinite
 * loop on the money path.
 */
export function resolveChain(
  introducerId: number | null | undefined,
  lookup: (userId: number) => ChainNode | undefined,
): ChainEntry[] {
  if (!introducerId) return [];

  const chain: ChainEntry[] = [];
  const seen = new Set<number>();

  let currentId: number | null = introducerId ?? null;
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
      // Only when set, so an entry for a partner on their level's terms is unchanged.
      ...(node.commissionShareOverride !== undefined && node.commissionShareOverride !== null
        ? { commissionShareOverride: node.commissionShareOverride }
        : {}),
      ...(node.rebateShareOverride !== undefined && node.rebateShareOverride !== null
        ? { rebateShareOverride: node.rebateShareOverride }
        : {}),
    });
    currentId = node.parentIbUserId;
  }

  return chain;
}

/**
 * The product's rate card — one `ib_commission_types` row, as `calculate`
 * reads it.
 *
 * Both amounts are money per STANDARD LOT, as decimal strings (§6.1). They are
 * separate pools: the commission is what the partners' side of a trade is
 * worth, the rebate is what the trading client is promised, and neither is a
 * slice of the other.
 */
export interface CommissionTypeTerms {
  /** The `ib_commission_types` row id, recorded on every accrual it prices. */
  id: string;
  /** For the refusal and skip messages an operator reads. */
  name: string;
  /**
   * A disabled type pays nobody.
   *
   * Same rule as a disabled level: an operator who switches a rate card off
   * has stopped it paying, and honouring it anyway makes the switch decorative.
   */
  enabled: boolean;
  commissionPerLot: string;
  rebatePerLot: string;
}

/** What generated the earning a commission is a share of. */
export interface RevenueEvent {
  currency: string;
  /**
   * Where the event came from.
   *
   * ## `'deposit'` is not a revenue event, and must not become one again
   *
   * It was, and it was wrong in a way that cost the broker money on every
   * client: a deposit is not revenue. The money still belongs to the client and
   * is recorded as a liability against it, so paying a partner a share of a
   * $1,000 deposit hands them the BROKER's money while the client keeps the
   * right to withdraw all $1,000.
   *
   * The value survives for CPA — a FIXED amount per qualified client, which is
   * a real model — and for nothing else. `calculate` refuses it outright.
   */
  source: 'deposit' | 'deal';
  /**
   * The trade's volume in standard lots — what EVERY term is priced against.
   *
   * The CLOSING deal's own volume, never the sum of a position's legs: a round
   * turn's legs each carry the same lot count, so summing them would pay one
   * trade's volume twice.
   *
   * Absent or zero on anything that is not a trade, and then nothing pays AND
   * SAYS SO — reported in `skippedReason` rather than treated as a zero that
   * pays silently.
   */
  lots?: string;
  /**
   * The rate card of the product the trade was made on — 0140.
   *
   * Three states, and the difference between the last two is the whole reason
   * this is not a plain optional:
   *
   *  - a card      → priced from it.
   *  - `null`      → the product carries NO commission type. A configured
   *                  state: it pays no partner commission, and `calculate` says
   *                  so in `skippedReason`. The caller marks the trade done.
   *  - `undefined` → the caller could not resolve a product at all — the
   *                  account is linked to none. UNPRICEABLE: the money may be
   *                  owed and what is missing is a link somebody can restore in
   *                  ten seconds, so this is reported in `unpriceable` and the
   *                  caller must REFUSE the trade so it retries, never mark it
   *                  done having paid nobody.
   */
  terms?: CommissionTypeTerms | null;
}

/**
 * One rung of the commission ladder — what decides money.
 *
 * ## One commission share and one rebate share, both percentages of the TYPE
 *
 * A level is a property of the PARTNER: their rung in the tree. A level 1
 * partner takes their level 1 share on everything that reaches them, however
 * deep. The share is of the product's commission type, so a rung is one
 * percentage that prices every product — never an absolute amount.
 */
export interface LevelTerms {
  /** The `ib_levels` row id, recorded on every accrual it prices. */
  id: string;
  /** The rung this card pays. */
  level: number;
  /** A disabled level takes no share. */
  enabled: boolean;
  /** The PARTNER's percentage of `commissionPerLot`. A decimal string. */
  commissionShare: string;
  /** The CLIENT's percentage of `rebatePerLot`, read from the introducer's rung. */
  rebateShare: string;
}

export interface Accrual {
  ibUserId: number;
  depth: number;
  /** Which LEVEL's share paid this — 0112. */
  levelId?: string;
  /**
   * HISTORICAL — the programme that priced rows written before 0112.
   *
   * A row carries at most one of this and `levelId`. Kept so the accrual row
   * keeps the guarantee this type has always made: that the arithmetic behind
   * a credited amount is reproducible from the row alone.
   */
  programId?: string;
  /** Which COMMISSION TYPE's amount the share was taken of — 0140. */
  commissionTypeId?: string;
  /** The share applied, as a percentage — so the arithmetic is reproducible from the row. */
  rateValue: string;
  /**
   * The POOL this leg is a share of: `lots × commissionPerLot`, as money.
   *
   * On the row rather than derived, because both the type's amount and the
   * lot count can change or be disputed later — and `amount` must always equal
   * `baseAmount × rateValue / 100`, which is the one property a money ledger
   * has to keep.
   */
  baseAmount: string;
  /** A fixed-scale decimal string, never a number. */
  amount: string;
}

/**
 * The client's leg — money returning to the person who traded.
 *
 * `ibUserId` is the partner whose RUNG produced it, not who receives it. The
 * beneficiary is the trading client, and there is only ever one of them per
 * event, which is why this is a single value rather than a list.
 *
 * It comes from the INTRODUCER's rung — the depth-1 partner — because that is
 * the relationship the client is actually in. A partner further up the chain
 * setting the rebate would be altering terms in a relationship they do not own.
 */
export interface RebateLeg {
  ibUserId: number;
  levelId?: string;
  programId?: string;
  commissionTypeId?: string;
  /** The introducer's rebate share, as a percentage. */
  rateValue: string;
  /** The pool: `lots × rebatePerLot`, as money. */
  baseAmount: string;
  amount: string;
}

export interface CommissionResult {
  accruals: Accrual[];
  /** Absent unless the introducer's rung pays a rebate and it rounds above zero. */
  rebate?: RebateLeg;
  /**
   * Why nothing (or less than everything) was accrued, when the chain was
   * non-empty.
   *
   * Present so a caller can LOG the refusal rather than recording a silent
   * zero — "level 3 is not on the ladder" is a configuration problem somebody
   * must fix, and an empty result with no explanation is indistinguishable
   * from "nobody was owed anything".
   */
  skippedReason?: string;
  /**
   * The trade could not be priced AT ALL, and the caller must REFUSE it.
   *
   * ## Why this is not just another `skippedReason`
   *
   * `skippedReason` says a partner is owed NOTHING and the trade is finished
   * with: a product with no type, a disabled card, a rung not on the ladder.
   * The caller marks the deal done and it is done.
   *
   * This says the opposite — something MAY be owed and the system cannot work
   * out how much, because the account is linked to no product and nothing says
   * what the trade pays. Marking that deal done discards the commission
   * PERMANENTLY: MT5's amounts are final once reported, so nothing recomputes
   * it when somebody links the product ten seconds later.
   *
   * The caller must refuse the deal so it defers on the 0092 backoff.
   */
  unpriceable?: string[];
}

/**
 * Split an earning event across the resolved chain.
 *
 * Each earner is paid THEIR OWN rung's share of the product's commission type,
 * and the introducer's rung decides the client's rebate. Every step is
 * decimal.js. Nothing here touches a JS number — `Number()` and `parseFloat`
 * are lint errors in this module.
 */
export function calculate(
  event: RevenueEvent,
  chain: ChainEntry[],
  /**
   * The ladder, keyed by rung — every level anybody in `chain` stands on. A
   * rung with no row pays nothing and says so, which is what "the broker has
   * not configured that level yet" looks like from here.
   */
  levels: Map<number, LevelTerms>,
): CommissionResult {
  if (chain.length === 0) return { accruals: [] };

  /*
   * ── A SHARE OF A DEPOSIT IS NOT A COMMISSION ──────────────────────────
   *
   * This branch exists because it was live: a client depositing 1000 paid
   * their partner 700 — of the broker's own money, since the deposit is a
   * LIABILITY. A broker who wants to pay for a funded client wants CPA, which
   * is a different model with a different column, not this one.
   */
  if (event.source === 'deposit') {
    return {
      accruals: [],
      skippedReason:
        'commission cannot be taken of a deposit — the money is the client’s, not the ' +
        'broker’s revenue. Commission is earned on closed trades.',
    };
  }

  /*
   * ── NO PRODUCT IS A REFUSAL; NO TYPE IS A CONFIGURED ZERO ─────────────
   *
   * See `RevenueEvent.terms` for why the two must not look the same.
   */
  if (event.terms === undefined) {
    return {
      accruals: [],
      unpriceable: [
        'the trading account is linked to no product, so nothing says what this trade pays ' +
          'partners — link the account to a product that carries a commission type',
      ],
    };
  }
  if (event.terms === null) {
    return {
      accruals: [],
      skippedReason: 'the product carries no commission type, so it pays no partner commission',
    };
  }

  const terms = event.terms;
  if (!terms.enabled) {
    return { accruals: [], skippedReason: `commission type '${terms.name}' is disabled` };
  }

  /*
   * Zero when the caller did not supply it, which makes the trade report "no
   * volume" rather than accruing nothing without saying why. Every term is
   * priced per lot, so there is nothing else to price from.
   */
  const lots = event.lots === undefined ? toDecimal('0') : toDecimal(event.lots);
  if (!lots.greaterThan(0)) {
    return {
      accruals: [],
      skippedReason: 'this trade reports no volume, and every term is per lot',
    };
  }

  /*
   * The two POOLS this trade puts on the table, as money. `greaterThan(0)`,
   * NOT `isPositive()`: decimal.js gives ZERO a sign of 1, so `isPositive()`
   * is true for zero and a guard written that way never fires.
   */
  const commissionPool = lots.times(toDecimal(terms.commissionPerLot));
  const rebatePool = lots.times(toDecimal(terms.rebatePerLot));

  const accruals: Accrual[] = [];
  const skipped: string[] = [];

  /*
   * Deepest first (0197): every sub-partner's share has to be known before the
   * level 1 partner's remainder can be. The chain is introducer-first, so this
   * is the chain's own order; the result is put back in that order below.
   */
  let paidBelow = toDecimal('0');

  for (const entry of chain) {
    const level = levels.get(entry.level);

    if (!level) {
      skipped.push(
        `partner at level ${entry.level} has no configured terms — that rung is not on the ladder`,
      );
      continue;
    }
    if (!level.enabled) {
      skipped.push(`level ${level.level} is disabled`);
      continue;
    }
    if (!commissionPool.greaterThan(0)) {
      skipped.push(`commission type '${terms.name}' pays no commission per lot`);
      continue;
    }

    /*
     * A sub-partner takes their own override, else their level's share. The
     * level 1 partner takes whatever the sub-partners beneath them did not —
     * 100% on their own clients. Never below zero: only a malformed tree
     * deeper than two levels could pay out more than 100% beneath them.
     */
    const share =
      entry.level <= 1
        ? Decimal.max(toDecimal('100').minus(paidBelow), 0)
        : toDecimal(entry.commissionShareOverride ?? level.commissionShare);
    if (!share.greaterThan(0)) {
      skipped.push(
        entry.level <= 1
          ? 'the sub-partners beneath this level 1 partner take the whole commission'
          : `the partner at level ${level.level} takes no share of the commission`,
      );
      continue;
    }
    paidBelow = paidBelow.plus(share);

    /*
     * Rounded FIRST, then tested: a share that rounds to nothing at eight
     * places is skipped rather than written as an empty accrual, and the
     * ledger's `amount > 0` CHECK agrees.
     */
    const amount = money(commissionPool.times(share).dividedBy(100));
    if (toDecimal(amount).isZero()) continue;

    accruals.push({
      ibUserId: entry.ibUserId,
      depth: entry.depth,
      levelId: level.id,
      programId: entry.programId,
      commissionTypeId: terms.id,
      rateValue: share.toFixed(4),
      baseAmount: money(commissionPool),
      amount,
    });
  }

  /*
   * ── THE CLIENT'S LEG ─────────────────────────────────────────────────────
   *
   * Read from the INTRODUCER's rung — see `RebateLeg` for why it is that
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

  if (introducer && introducerLevel?.enabled) {
    // 0197 — a sub-partner may have their own rebate for their clients.
    const rebateShare = introducer.rebateShareOverride ?? introducerLevel.rebateShare;
    const share = toDecimal(rebateShare);

    if (share.greaterThan(0) && rebatePool.greaterThan(0)) {
      const amount = money(rebatePool.times(share).dividedBy(100));
      if (!toDecimal(amount).isZero()) {
        rebate = {
          ibUserId: introducer.ibUserId,
          levelId: introducerLevel.id,
          programId: introducer.programId,
          commissionTypeId: terms.id,
          rateValue: share.toFixed(4),
          baseAmount: money(rebatePool),
          amount,
        };
      }
    }
  }

  /*
   * ── THE BROKER'S CEILING IS NOT APPLIED HERE ────────────────────────────
   *
   * This function answers "what is each partner owed", and every answer is
   * correct in isolation. The ceiling is a fact about the SUM, which does not
   * exist until every leg is known — so it lives in `checkPlausible`, which
   * REFUSES an over-payment rather than scaling it. Enforcing it inside this
   * loop would decide whether a partner earns based on where they fell in an
   * iteration order, which is not a rule anybody could explain to them.
   */

  return {
    accruals,
    rebate,
    skippedReason: skipped.length > 0 ? skipped.join('; ') : undefined,
  };
}

/**
 * Is this set of legs arithmetically plausible?
 *
 * The backstop against a unit error — a "1000" typed on the commission type
 * where "10.00" was meant — reaching a wallet. Every leg is priced per lot, so
 * the bound is expressed per lot: the total paid across every leg on ONE trade
 * may not exceed `ib_max_payout_per_lot` × the lots traded.
 *
 * ## Why the ceiling is HERE and not in `calculate`
 *
 * `calculate` answers "what is each partner owed", and each answer is correct
 * in isolation. The ceiling is a fact about the SUM, which only exists once
 * every leg is known. Checked here, the whole chain is refused together and
 * the deal defers on the 0092 backoff with the reason on the row — it pays IN
 * FULL once the rates are corrected. Nothing is scaled, and nobody is quietly
 * short-changed.
 *
 * The client's rebate is counted with the rest: it leaves the broker by the
 * same door, and a unit error on `rebatePerLot` is exactly as expensive as one
 * on `commissionPerLot`.
 *
 * Returns the reason rather than throwing, so the caller decides whether that
 * is a refusal or an alert.
 */
export function checkPlausible(
  event: RevenueEvent,
  accruals: readonly Accrual[],
  rebate?: RebateLeg,
  /**
   * `trading_settings.ib_max_payout_per_lot` — the most ONE TRADE may pay out
   * per standard lot, across every leg. Defaults to 50, which is far above
   * any real rate card: a unit-error guard, not a commercial limit.
   */
  maxPayoutPerLot: string = '50',
): { ok: true } | { ok: false; reason: string } {
  const legs = [...accruals, ...(rebate ? [rebate] : [])];
  if (legs.length === 0) return { ok: true };

  const lots = event.lots === undefined ? new Decimal(0) : toDecimal(event.lots);
  const total = legs.reduce((sum, leg) => sum.plus(toDecimal(leg.amount)), new Decimal(0));
  const allowance = toDecimal(maxPayoutPerLot).times(lots);

  if (total.greaterThan(allowance)) {
    return {
      ok: false,
      reason:
        `Total payout ${money(total)} on ${money(lots)} lot(s) exceeds the broker's ceiling of ` +
        `${maxPayoutPerLot} per lot (${money(allowance)}). This is the unit-error guard — check ` +
        'the amounts on the commission type and the shares on the levels. Nothing has been ' +
        'accrued.',
    };
  }

  return { ok: true };
}
