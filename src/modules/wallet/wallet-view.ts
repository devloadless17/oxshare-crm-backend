import type { wallets } from '../../database/schema';
import { available, money } from './money';

type WalletRow = typeof wallets.$inferSelect;

/** Exactly the fields `WalletDto` declares. Money as strings (§6.1). */
export type WalletView = Pick<
  WalletRow,
  'id' | 'walletNumber' | 'userId' | 'name' | 'currency' | 'kind' | 'createdAt'
> & { balance: string; onHold: string; available: string };

/**
 * A wallet as it crosses the wire — the declared shape, from a stored row or
 * from an already-formatted list item alike (`money` is idempotent, and
 * `available` is always recomputed from the two figures it is made of rather
 * than trusted from the input).
 *
 * The list spread the whole row (`...w`), so `updated_at` went to the client
 * with it; harmless in itself, and exactly how a column that is not harmless
 * would leave next. Picked BY NAME, so it cannot.
 */
export function walletView(
  row: Pick<
    WalletRow,
    | 'id'
    | 'walletNumber'
    | 'userId'
    | 'name'
    | 'currency'
    | 'kind'
    | 'balance'
    | 'onHold'
    | 'createdAt'
  >,
): WalletView {
  return {
    id: row.id,
    walletNumber: row.walletNumber,
    userId: row.userId,
    name: row.name,
    currency: row.currency,
    kind: row.kind,
    balance: money(row.balance),
    onHold: money(row.onHold),
    available: available(row.balance, row.onHold),
    createdAt: row.createdAt,
  };
}
