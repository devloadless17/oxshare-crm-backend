import { sql, type SQL } from 'drizzle-orm';

/**
 * WHAT A MOVEMENT IS, for accounting — the one classification every screen, total and export reads.
 *
 * The money union speaks in `kind` + a wallet-side `direction`, which is right for a wallet and
 * wrong for a book-keeper: a wallet → MT5 transfer is a "withdrawal" of the wallet and never leaves
 * the platform, and the desk's own credit is a "deposit" that no client paid. So the Financial tabs
 * and tiles counted internal moves as money in and out (16 Oct 2026). Every movement is now one of:
 *
 *   type                  effect     rule
 *   deposit               in         a payment into the wallet through a client's method
 *   desk_credit           in         the desk's own credit — NEW money, no client paid it
 *   withdrawal            out        a payment out of the wallet to a client's destination
 *   desk_debit            out        the desk's own debit
 *   transfer_to_account   internal   wallet → trading account
 *   transfer_to_wallet    internal   trading account → wallet
 *   commission_to_wallet  internal   a partner's commission wallet → their main wallet
 *
 * The desk's own credits and debits are told apart by their ROUTE — Manual's `adjustment` channel,
 * which no client method is ever bound to (0168) — and the stored totals key every payment by route
 * (0221), so every figure here is answerable from them.
 */
