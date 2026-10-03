import type { transactions } from '../../../database/schema';
import type { Db } from '../../../database/db';
import type { Actor } from '../../../common/security/actor';
import type { DepositAttentionReason } from '../../../common/notifications/admin-notification-catalogue';

/**
 * What the payments CORE needs from the transaction books, and nothing more.
 *
 * The core (payout engine, hosted deposits) decides for every provider; the
 * books — requesting, settling and failing a row, the outcome mail, the bell —
 * belong to the outer payments module. The core depends on THIS interface and
 * the module binds it to `TransactionsService`, so the dependency points
 * inward and lint can forbid `core/` from importing the outer services.
 */

type TransactionRow = typeof transactions.$inferSelect;
/** The db or a transaction handle — the same shape as `WalletService`'s. */
type Executor = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Work the CALLER needs performed inside a money method's transaction.
 *
 * R-6.5: the admin audit row for a money movement must commit with the movement
 * or not at all — otherwise the withdrawal settles, the record of who authorised
 * it is lost, and D-21's whole justification (this is the one record that cannot
 * be reconstructed afterwards) stops holding for the actions that need it most.
 *
 * The handle is handed OUT rather than the audit service being imported in:
 * `AdminAuditService` lives in the `admin` module and payments must not reach
 * into it (ARCHITECTURE §4). The service running the money method keeps owning
 * the transaction boundary, which is where §6.2 says it belongs.
 */
export type WithinTransaction = (tx: Executor, row: TransactionRow) => Promise<void>;

export const TRANSACTION_LEDGER = Symbol('TRANSACTION_LEDGER');

export interface TransactionLedgerPort {
  getById(id: string): Promise<TransactionRow>;
  /** Provider confirmed a payout: close the withdrawal (§8.7 conditional). */
  settle(
    id: string,
    adminId: string,
    providerRef: string,
    withinTx?: WithinTransaction,
  ): Promise<TransactionRow>;
  /** The payout failed: refund with a compensating entry and close it. */
  markFailed(
    id: string,
    reason: string,
    actor: Actor,
    withinTx?: WithinTransaction,
    providerNote?: string | null,
  ): Promise<TransactionRow>;
  findDepositByReference(
    method: string | undefined,
    reference: string,
    ownerId: number | undefined,
  ): Promise<TransactionRow | undefined>;
  sendDepositOutcomeEmail(
    userId: number,
    outcome: 'succeeded' | 'failed' | 'rejected',
    amount: string,
    currency: string,
    reason?: string,
  ): Promise<void>;
  announceDepositAttention(
    tx: { id: string; userId: number; amount: string; currency: string },
    reason: DepositAttentionReason,
  ): void;
  chainTransferToAccount(tx: TransactionRow): Promise<void>;
  payerRedirectUrl(
    method: string,
    reference: string,
    outcome: 'success' | 'failure',
  ): string | undefined;
  providerCallbackUrl(providerCode: string): string | undefined;
}

export const DEPOSIT_LIMITS = Symbol('DEPOSIT_LIMITS');

/** The configured ceiling of a deposit method, after currency ranges apply. */
export interface DepositLimitsPort {
  effectiveMaximum(methodKey: string): Promise<string | null>;
}
