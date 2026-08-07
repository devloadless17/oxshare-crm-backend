/**
 * What a ledger entry says CAUSED it — `ledger_entries.reference_type`.
 *
 * These are not decoration. `UNIQUE(wallet_id, reference_type, reference_id)` is
 * the §6.3 idempotency constraint for replayed causes, and the reconciliation
 * job (§12.2) finds an uncredited accrual by looking for the absence of a row
 * with the matching type. So the value is load-bearing in two directions at
 * once: it decides what counts as a duplicate, and it decides what counts as
 * missing.
 *
 * They live here, as one constant, because they were string literals typed out
 * at each site and two of those sites disagreed. `commission.service.ts` wrote
 * `'accrual'`; the reconciliation query looked for `'commission_accrual'`. The
 * column is a free `varchar(50)`, so nothing rejected either spelling and the
 * mismatch was invisible until someone compared the two by hand.
 *
 * The consequence was worse than a missed check. From the first confirmed
 * accrual onwards the hourly job would report EVERY accrual as uncredited and
 * answer `balanced: false` forever — and an alert that fires every hour on a
 * healthy system gets muted, taking the wallet half of the same job with it.
 * A control nobody believes is worse than no control, because it occupies the
 * place where a real one would go.
 */
export const LEDGER_REFERENCE = {
  /** A commission accrual credited to an IB's wallet on confirmation. */
  accrual: 'accrual',
  /** A deposit, withdrawal or refund — anything in `transactions`. */
  transaction: 'transaction',
  /**
   * A move between a wallet and a trading account — anything in `transfers`.
   *
   * ADDED to this constant rather than left as a literal, which is what it was:
   * `transfers.service.ts` wrote `referenceType: 'transfer'` inline at two call
   * sites while this file's own docblock described exactly that mistake costing
   * a permanently-broken reconciliation check. One of the two spellings would
   * eventually have drifted.
   */
  transfer: 'transfer',
} as const;

export type LedgerReferenceType = (typeof LEDGER_REFERENCE)[keyof typeof LEDGER_REFERENCE];
