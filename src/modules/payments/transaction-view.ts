import type { transactions } from '../../database/schema';

type TransactionRow = typeof transactions.$inferSelect;

/**
 * A payment transaction as it crosses the wire — exactly the fields
 * `TransactionDto` declares, and nothing else.
 *
 * NARROWER THAN THE ROW ON PURPOSE. The row also carries the desk's payout
 * state — `rival_withdrawal_id`, `rival_submitted_at`, `rival_needs_attention`,
 * `rival_attention_reason` — plus the rail key and a transfer destination,
 * which are the operator's business. The client portal's history and its
 * withdrawal response shipped every one of them to the client until the
 * response projection's census (28 Sep 2026) reported it.
 *
 * Every field is picked BY NAME, so a column added to `transactions` later
 * reaches no response until somebody declares it on the DTO and adds it here.
 */
export type TransactionView = Pick<
  TransactionRow,
  | 'id'
  | 'userId'
  | 'walletId'
  | 'direction'
  | 'amount'
  | 'currency'
  | 'state'
  | 'provider'
  | 'methodKey'
  | 'providerRef'
  | 'rivalExternalId'
  | 'destination'
  | 'proofFilename'
  | 'rejectionReason'
  | 'reviewedBy'
  | 'reviewedAt'
  | 'settledAt'
  | 'createdAt'
>;

export function transactionView(row: TransactionRow): TransactionView {
  return {
    id: row.id,
    userId: row.userId,
    walletId: row.walletId,
    direction: row.direction,
    amount: row.amount,
    currency: row.currency,
    state: row.state,
    provider: row.provider,
    methodKey: row.methodKey,
    providerRef: row.providerRef,
    rivalExternalId: row.rivalExternalId,
    destination: row.destination,
    proofFilename: row.proofFilename,
    rejectionReason: row.rejectionReason,
    reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt,
    settledAt: row.settledAt,
    createdAt: row.createdAt,
  };
}
