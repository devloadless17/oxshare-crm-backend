import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ClientNotFoundError, NotFoundError } from '../../common/errors/domain-errors';
import type { Executor } from '../../database/db';
import type { NotificationSubjectKind } from '../../database/schema';
import type {
  AdminTaskInput,
  NotificationDispatchPort,
  NotificationInput,
} from '../../common/provisioning/notification-dispatch.port';
import {
  ADMIN_NOTIFICATION_CATEGORIES,
  adminNotificationSpec,
  categoryOf,
  isAdminNotificationKind,
  kindsIn,
  kindsVisibleTo,
  type AdminNotificationCategory,
  type AdminNotificationKind,
} from '../../common/notifications/admin-notification-catalogue';
import { normalizePermissionKey } from '../../common/security/actor';
import { ClientVisibilityService } from '../../common/security/client-visibility.service';
import type { ClientScope } from '../../common/security/client-scope';
import { AdminClientScopesStore } from '../../store/admin-client-scopes.store';
import { AdminsStore } from '../../store/admins.store';
import {
  NotificationsStore,
  type AdminFeedReader,
  type AdminNotificationRow,
  type AppNotification,
  type NotificationRecipient,
} from '../../store/notifications.store';
import { RolesStore } from '../../store/roles.store';
import type { CursorPage, CursorPosition } from '../../common/pagination';
import { JobLeaseService } from '../../common/scheduling/job-lease.service';

/**
 * How long a bell row lives, per audience. The audit log and the ledger are
 * the records; these are how long each reader can scroll back. A client's
 * outcomes are done once seen. An admin's History is where a desk goes back
 * through its work, so it keeps a year — the owner's choice.
 */
const RETENTION_DAYS: Record<NotificationRecipient['kind'], number> = {
  client: 90,
  admin: 365,
};

/** The admin a feed is read by — the parts of the session that decide visibility. */
export interface AdminFeedPrincipal {
  id: string;
  permissions: readonly string[];
  clientScope: ClientScope;
}

/** A feed row, with its catalogue kind and category settled. */
export type AdminFeedItem = Omit<AdminNotificationRow, 'kind'> & {
  kind: AdminNotificationKind;
  category: AdminNotificationCategory;
};

export interface AdminFeedQuery {
  view: 'inbox' | 'history';
  status?: 'open' | 'handled';
  category?: AdminNotificationCategory;
  q?: string;
  cursor?: CursorPosition;
  limit?: number;
}

/**
 * The implementation behind `NOTIFICATION_DISPATCH`, plus the read API the two
 * notifications controllers serve.
 *
 * Writes arrive through the port from domain services; reads and the markers
 * arrive through controllers with the reader taken from the session — never a
 * parameter. See the port file for the in-tx / post-commit contract split.
 */
