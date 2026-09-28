import type { Executor } from '../../database/db';

/**
 * WHAT THE IDENTITY CORE NEEDS TO KNOW ABOUT A CLIENT'S REVIEW — and nothing more.
 *
 * The core (the profile writer, the identity record) decides whether a detail
 * may change by where the client's verification stands: nothing a reviewer is
 * checking may move under them. That state belongs to the verification PROCESS
 * — the manual KYC review today, perhaps an external tool later — so the core
 * asks through this port instead of reading the KYC tables itself. The same
 * shape as `COMMISSION_ACCRUAL`: the core names what it needs; the process
 * provides it (`modules/compliance/kyc-identity-review.ts`).
 *
 * It is what lets lint forbid the core from importing the KYC layer, and so
 * what keeps "replace KYC with another tool" a real option.
 */
export interface IdentityReviewState {
  /** Where the review stands — the KYC status; absent when there is none. */
  status?: string;
  /** What the reviewer returned and the client has not yet answered. */
  returnedItems: string[];
}

export interface IdentityReviewPort {
  /**
   * Lock the client's review for this transaction and say where it stands.
   * Taken FIRST — before the client's own row — which is the order approval
   * takes them in, so no two writers can deadlock by taking them the other way.
   */
  lockForChange(userId: string, executor: Executor): Promise<IdentityReviewState | undefined>;

  /** A change answered some returned items: keep only these. */
  keepReturned(userId: string, remaining: string[], executor: Executor): Promise<void>;

  /** Where the review stands, read without a lock — only to CHOOSE a refusal. */
  statusOf(userId: string): Promise<string | undefined>;
}

export const IDENTITY_REVIEW = Symbol('IDENTITY_REVIEW');
