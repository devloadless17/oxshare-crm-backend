import type { Executor } from '../../database/db';

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
  /** `kind` decides which principal table `id` points at — users or admins. */
  recipient: { kind: 'client' | 'admin'; id: string };
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
   * Fan one event out to every ACTIVE admin currently holding
   * `permissionKey`, resolved live (RolesStore), and — when `subjectClientId`
   * is given — FILTERED by client scope at write time, so a scoped admin never
   * receives a row about a client outside their territory (the 404-not-403
   * discipline, applied where the row is born).
   *
   * Always post-commit and NEVER THROWS: resolving recipients is several
   * reads, and holding a money transaction open across a permission sweep is
   * not worth a best-effort bell row — the polled work-queue badges remain the
   * durable signal. `event.dedupeKey` still applies per recipient (the unique
   * index is scoped to the recipient), so a retried caller cannot double-ring.
   */
  notifyAdminsWithPermission(
    permissionKey: string,
    event: Omit<NotificationInput, 'recipient'>,
    options?: { subjectClientId?: string },
  ): Promise<void>;
}

/**
 * Injection token. A `Symbol` rather than the interface name for the reasons
 * `wallet-provisioning.port.ts` records: interfaces erase at compile time, and
 * string tokens collide silently.
 */
export const NOTIFICATION_DISPATCH = Symbol('NOTIFICATION_DISPATCH');
