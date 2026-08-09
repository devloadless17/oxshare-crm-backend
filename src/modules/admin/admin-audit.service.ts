import { Injectable, Logger } from '@nestjs/common';
import { Admin, AdminsStore } from '../../store/admins.store';
import { AuthorizationError } from '../../common/errors/domain-errors';
import { AUDIT_SORT_COLUMNS, AuditLogStore, DEFAULT_AUDIT_SORT } from '../../store/audit-log.store';
import { sortKey, sortOrder } from '../../common/sorting';
import type { Executor } from '../../database/db';
import { decodeCursor } from '../../common/pagination';
import { actorHasPermission } from '../../common/security/actor';

/**
 * D-21 admin action log.
 *
 * Every other admin service records through this one. It was a private method
 * on the 726-line AdminService, which meant any new admin service either
 * duplicated it or was silently exempt from auditing.
 */
@Injectable()
export class AdminAuditService {
  private readonly logger = new Logger(AdminAuditService.name);

  constructor(
    private readonly admins: AdminsStore,
    private readonly auditLog: AuditLogStore,
  ) {}

  /**
   * Record an admin action INSIDE the caller's transaction — R-6.5.
   *
   * `record()` below is fire-and-forget, which is the right trade for a role
   * rename: the action succeeded, and losing the audit row should not undo it.
   * It is the WRONG trade for approving a withdrawal, settling one, paying a
   * payout or editing a commission plan. There the money moves, the audit row is
   * lost, and the answer to "who approved this payout" is a log line that may
   * itself have rotated away — while D-21's entire justification is that this is
   * the one record that cannot be reconstructed afterwards.
   *
   * So on the money path the audit write joins the transaction that moves the
   * money. If it cannot be written, the money does not move. That is a real
   * behaviour change under database pressure and it is the intended one: a
   * withdrawal that fails loudly can be retried, whereas an unrecorded payout
   * cannot be un-made.
   *
   * Awaited, not detached — `void` on this would silently restore the old
   * behaviour while looking like the new one.
   */
  async recordWithin(
    executor: Executor,
    actorId: string,
    action: string,
    subjectType: string,
    subjectId: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    const actor = await this.admins.findById(actorId);
    await this.auditLog.record(
      {
        actorId,
        actorEmail: actor?.email ?? 'unknown',
        action,
        subjectType,
        subjectId,
        details,
      },
      executor,
    );
  }

  // ─── Audit log (D-21, append-only) ────────────────────────────────────────
  /**
   * Fire-and-forget. Correct for everything that does NOT move money — see
   * `recordWithin` above for the cases where it is not.
   */
  record(
    actorId: string,
    action: string,
    subjectType: string,
    subjectId: string,
    details?: Record<string, unknown>,
  ) {
    // Fire-and-forget: an audit-write failure must never fail the admin action,
    // but it must be loud in the logs.
    void (async () => {
      const actor = await this.admins.findById(actorId);
      await this.auditLog.record({
        actorId,
        actorEmail: actor?.email ?? 'unknown',
        action,
        subjectType,
        subjectId,
        details,
      });
    })().catch((err: Error) =>
      this.logger.error(`Failed to record admin action ${action}: ${err.message}`),
    );
  }

  /**
   * Read the trail — master admin only, asserted HERE as well as in the guard.
   *
   * R-4.3. The route carries `MasterAdminGuard`, which is correct and was the
   * only check: a guard runs on an HTTP request, and this method is what a
   * report job or an export would call. The trail records who approved every
   * payout and every permission grant, so "who may read it" is a privileged
   * question in its own right — it names which admins acted on which clients.
   *
   * Deliberately not expressed as a permission key: master-only is not a grant
   * anybody can be given, which is the whole point of the distinction, and
   * inventing an `audit.view` key here would let a sub-admin be granted it.
   */
  listAuditLog(
    actor: Admin,
    query: {
      page?: string;
      limit?: string;
      cursor?: string;
      action?: string;
      subjectType?: string;
      sort?: string;
      order?: string;
    },
  ) {
    /*
     * Kept in step with the route's `@RequirePermissions('audit.view')`. R-4.3
     * requires this service to re-assert independently of the guard — but
     * "independently" means it must not TRUST the guard, not that it may
     * disagree with it. A stricter check here than at the edge produces a route
     * that authorises the request and then refuses it, which reads as a bug in
     * the audit log rather than as a permission.
     *
     * This used to demand the `master_admin` enum or the `*` wildcard. Neither
     * exists any more: reading the trail is `audit.view`, a key like any other.
     */
    if (!actorHasPermission(actor, 'audit.view')) {
      throw new AuthorizationError('Reading the admin action log requires audit.view.');
    }
    /*
     * Validated BEFORE the cursor is decoded, and the order matters.
     *
     * `decodeCursor` refuses a cursor minted under a different ordering and
     * needs the current sort key to say which. Decoding first would produce
     * "this cursor is for createdAt but you asked for undefined" — true, and
     * useless to whoever has to act on it.
     */
    const sort = sortKey(query.sort, AUDIT_SORT_COLUMNS, DEFAULT_AUDIT_SORT, 'the audit log');
    const order = sortOrder(query.order);

    return this.auditLog.findAll({
      page: parseInt(query.page ?? '1', 10) || 1,
      limit: parseInt(query.limit ?? '25', 10) || 25,
      // R-2.4. An audit trail with a gap is worse than none, because it is
      // believed — and OFFSET over an append-only table that only grows is
      // exactly where a gap appears.
      cursor: query.cursor ? decodeCursor(query.cursor, sort) : undefined,
      action: query.action,
      subjectType: query.subjectType,
      sort,
      order,
    });
  }
}