@Injectable()
export class NotificationsService implements NotificationDispatchPort {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly store: NotificationsStore,
    private readonly admins: AdminsStore,
    private readonly roles: RolesStore,
    private readonly scopes: AdminClientScopesStore,
    private readonly visibility: ClientVisibilityService,
    private readonly leases: JobLeaseService,
  ) {}

  async notify(input: NotificationInput, executor?: Executor): Promise<void> {
    if (executor) {
      // In the caller's transaction: a failure here IS an infrastructure
      // failure and must fail the caller — same stance as audit.recordWithin.
      await this.store.insert(input, executor);
      return;
    }
    try {
      await this.store.insert(input);
    } catch (error) {
      // Post-commit courtesy: the domain change is already real. Log with the
      // kind, never the params — params may carry amounts and reasons.
      this.logger.error(
        `Could not record notification '${input.kind}' for ${input.recipient.kind} ` +
          `${input.recipient.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async notifyAdmins(task: AdminTaskInput): Promise<void> {
    const spec = adminNotificationSpec(task.kind);
    try {
      const recipients = await this.resolveAdminRecipients(spec.permissions, task.subject.clientId);
      await this.store.insertAdminTask(recipients, {
        kind: task.kind,
        params: task.params,
        dedupeKey: task.dedupeKey,
        subjectKind: spec.subjectKind,
        subjectId: task.subject.id,
        subjectUserId: task.subject.clientId,
        stillOpen: spec.stillOpen,
      });
    } catch (error) {
      // Never throws — see the port. The polled work-queue badges remain the
      // durable signal; this row is the per-item ping on top.
      this.logger.error(
        `Could not fan out the '${task.kind}' task: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Every ACTIVE admin currently holding ANY of the kind's permissions, whose
   * client scope covers the subject.
   *
   * Resolved LIVE per event rather than cached across events: admins number
   * in the dozens and events in the handfuls per minute, and a stale cache
   * here would ring a bell for an admin whose permission was just revoked.
   * WITHIN one event, though, the role lookups are deduplicated — five admins
   * sharing one role must not cost five identical role fetches.
   *
   * This write-time filter decides who gets PUSHED a toast. The read path
   * applies the same two tests again on every request, so a later re-tag or
   * revocation takes the row away as well.
   */
  private async resolveAdminRecipients(
    permissionKeys: readonly string[],
    subjectClientId: string,
  ): Promise<string[]> {
    const wanted = new Set(permissionKeys.map(normalizePermissionKey));
    const { rows } = await this.admins.findAll();
    const recipients: string[] = [];
    const heldByRole = new Map<string, string[]>();

    for (const admin of rows) {
      if (admin.status !== 'active') continue;

      let held: string[];
      if (admin.roleId && heldByRole.has(admin.roleId)) {
        held = heldByRole.get(admin.roleId) as string[];
      } else {
        held = await this.roles.resolvePermissions(admin.roleId, admin.permissions);
        /*
         * Cache only the ROLE's answer, never the fallback.
         *
         * `resolvePermissions` returns the role's permissions when the role row
         * exists and this admin's OWN `permissions` snapshot when it does not.
         * The snapshot is per-person, so caching it under the role id would
         * hand it to every other admin carrying that same dangling id — some
         * included in a fan-out they should not be in, some silently dropped
         * from one they should. The identity test is exact: `resolvePermissions`
         * returns the snapshot array itself on the fallback path.
         */
        if (admin.roleId && held !== admin.permissions) heldByRole.set(admin.roleId, held);
      }
      if (!held.some((key) => wanted.has(normalizePermissionKey(key)))) continue;

      // Pass the admin's OWN intake grant (D-60) — omitting it treated an
      // intake-granted admin as restricted and dropped their bell for an
      // untagged client's event.
      const scope = await this.scopes.scopeFor(admin.id, admin.seesUntriaged ?? false);
      if (!scope.unrestricted) {
        /*
         * Only the DOMAIN answer ("not visible") skips the recipient — an
         * infrastructure error must reach the outer catch and be LOGGED, or a
         * scoped admin's silently missing row reads as a scoping decision.
         */
        try {
          await this.visibility.assertVisible(subjectClientId, scope);
        } catch (error) {
          if (error instanceof NotFoundError || error instanceof ClientNotFoundError) continue;
          throw error;
        }
      }

      recipients.push(admin.id);
    }
    return recipients;
  }

  // ── The client read API ───────────────────────────────────────────────────

  async list(
    recipient: NotificationRecipient,
    filter: { cursor?: CursorPosition; limit?: number; unreadOnly?: boolean } = {},
  ): Promise<CursorPage<AppNotification>> {
    return this.store.findPage(recipient, filter);
  }

  async unreadCount(recipient: NotificationRecipient): Promise<number> {
    return this.store.unreadCount(recipient);
  }

  async markRead(recipient: NotificationRecipient, id: string): Promise<AppNotification> {
    return this.store.markRead(recipient, id);
  }

  async markAllRead(recipient: NotificationRecipient, upTo?: Date): Promise<number> {
    return this.store.markAllRead(recipient, upTo);
  }

  // ── The admin read API: tasks, re-checked against the session every time ──

  async adminFeed(
    admin: AdminFeedPrincipal,
    query: AdminFeedQuery,
  ): Promise<CursorPage<AdminFeedItem>> {
    const page = await this.store.findAdminPage(readerOf(admin), {
      view: query.view,
      status: query.view === 'history' ? query.status : undefined,
      kinds: query.category ? kindsIn(query.category) : undefined,
      q: query.q,
      cursor: query.cursor,
      limit: query.limit,
    });
    return {
      ...page,
      // The query already admits only catalogue kinds (`kindsVisibleTo`), so
      // this never drops a row — it states the invariant to the type system
      // instead of casting it away.
      items: page.items.flatMap((row) =>
        isAdminNotificationKind(row.kind)
          ? [{ ...row, kind: row.kind, category: categoryOf(row.kind) }]
          : [],
      ),
    };
  }

  async adminSummary(
    admin: AdminFeedPrincipal,
  ): Promise<{ count: number; byCategory: Record<AdminNotificationCategory, number> }> {
    const categories = Object.fromEntries(
      ADMIN_NOTIFICATION_CATEGORIES.map((category) => [category, kindsIn(category)]),
    );
    const summary = await this.store.adminInboxSummary(readerOf(admin), categories);
    return {
      count: summary.count,
      // The store fills a key for every category it was handed — all of them.
      byCategory: summary.byCategory,
    };
  }

  async markAdminRead(admin: AdminFeedPrincipal, id: string) {
    return this.store.markAdminRead(readerOf(admin), id);
  }

  async markAdminUnread(admin: AdminFeedPrincipal, id: string) {
    return this.store.markAdminUnread(readerOf(admin), id);
  }

  async markAllAdminRead(
    admin: AdminFeedPrincipal,
    options: { category?: AdminNotificationCategory; upTo?: Date } = {},
  ): Promise<number> {
    return this.store.markAllAdminRead(readerOf(admin), {
      kinds: options.category ? kindsIn(options.category) : undefined,
      upTo: options.upTo,
    });
  }

  async markAdminSubjectRead(
    admin: AdminFeedPrincipal,
    subjectKind: NotificationSubjectKind,
    subjectId: string,
  ): Promise<number> {
    return this.store.markAdminSubjectRead(readerOf(admin), subjectKind, subjectId);
  }

  /**
   * Retention. Daily rather than hourly — the windows are months, so precision
   * is not the point — and safe to run on every instance: DELETE by age is
   * naturally idempotent.
   */
  @Cron(CronExpression.EVERY_DAY_AT_4AM, { name: 'notifications.prune' })
  async prune(): Promise<void> {
    /*
     * ONE INSTANCE. Cheap and idempotent, so a duplicate run is harmless — but
     * "harmless" is not free: on four replicas it is four times the queries for
     * one result, and a job nobody leases is a job that quietly stops being
     * counted when the estate grows. Every scheduled job on this platform now
     * runs once per tick; the exceptions were the ones people forget.
     */
    await this.leases.run('notifications.prune', 30 * 60_000, () => this.pruneOnce());
  }

  private async pruneOnce(): Promise<void> {
    for (const kind of ['client', 'admin'] as const) {
      try {
        const removed = await this.store.pruneOlderThan(kind, RETENTION_DAYS[kind]);
        if (removed > 0) {
          this.logger.log(
            `Pruned ${removed} ${kind} notification(s) older than ${RETENTION_DAYS[kind]} days.`,
          );
        }
      } catch (error) {
        // Nothing lost — rows stay until the next run. Log, don't alert.
        this.logger.error(
          `The ${kind} notification prune could not run; rows remain until the next attempt: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}

/** The session, reduced to what decides visibility. Rebuilt per request. */
function readerOf(admin: AdminFeedPrincipal): AdminFeedReader {
  return {
    adminId: admin.id,
    kinds: kindsVisibleTo(admin.permissions),
    scope: admin.clientScope,
  };
}
