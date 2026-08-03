import Decimal from 'decimal.js';
import { money, toDecimal } from '../wallet/money';

// ═══ The commission engine's pure core ═══════════════════════════════════════
//
// Two functions, no database, no HTTP, no framework — data in, data out.
// docs/CLAUDE.md names these as the seams that make change cheap:
//
//   1. resolveChain — the ONLY place that knows the hierarchy is two deep.
//   2. calculate    — the ONLY place that knows how money is computed.
//
// If the hierarchy ever grows past L2, or the rate maths changes, exactly one
// of these files changes and nothing else moves.

export interface IbNode {
  userId: string;
  parentIbUserId: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'suspended';
  programId: string | null;
}

export interface ChainEntry {
  ibUserId: string;
  level: 1 | 2;
}

export const MAX_LEVEL = 2;

/**
 * Resolve the earning chain above a client's referring IB.
 *
 * §8.6, exactly:
 *   - L1 not found or not approved  → nobody earns (empty chain)
 *   - L1 approved, no parent        → L1 only
 *   - parent approved               → L1 + L2
 *   - anything above L2             → earns nothing, ever
 *
 * `lookup` injects the data so this stays pure and unit-testable. It walks
 * `parentIbUserId` at most twice; the caller iterates whatever comes back
 * without knowing how deep the hierarchy is.
 */
export function resolveChain(
  l1UserId: string | null | undefined,
  lookup: (userId: string) => IbNode | undefined,
): ChainEntry[] {
  if (!l1UserId) return [];

  const chain: ChainEntry[] = [];
  const seen = new Set<string>();

  let currentId: string | null = l1UserId;
  for (let level = 1; level <= MAX_LEVEL && currentId; level++) {
    // Cycle guard (§8.6): a mis-assigned parent must never make an IB earn
    // twice from one deal, or loop forever.
    if (seen.has(currentId)) break;
    seen.add(currentId);

    const node: IbNode | undefined = lookup(currentId);
    // An unapproved IB breaks the chain: at L1 nobody earns, at L2 only L1 does.
    if (!node || node.status !== 'approved') break;

    chain.push({ ibUserId: node.userId, level: level as 1 | 2 });
    currentId = node.parentIbUserId;
  }

  return chain;
}

/**
 * Would assigning `parentUserId` to `ibUserId` create a cycle?
 *
 * §8.6 only asks that "walking two levels up must not return to the starting
 * IB", and that is all the money path strictly needs — resolveChain caps at
 * L2 and de-duplicates, so a deeper loop cannot double-pay anyone. This walks
 * the FULL ancestry anyway: a cycle at any depth is nonsense data that would
 * confuse every human who later reads the hierarchy, and refusing it at write
 * time costs one cheap loop. Resolution stays two-deep; only validation is
 * thorough.
 */
export function wouldCreateCycle(
  ibUserId: string,
  parentUserId: string,
  lookup: (userId: string) => IbNode | undefined,
): boolean {
  if (ibUserId === parentUserId) return true;

  const seen = new Set<string>();
  let cursor: string | null = parentUserId;
  while (cursor) {
    if (cursor === ibUserId) return true;
    if (seen.has(cursor)) return false; // pre-existing loop, not one we'd add
    seen.add(cursor);
    cursor = lookup(cursor)?.parentIbUserId ?? null;
  }
  return false;
}

export interface DealInput {
  /** Spread as delivered by the bridge. Strings — never floats (§6.1). */
  spread: string;
  volume: string;
}

export interface ProgramInput {
  mode: 'commission' | 'rebate' | 'hybrid';
  method: 'spread_share' | 'per_lot' | 'fixed_per_deal';
  commissionValue: string;
  rebateValue: string;
  l1Share: string;
  l2Share: string;
}

export interface Accrual {
  ibUserId: string;
  level: 1 | 2;
  amount: string;
}

export interface CommissionResult {
  /** The pool before splitting — what the program earned on this deal. */
  base: string;
  accruals: Accrual[];
  /** Client rebate, when the program's mode includes one. */
  rebate: string;
}

/**
 * Compute the commission pool for one deal, then split it across the chain.
 *
 * The `method` is declared by the program rather than assumed from the data
 * (D-11/D-39), so the engine never has to guess what MT5's spread field means:
 *
 *   spread_share    pool = spread × volume × rate%   (revenue share)
 *   per_lot         pool = value  × volume
 *   fixed_per_deal  pool = value
 *
 * ASSUMPTION worth confirming (D-39): spread_share multiplies by volume,
 * because broker revenue scales with volume — a 1-lot and a 100-lot deal at
 * the same spread cannot pay the same commission. §8.6 words it as
 * "deal.spread × program rate" without mentioning volume; the tests below
 * state the formula explicitly so the assumption is visible, not buried.
 *
 * Every step is decimal.js. Nothing here touches a JS number.
 */
export function calculate(
  deal: DealInput,
  program: ProgramInput,
  chain: ChainEntry[],
): CommissionResult {
  const spread = toDecimal(deal.spread);
  const volume = toDecimal(deal.volume);
  const commissionValue = toDecimal(program.commissionValue);
  const rebateValue = toDecimal(program.rebateValue);

  const poolFor = (value: Decimal): Decimal => {
    switch (program.method) {
      case 'spread_share':
        return spread.times(volume).times(value).dividedBy(100);
      case 'per_lot':
        return value.times(volume);
      case 'fixed_per_deal':
        return value;
    }
  };

  // A rebate-only program pays IBs nothing; a commission-only program pays no
  // rebate. The program's own validation keeps the unused value at zero.
  const base = program.mode === 'rebate' ? new Decimal(0) : poolFor(commissionValue);
  const rebate = program.mode === 'commission' ? new Decimal(0) : poolFor(rebateValue);

  const shareFor = (level: 1 | 2) =>
    toDecimal(level === 1 ? program.l1Share : program.l2Share);

  const accruals: Accrual[] = [];
  for (const entry of chain) {
    const amount = base.times(shareFor(entry.level)).dividedBy(100);
    // Skip zero legs: a ledger entry must move a non-zero amount, and an
    // accrual of nothing is noise in the money history.
    if (amount.isZero()) continue;
    accruals.push({ ibUserId: entry.ibUserId, level: entry.level, amount: money(amount) });
  }

  return { base: money(base), accruals, rebate: money(rebate) };
}

/** closed_at + the program's settlement window (§8.6 confirm job). */
export function availableAt(closedAt: Date, settlementWindowHours: number): Date {
  return new Date(closedAt.getTime() + settlementWindowHours * 60 * 60 * 1000);
}
