/**
 * A trading account's mirrored balance moved (migration 0204, 7 Oct 2026).
 *
 * Raised by a trigger on `trading_accounts`, so every writer of the mirror —
 * the bridge's sweep and change feed, `recordFromOperation`, a settled
 * transfer — announces itself without knowing this exists. The gateway
 * delivers it into the OWNER's room; the portal re-reads its accounts through
 * the authenticated endpoint. The payload names who and which account, never
 * the money.
 */
export const ACCOUNT_BALANCE_CHANNEL = 'account_balance';

/** What the portal hears. */
export const ACCOUNT_BALANCE_EVENT = 'account.balance';

export interface AccountBalanceEvent {
  userId: number;
  accountId: string;
}
