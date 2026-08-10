import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ClientNotFoundError, NotFoundError } from '../../common/errors/domain-errors';
import type { Executor } from '../../database/db';
import type {
  NotificationDispatchPort,
  NotificationInput,
} from '../../common/provisioning/notification-dispatch.port';
import { normalizePermissionKey } from '../../common/security/actor';
import { ClientVisibilityService } from '../../common/security/client-visibility.service';
import { AdminClientScopesStore } from '../../store/admin-client-scopes.store';
import { AdminsStore } from '../../store/admins.store';
import {
  NotificationsStore,
  type AppNotification,
  type NotificationRecipient,
} from '../../store/notifications.store';
import { RolesStore } from '../../store/roles.store';
import type { CursorPage, CursorPosition } from '../../common/pagination';

/** How long a bell row lives. The audit log and the ledger are the records. */
const RETENTION_DAYS = 90;

/**
 * The implementation behind `NOTIFICATION_DISPATCH`, plus the read API the two
 * notifications controllers serve.
 *
 * Writes arrive through the port from domain services; reads and the two
 * read-markers arrive through controllers with the recipient taken from the
 * session — never a parameter. See the port file for the in-tx / post-commit
 * contract split.
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

  async notifyAdminsWithPermission(
    permissionKey: string,
    event: Omit<NotificationInput, 'recipient'>,
    options?: { subjectClientId?: string },
  ): Promise<void> {
    try {
      const recipients = await this.resolveAdminRecipients(permissionKey, options?.subjectClientId);
      // ONE multi-row insert: N loop round-trips would mean a failure on
      // recipient #2 strands #3..N unnotified with a log line that reads as a
      // total failure. One statement lands every row or none.
      await this.store.insertMany(recipients, {
        kind: event.kind,
        params: event.params,
        dedupeKey: event.dedupeKey,
      });
    } catch (error) {
      // Never throws — see the port. The polled work-queue badges remain the
      // durable signal; this row is the courtesy on top.
      this.logger.error(
        `Could not fan out notification '${event.kind}' to admins holding ` +
          `'${permissionKey}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Every ACTIVE admin currently holding the permission, scope-filtered.
   *
   * Resolved LIVE per event rather than cached across events: admins number
   * in the dozens and events in the handfuls per minute, and a stale cache
   * here would ring a bell for an admin whose permission was just revoked.
   * WITHIN one event, though, the role lookups are deduplicated — five admins
   * sharing one role must not cost five identical role fetches.
   */
  private async resolveAdminRecipients(
    permissionKey: string,
    subjectClientId?: string,
  ): Promise<NotificationRecipient[]> {
    const wanted = normalizePermissionKey(permissionKey);
    const { rows } = await this.admins.findAll();
    const recipients: NotificationRecipient[] = [];
    const heldByRole = new Map<string, string[]>();

    for (const admin of rows) {
      if (admin.status !== 'active') continue;

      let held: string[];
      if (admin.roleId && heldByRole.has(admin.roleId)) {
        held = heldByRole.get(admin.roleId) as string[];
      } else {
        held = await this.roles.resolvePermissions(admin.roleId, admin.permissions);
        if (admin.roleId) heldByRole.set(admin.roleId, held);
      }
      if (!held.some((key) => normalizePermissionKey(key) === wanted)) continue;

      if (subjectClientId) {
        const scope = await this.scopes.scopeFor(admin.id);
        if (!scope.unrestricted) {
          /*
           * Visibility applied at WRITE time: an out-of-scope admin never
           * holds a row naming a client they may not see. Only the DOMAIN
           * answer ("not visible") skips the recipient — an infrastructure
           * error must reach the outer catch and be LOGGED, or a scoped
           * admin's silently missing row reads as a scoping decision.
           */
          try {
            await this.visibility.assertVisible(subjectClientId, scope);
          } catch (error) {
            if (error instanceof NotFoundError || error instanceof ClientNotFoundError) continue;
            throw error;
          }
        }
      }

      recipients.push({ kind: 'admin', id: admin.id });
    }
    return recipients;
  }

  // ── The read API the controllers serve ────────────────────────────────────

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

  async markAllRead(recipient: NotificationRecipient): Promise<number> {
    return this.store.markAllRead(recipient);
  }

  /**
   * Retention. Daily rather than hourly — the window is 90 days, so precision
   * is not the point — and safe to run on every instance: DELETE by age is
   * naturally idempotent.
   */
  @Cron(CronExpression.EVERY_DAY_AT_4AM, { name: 'notifications.prune' })
  async prune(): Promise<void> {
    try {
      const removed = await this.store.pruneOlderThan(RETENTION_DAYS);
      if (removed > 0) {
        this.logger.log(`Pruned ${removed} notification(s) older than ${RETENTION_DAYS} days.`);
      }
    } catch (error) {
      // Nothing lost — rows stay until the next run. Log, don't alert.
      this.logger.error(
        `The notification prune job could not run; rows remain until the next attempt: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
