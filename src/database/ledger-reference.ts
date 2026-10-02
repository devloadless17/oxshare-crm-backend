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
  /**
   * A partner moving earnings out of their COMMISSION wallet into their MAIN
   * one — a row in `ib_wallet_transfers`.
   *
   * Its own value rather than reusing `transfer`, and the reason is the
   * uniqueness index rather than tidiness. Both legs of this movement post
   * against the SAME reference id, and `transfers` ids come from a different
   * table — two id spaces sharing one reference_type is a collision waiting for
   * the day two uuids match, at which point one of the two movements silently
   * posts nothing and returns the other's ledger entry as its own.
   *
   * It also keeps the reports honest: `transfer` means wallet ⇄ trading
   * account, and counting a commission payout as one would overstate how much
   * money moved to the trading server.
   */
  ibTransfer: 'ib_transfer',
  /**
   * A CLOSED POSITION — the event a partner is actually paid on.
   *
   * Commission used to key off `transaction`, because it accrued on deposits.
   * That was the bug: a deposit is not revenue, so the broker was paying a
   * share of the client's own money. Earnings now key off the trade that
   * produced them, which is also what makes an accrual traceable to the
   * position an auditor is asking about.
   */
  position: 'position',
  /**
   * A ROW IN `mt5_deals` — the event the live MT5 feed actually pays on.
   *
   * ## Why this exists beside `position` rather than replacing it
   *
   * `position` is the right key for a trade the CRM itself owns end to end, and
   * `CommissionService.accrueForClosedPosition` keys on it (it has no production
   * caller since 0182). But MT5 does not deliver positions;
   * it delivers DEALS, and rebuilding one from the other is a trap the ingest
   * path must not walk into:
   *
   *   - The broker charges commission on the OPENING deal as well as the
   *     closing one. Accruing only on the close silently underpays every
   *     partner by the entry half of every round turn.
   *   - The sweep re-reads a 24-hour window, so a position opened last week and
   *     closed today arrives as a closing deal whose opening deal the CRM never
   *     saw. Pairing would drop it, and a dropped pair is an unpaid partner —
   *     the exact outcome the push-and-sweep design exists to prevent.
   *   - A partial close is several closing deals against one position, and a
   *     key that is the position pays the first of them and discards the rest.
   *
   * Keying on the deal has none of those failure modes, because a deal is what
   * the broker's server considers atomic and it carries its own revenue.
   *
   * ## The two must never both be live for one trade
   *
   * They are separate id spaces over the same underlying event, so a system
   * running both would pay twice for one round turn. `positions` is written by
   * nothing today; if a feed ever fills it, the deal path is what has to go.
   */
  deal: 'deal',
  /**
   * The compensating entry that takes a CONFIRMED accrual back.
   *
   * A separate reference type from `accrual`, keyed on the same accrual id, and
   * both halves of that are load-bearing.
   *
   * SEPARATE, because `ledger_entries_wallet_reference_uq` is over (wallet,
   * referenceType, referenceId). Reusing `accrual` would make the reversal look
   * like a replay of the credit it undoes, and ON CONFLICT would drop it in
   * silence — the desk would see a successful reversal and the partner would
   * keep the money.
   *
   * The SAME id, because that is exactly the idempotency this needs: one
   * accrual can be reversed once. A double-clicked reversal is absorbed by the
   * constraint rather than debiting a partner twice, which is the failure that
   * would turn a clawback into theft.
   */
  accrualReversal: 'accrual_reversal',
  /**
   * ONE RUN'S WORTH of accruals, credited to one wallet as a single entry.
   *
   * ## The problem this solves
   *
   * Commission is confirmed every minute now. Keyed per accrual, that wrote one
   * ledger row per closed trade per earner — 252 rows across four wallets in a
   * day of testing, and a client's wallet history became an unreadable column of
   * two-dollar credits. At any real volume it is thousands a day, and the one
   * screen a client uses to account for their own balance is the screen it
   * ruins.
   *
   * A payout run now posts ONE entry per (wallet, kind), summing what that run
   * matured.
   *
   * ## The id is the BATCH's, not any accrual's
   *
   * `ib_accrual_batches.id`. It cannot be an accrual id — the entry no longer
   * belongs to one accrual — and it must not be a synthesised key like
   * "wallet+minute", because `ledger_entries_wallet_reference_uq` is what makes
   * the credit idempotent and a key that is merely PROBABLY unique is a key that
   * one day drops a real payout in silence.
   *
   * ## ⚠️ `accrual` DOES NOT GO AWAY
   *
   * Every entry already written carries it, on rows that credited real wallets,
   * and `ledger_entries` is append-only — those cannot be rewritten and must
   * stay resolvable. A reversal of a pre-batch accrual still keys off
   * `accrualReversal` + the accrual id, exactly as before.
   */
  accrualBatch: 'accrual_batch',
} as const;

export type LedgerReferenceType = (typeof LEDGER_REFERENCE)[keyof typeof LEDGER_REFERENCE];
