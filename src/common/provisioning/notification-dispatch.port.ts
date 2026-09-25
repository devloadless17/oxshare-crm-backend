import type { Executor } from '../../database/db';
import type { AdminNotificationKind } from '../notifications/admin-notification-catalogue';

/**
 * "Something happened — put a row in the recipient's bell."
 *
 * ## Why a port rather than an import
 *
 * Exactly the reasoning `wallet-provisioning.port.ts` and
 * `commission-accrual.port.ts` record: the callers are domain modules
 * (payments, compliance, ib, admin) and the implementation lives in
 * `NotificationsModule`. Importing that module from five others invites the
 * cycle those two files describe, and providing the service from the @Global
 * `StoreModule` fails the layering lint rule — correctly. So the callers
 * depend on this DECLARATION in `common/`, and `NotificationsModule` binds the
 * implementation. An event bus would also have worked, and has been rejected
 * twice in writing as a larger change than the problem.
 *
 * This seam is also the future queue boundary: when BullMQ lands (ARCH §9),
 * the implementation behind the token enqueues instead of writing inline and
 * no call site moves. The committed row is already the outbox.
 */
export interface NotificationInput {
  /**
   * A CLIENT — the one audience this method writes for. An admin row is a task
   * that must name its subject, so it can only be written by `notifyAdmins`
   * (and `notifications_admin_subject_ck` refuses one written any other way).
   */
  recipient: { kind: 'client'; id: string };
  /**
   * Catalogue slug, e.g. 'withdrawal.approved'. The frontends own the copy and
   * the deep link; the backend never encodes either.
   */
  kind: string;
  /** Rendered client-side. Money values MUST be strings (§6.1). */
  params: Record<string, string | number | boolean | null>;
  /**
   * Absorbed by `notifications_recipient_dedupe_uq`, so an at-least-once
   * caller (a replayed provider callback, the hourly commission loop) creates
   * one row rather than two. Omit on paths a conditional state transition
   * already protects.
   */
  dedupeKey?: string;
}

/**
 * A task for the admins who can act on it. See `notifyAdmins`.
 */
export interface AdminTaskInput {
  /** A catalogue kind — see `common/notifications/admin-notification-catalogue.ts`. */
  kind: AdminNotificationKind;
  /** Rendered client-side. Identifiers, amounts (STRINGS, §6.1), codes — never a name. */
  params: Record<string, string | number | boolean | null>;
  /** `'<kind>:<uuid>'`. Absorbed per recipient by `notifications_recipient_dedupe_uq`. */
  dedupeKey?: string;
  /**
   * The item and its client. The item's KIND comes from the catalogue, so a
   * call site cannot mislabel it; a KYC task's `id` is the client's id,
   * because `kyc_submissions` is keyed on it.
   */
  subject: { id: string; clientId: string };
}

export interface NotificationDispatchPort {
  /**
   * One row for one recipient.
   *
   * ## The contract splits on `executor`, deliberately
   *
   * WITH an executor, the insert joins the CALLER'S transaction and commits or
   * rolls back with the domain change — the `audit.recordWithin` stance. The
   * target table has no foreign keys and the insert absorbs conflicts, so the
   * remaining failure modes are infrastructure failure (which fails the
   * transaction anyway) and DATA-SHAPED errors: `kind` is varchar(100) and
   * `dedupeKey` varchar(255), and an over-length value raises from inside the
   * caller's transaction. Keep both short literals — `'<event>:<uuid>'` shapes
   * — never unbounded user input.
   *
   * WITHOUT one, this is a post-commit courtesy and NEVER THROWS — log and
   * swallow, mirroring `EmailService.send`. By the time it runs the state
   * change is committed; a missed bell row is recoverable UX, a rolled-back
   * settled deposit is not.
   *
   * Idempotent via `dedupeKey` in both modes.
   */
  notify(input: NotificationInput, executor?: Executor): Promise<void>;

  /**
   * Put a TASK in the bell of every admin who could act on it.
   *
   * WHO is decided by the catalogue, not by the caller: the kind names the
   * permissions (any one qualifies), and the SUBJECT names the client, whose
   * scope every recipient must cover. There is no way to fan an admin row out
   * without a client — a row that cannot be scope-checked at read time cannot
   * be shown, and `notifications_admin_subject_ck` refuses to store one.
   *
   * Always post-commit and NEVER THROWS: resolving recipients is several reads,
   * and holding a money transaction open across a permission sweep is not worth
   * a bell row — the polled work-queue badges remain the durable signal. The
   * insert re-checks, under a share lock on the item, that the task is still
   * open, so an item handled before this ran never rings anyone. `dedupeKey`
   * applies per recipient, so a retried caller cannot double-ring.
   */
  notifyAdmins(task: AdminTaskInput): Promise<void>;
}

/**
 * Injection token. A `Symbol` rather than the interface name for the reasons
 * `wallet-provisioning.port.ts` records: interfaces erase at compile time, and
 * string tokens collide silently.
 */
export const NOTIFICATION_DISPATCH = Symbol('NOTIFICATION_DISPATCH');
