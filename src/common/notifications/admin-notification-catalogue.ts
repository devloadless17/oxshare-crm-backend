import type { NotificationSubjectKind } from '../../database/schema';
import { normalizePermissionKey } from '../security/actor';

/**
 * WHAT MAY RING AN ADMIN'S BELL — the one list.
 *
 * ## An admin notification is a task
 *
 * The owner's rule, from the broker who is buying the platform: a notification
 * means "you must handle something". A deposit waiting for approval, a
 * withdrawal request, a KYC awaiting review, an IB application — and the money
 * exceptions only a person can clear. Nothing that merely informs: an
 * auto-credited deposit, a completed payout, a registration or an opened
 * account is not work, and a bell that rings for them stops being read.
 * Before adding a kind here, name what the recipient must DO. If the answer is
 * "nothing", it is not a notification.
 *
 * ## Why one list, shared by write and read
 *
 * Every consumer derives from this object rather than restating it:
 *  - the fan-out takes the PERMISSION from here, so a call site cannot pair a
 *    kind with the wrong key (the withdrawal fan-out once rang
 *    `withdrawals.approve` holders while approving needs `withdrawals.settle`);
 *  - the feed shows a kind only to an admin who holds one of its permissions
 *    NOW — revoke the key and the rows leave the bell on the next read;
 *  - the response DTO's enum is built from it, so the admin app's generated
 *    types force it to render every kind;
 *  - `stillOpen` is the condition the fan-out re-checks, under a lock, before
 *    it writes — a task that was handled first never lands.
 *
 * Resolution (the task leaving everyone's inbox once handled) is NOT decided
 * here: the item tables' triggers do it (migration 0140), because code that
 * has to remember is code that forgets.
 */

export const ADMIN_NOTIFICATION_CATEGORIES = [
  'deposits',
  'withdrawals',
  'kyc',
  'ib',
  'transfers',
] as const;
export type AdminNotificationCategory = (typeof ADMIN_NOTIFICATION_CATEGORIES)[number];

/**
 * The state of the subject's own row under which the task is still waiting.
 * Interpreted per subject table by `NotificationsStore` — see `stillOpenFor`.
 */
export type TaskStillOpen = 'pending' | 'needs-attention' | 'awaiting-review' | 'not-reversed';

interface AdminNotificationSpec {
  readonly category: AdminNotificationCategory;
  readonly subjectKind: NotificationSubjectKind;
  /** Holding ANY one of these makes the admin somebody who could act on it. */
  readonly permissions: readonly string[];
  readonly stillOpen: TaskStillOpen;
  /**
   * A task whose item may rightly be LEFT as it is declares the decision that
   * says so, and this is the outcome recorded when somebody takes it. Since 0189
   * a task leaves the Inbox only when handled, so a kind with a legitimate
   * "no action" answer and no way to give it would sit there for ever.
   * Taken through `POST /admin/notifications/:id/close`, with a reason, audited.
   */
  readonly closeOutcome?: string;
}

