import type { transfers } from '../../database/schema';
import { systemSentenceArabic } from '../../common/i18n/reason-arabic';

type TransferRow = typeof transfers.$inferSelect;

/**
 * A wallet ⇄ trading-account transfer as it crosses the wire — exactly the
 * fields `TransferDto` declares, and nothing else.
 *
 * The row also carries the resume scheduler's bookkeeping — `resume_attempts`,
 * `resume_after`, `resume_last_error` — which is the system talking to itself
 * about retrying a stuck MT5 leg. The client's transfer response shipped all
 * three (a raw bridge error string included) until the response projection's
 * census (28 Sep 2026) reported it.
 *
 * Picked BY NAME, like `transactionView`: a column added later reaches no
 * response until it is declared.
 */
export type TransferView = Pick<
  TransferRow,
  | 'id'
  | 'userId'
  | 'walletId'
  | 'tradingAccountId'
  | 'direction'
  | 'amount'
  | 'currency'
  | 'state'
  | 'failureReason'
  | 'failureReasonAr'
  | 'settledAt'
  | 'createdAt'
>;

export function transferView(row: TransferRow): TransferView {
  return {
    id: row.id,
    userId: row.userId,
    walletId: row.walletId,
    tradingAccountId: row.tradingAccountId,
    direction: row.direction,
    amount: row.amount,
    currency: row.currency,
    state: row.state,
    failureReason: row.failureReason,
    // Written with it (0179); a row failed before then gets the catalogue's Arabic.
    failureReasonAr: row.failureReasonAr ?? systemSentenceArabic(row.failureReason),
    settledAt: row.settledAt,
    createdAt: row.createdAt,
  };
}