export const MOVEMENT_TYPES = [
  'deposit',
  'desk_credit',
  'withdrawal',
  'desk_debit',
  'transfer_to_account',
  'transfer_to_wallet',
  'commission_to_wallet',
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

export type MovementEffect = 'in' | 'out' | 'internal';

/** The tabs a money list offers: each a fixed set of types. */
export const MOVEMENT_GROUPS = {
  deposit: ['deposit', 'desk_credit'],
  withdrawal: ['withdrawal', 'desk_debit'],
  transfer: ['transfer_to_account', 'transfer_to_wallet', 'commission_to_wallet'],
} as const satisfies Record<string, readonly MovementType[]>;
export type MovementGroup = keyof typeof MOVEMENT_GROUPS;

/** The route of the desk's own credits and debits (`creditDeposit` / `debitAdjustment`). */
export const DESK_ROUTE = { provider: 'manual', channel: 'adjustment' } as const;
const DESK_ROUTE_KEY = `${DESK_ROUTE.provider}:${DESK_ROUTE.channel}`;

export function effectOf(type: MovementType): MovementEffect {
  switch (type) {
    case 'deposit':
    case 'desk_credit':
      return 'in';
    case 'withdrawal':
    case 'desk_debit':
      return 'out';
    default:
      return 'internal';
  }
}

/** The classification of one row, from the union's own columns. */
export function movementTypeOf(row: {
  kind: string;
  direction: string;
  routeProvider: string | null;
  routeChannel: string | null;
}): MovementType {
  if (row.kind === 'commission_transfer') return 'commission_to_wallet';
  if (row.kind === 'transfer') {
    // Wallet-side: a transfer that LEFT the wallet went to the account.
    return row.direction === 'withdrawal' ? 'transfer_to_account' : 'transfer_to_wallet';
  }
  const desk = row.routeProvider === DESK_ROUTE.provider && row.routeChannel === DESK_ROUTE.channel;
  if (row.direction === 'deposit') return desk ? 'desk_credit' : 'deposit';
  return desk ? 'desk_debit' : 'withdrawal';
}

/** Where each type lives in the union's columns (or the totals' keys). */
interface TypeColumns {
  kind: SQL;
  direction: SQL;
  /** True on the desk's own route. */
  isDesk: SQL;
}

/** One type as a predicate over `columns`. */
function typePredicate(type: MovementType, c: TypeColumns): SQL {
  switch (type) {
    case 'deposit':
      return sql`(${c.kind} = 'payment' AND ${c.direction} = 'deposit' AND NOT ${c.isDesk})`;
    case 'desk_credit':
      return sql`(${c.kind} = 'payment' AND ${c.direction} = 'deposit' AND ${c.isDesk})`;
    case 'withdrawal':
      return sql`(${c.kind} = 'payment' AND ${c.direction} = 'withdrawal' AND NOT ${c.isDesk})`;
    case 'desk_debit':
      return sql`(${c.kind} = 'payment' AND ${c.direction} = 'withdrawal' AND ${c.isDesk})`;
    case 'transfer_to_account':
      return sql`(${c.kind} = 'transfer' AND ${c.direction} = 'withdrawal')`;
    case 'transfer_to_wallet':
      return sql`(${c.kind} = 'transfer' AND ${c.direction} = 'deposit')`;
    case 'commission_to_wallet':
      return sql`(${c.kind} = 'commission_transfer')`;
  }
}

/** Any of `types`, over the money union's output (`combined.*`). */
export function unionTypesPredicate(types: readonly MovementType[]): SQL {
  return anyOf(types, {
    kind: sql`combined.kind`,
    direction: sql`combined.direction`,
    isDesk: sql`(combined.route_provider IS NOT DISTINCT FROM ${DESK_ROUTE.provider}
                 AND combined.route_channel IS NOT DISTINCT FROM ${DESK_ROUTE.channel})`,
  });
}

/** Any of `types`, over the stored totals (kind, direction, route). */
export function totalsTypesPredicate(types: readonly MovementType[]): SQL {
  return anyOf(types, {
    kind: sql`kind`,
    direction: sql`direction`,
    isDesk: sql`(route = ${DESK_ROUTE_KEY})`,
  });
}

/** The type of a totals row, as SQL — for grouping the stored totals by accounting line. */
export function totalsTypeCase(): SQL {
  return sql`CASE
      WHEN kind = 'commission_transfer' THEN 'commission_to_wallet'
      WHEN kind = 'transfer' AND direction = 'withdrawal' THEN 'transfer_to_account'
      WHEN kind = 'transfer' THEN 'transfer_to_wallet'
      WHEN direction = 'deposit' AND route = ${DESK_ROUTE_KEY} THEN 'desk_credit'
      WHEN direction = 'deposit' THEN 'deposit'
      WHEN route = ${DESK_ROUTE_KEY} THEN 'desk_debit'
      ELSE 'withdrawal' END`;
}

/** The same CASE over the union's output — for the live (uncounted) path. */
export function unionTypeCase(): SQL {
  return sql`CASE
      WHEN kind = 'commission_transfer' THEN 'commission_to_wallet'
      WHEN kind = 'transfer' AND direction = 'withdrawal' THEN 'transfer_to_account'
      WHEN kind = 'transfer' THEN 'transfer_to_wallet'
      WHEN direction = 'deposit' AND route_provider = ${DESK_ROUTE.provider}
           AND route_channel = ${DESK_ROUTE.channel} THEN 'desk_credit'
      WHEN direction = 'deposit' THEN 'deposit'
      WHEN route_provider = ${DESK_ROUTE.provider}
           AND route_channel = ${DESK_ROUTE.channel} THEN 'desk_debit'
      ELSE 'withdrawal' END`;
}

function anyOf(types: readonly MovementType[], columns: TypeColumns): SQL {
  if (types.length === 0) return sql`FALSE`;
  return sql`(${sql.join(
    types.map((type) => typePredicate(type, columns)),
    sql` OR `,
  )})`;
}

/**
 * Where a state stands for accounting: money that MOVED, money still moving, and money that did not.
 * A withdrawal `approved` but not yet paid is still moving.
 */
export type SettlementBucket = 'settled' | 'inProgress' | 'notCompleted';

export function bucketCase(state: SQL): SQL {
  return sql`CASE ${state}
      WHEN 'success' THEN 'settled'
      WHEN 'pending' THEN 'inProgress'
      WHEN 'approved' THEN 'inProgress'
      ELSE 'notCompleted' END`;
}