export const ADMIN_NOTIFICATION_KINDS = {
  /** A manual (offline) deposit was declared and waits for a decision. */
  'admin.deposit.submitted': {
    category: 'deposits',
    subjectKind: 'transaction',
    permissions: ['deposits.approve', 'deposits.reject'],
    stillOpen: 'pending',
  },
  /**
   * A deposit only a person can settle: the amount received differs, settled
   * funds were reversed, or money arrived after the row had failed. Params
   * carry a reason CODE, never the provider's free text.
   */
  'admin.deposit.attention': {
    category: 'deposits',
    subjectKind: 'transaction',
    permissions: ['deposits.approve'],
    stillOpen: 'needs-attention',
  },
  /**
   * A client asked for their money. Approving PAYS, which needs
   * `withdrawals.settle`; rejecting needs `withdrawals.approve` — either one
   * can end this task.
   */
  'admin.withdrawal.requested': {
    category: 'withdrawals',
    subjectKind: 'transaction',
    permissions: ['withdrawals.settle', 'withdrawals.approve'],
    stillOpen: 'pending',
  },
  /**
   * A provider refused an approved payout, or was proven never to have
   * received it: resend it or cancel it (0173, every provider). Params carry
   * the provider's NAME for the sentence.
   */
  'withdrawal.payout_submit_failed': {
    category: 'withdrawals',
    subjectKind: 'transaction',
    permissions: ['withdrawals.approve'],
    stillOpen: 'needs-attention',
  },
  /**
   * A provider and the CRM disagree about whether a payout's money moved
   * (0173, every provider) — `withdrawals.settle`'s judgement, as below.
   */
  'withdrawal.payout_attention': {
    category: 'withdrawals',
    subjectKind: 'transaction',
    permissions: ['withdrawals.settle'],
    stillOpen: 'needs-attention',
  },
  'admin.kyc.submitted': {
    category: 'kyc',
    subjectKind: 'kyc',
    permissions: ['kyc.review'],
    stillOpen: 'awaiting-review',
  },
  /**
   * Distinct from a first submission: a review already done once, where only
   * the corrected fields need checking, and a client who has been refused once
   * and is waiting.
   */
  'admin.kyc.resubmitted': {
    category: 'kyc',
    subjectKind: 'kyc',
    permissions: ['kyc.review'],
    stillOpen: 'awaiting-review',
  },
  'admin.partner.applied': {
    category: 'ib',
    subjectKind: 'ib_application',
    permissions: ['ib.approve', 'ib.reject'],
    stillOpen: 'pending',
  },
  /**
   * A dealer cancelled a trade that had already paid an introducer. One task
   * per standing accrual, done when THAT accrual is reversed — or when the desk
   * decides the partner KEEPS it (a goodwill call, a trade re-opened), which is
   * as much a decision as a reversal and ends the task the same way.
   */
  'admin.commission.clawback': {
    category: 'ib',
    subjectKind: 'ib_accrual',
    permissions: ['ib.commissions.reverse'],
    stillOpen: 'not-reversed',
    closeOutcome: 'kept',
  },
  /** A wallet ⇄ trading-account transfer pending past the stale threshold. */
  'admin.transfer.stuck': {
    category: 'transfers',
    subjectKind: 'transfer',
    permissions: ['transfers.abandon'],
    stillOpen: 'pending',
  },
} as const satisfies Record<string, AdminNotificationSpec>;

export type AdminNotificationKind = keyof typeof ADMIN_NOTIFICATION_KINDS;

export const ADMIN_NOTIFICATION_KIND_LIST = Object.freeze(
  Object.keys(ADMIN_NOTIFICATION_KINDS) as AdminNotificationKind[],
);

/**
 * The deposit anomalies `admin.deposit.attention` names. A code, so each
 * frontend owns the sentence and the provider's wording never reaches a bell.
 */
export const DEPOSIT_ATTENTION_REASONS = [
  'amount_mismatch',
  'reversed',
  'paid_after_failure',
  /** The provider reports a different asset or network than the link's (0173). */
  'wrong_asset',
  /** Credited — the money arrived — but above the method's maximum: a compliance look (0173). */
  'over_limit',
  /** Money arrived on a link the provider has not confirmed (0173). */
  'unconfirmed_funds',
] as const;
export type DepositAttentionReason = (typeof DEPOSIT_ATTENTION_REASONS)[number];

export function adminNotificationSpec(kind: AdminNotificationKind): AdminNotificationSpec {
  return ADMIN_NOTIFICATION_KINDS[kind];
}

/**
 * `Object.hasOwn`, not `in`: a slug of 'constructor' or 'toString' must not
 * read as a catalogue entry through the prototype.
 */
export function isAdminNotificationKind(kind: string): kind is AdminNotificationKind {
  return Object.hasOwn(ADMIN_NOTIFICATION_KINDS, kind);
}

/** The kinds this set of permissions can act on — what the feed may show. */
export function kindsVisibleTo(permissions: readonly string[]): AdminNotificationKind[] {
  const held = new Set(permissions.map(normalizePermissionKey));
  return ADMIN_NOTIFICATION_KIND_LIST.filter((kind) =>
    ADMIN_NOTIFICATION_KINDS[kind].permissions.some((key) => held.has(normalizePermissionKey(key))),
  );
}

export function kindsIn(category: AdminNotificationCategory): AdminNotificationKind[] {
  return ADMIN_NOTIFICATION_KIND_LIST.filter(
    (kind) => ADMIN_NOTIFICATION_KINDS[kind].category === category,
  );
}

/** The decision that ends this kind's task without the item moving, if it has one. */
export function closeOutcomeOf(kind: string): string | undefined {
  if (!isAdminNotificationKind(kind)) return undefined;
  const spec: AdminNotificationSpec = ADMIN_NOTIFICATION_KINDS[kind];
  return spec.closeOutcome;
}

export function categoryOf(kind: AdminNotificationKind): AdminNotificationCategory {
  return ADMIN_NOTIFICATION_KINDS[kind].category;
}
