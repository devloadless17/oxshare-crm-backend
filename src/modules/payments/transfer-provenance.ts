import { ValidationError } from '../../common/errors/domain-errors';
import type { transferOriginEnum } from '../../database/schema';

/** The table's origins — `commission` belongs to the money union's commission arm only. */
export type TransferOrigin = (typeof transferOriginEnum.enumValues)[number];

/**
 * WHERE a transfer's money came from, stated by the code that moves it (0226).
 *
 * A required, discriminated argument of `TransfersService.request`, so a caller that forgets to
 * say where its money came from is a compile error rather than a row that reads "client". The
 * database holds the same rules a second time (CHECKs, and a trigger that refuses a source that is
 * not this client's settled deposit of the same amount), because a type only binds the callers it
 * can see.
 */
export type TransferProvenance =
  /** The client moved it (portal or API). */
  | { origin: 'client' }
  /** A deposit the client sent straight to the account: that deposit. */
  | { origin: 'deposit'; sourceTransactionId: string }
  /** The desk added NEW money: its manual credit, who, and why. */
  | {
      origin: 'desk_credit';
      sourceTransactionId: string;
      adminId: string;
      reason: string;
      reasonAr?: string | null;
    }
  /** The desk moved the client's wallet money on (desk_wallet) or off (desk_debit) the account. */
  | {
      origin: 'desk_wallet' | 'desk_debit';
      adminId: string;
      reason: string;
      reasonAr?: string | null;
    };

/** The direction each origin may take — the database's `transfers_origin_direction_ck`. */
export function assertProvenanceFits(
  direction: 'wallet_to_account' | 'account_to_wallet',
  provenance: TransferProvenance,
): void {
  const wanted =
    provenance.origin === 'client'
      ? direction
      : provenance.origin === 'desk_debit'
        ? 'account_to_wallet'
        : 'wallet_to_account';
  if (direction !== wanted) {
    // A programming error, not a client mistake — but refused before anything is held.
    throw new ValidationError(
      `A ${provenance.origin} transfer moves money ${wanted.replace(/_/g, ' ')}, not ${direction.replace(/_/g, ' ')}.`,
    );
  }
}

/** The row's provenance columns. */
export function provenanceColumns(provenance: TransferProvenance) {
  switch (provenance.origin) {
    case 'client':
      return {
        origin: 'client' as const,
        sourceTransactionId: null,
        requestedByAdminId: null,
        deskReason: null,
        deskReasonAr: null,
      };
    case 'deposit':
      return {
        origin: 'deposit' as const,
        sourceTransactionId: provenance.sourceTransactionId,
        requestedByAdminId: null,
        deskReason: null,
        deskReasonAr: null,
      };
    case 'desk_credit':
      return {
        origin: 'desk_credit' as const,
        sourceTransactionId: provenance.sourceTransactionId,
        requestedByAdminId: provenance.adminId,
        deskReason: provenance.reason,
        deskReasonAr: provenance.reasonAr ?? null,
      };
    default:
      return {
        origin: provenance.origin,
        sourceTransactionId: null,
        requestedByAdminId: provenance.adminId,
        deskReason: provenance.reason,
        deskReasonAr: provenance.reasonAr ?? null,
      };
  }
}

/**
 * The idempotency reference a deposit's onward transfer is keyed on, so a retried chain converges on
 * the transfer it already made instead of holding the money again.
 */
export const depositChainRef = (transactionId: string) => `deposit:${transactionId}`;
