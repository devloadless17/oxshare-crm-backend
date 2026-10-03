import { Injectable, Logger } from '@nestjs/common';
import { maskAuditRow } from '../../common/security/audit-detail-fields';
import { maskedFieldsFor } from '../../common/security/field-mask';
import { AdminsStore } from '../../store/admins.store';
import { ApiKeysStore } from '../../store/api-keys.store';
import { apiKeyActorLabel } from '../../common/security/api-key';
import type { AuthenticatedAdmin } from './guards/admin.guard';
import { AuthorizationError } from '../../common/errors/domain-errors';
import {
  AUDIT_SORT_COLUMNS,
  AuditLogStore,
  DEFAULT_AUDIT_SORT,
  type AuditSubjectType,
} from '../../store/audit-log.store';
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
    private readonly apiKeys: ApiKeysStore,
  ) {}

  /**
   * The name an audit row carries for whoever acted.
   *
   * An administrator is named by their email. A request authenticated by an API
   * KEY reaches every service with the key's id as `actor.id` (see
   * `AdminAuthenticator.authenticateApiKey`), and that id is not an admin — so
   * this used to fall through to `'unknown'` for every action a key performed:
   * the one record that must say who did something said nobody, and a key's
   * actions could not be told from a deleted admin's. The key is named exactly
   * as the guard named it for the request.
   */
  private async actorEmailOf(actorId: string, executor?: Executor): Promise<string> {
    const admin = await this.admins.findById(actorId, executor);
    if (admin) return admin.email;
    const key = await this.apiKeys.findById(actorId, executor);
    return key ? apiKeyActorLabel(key) : 'unknown';
  }

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
    subjectType: AuditSubjectType,
    subjectId: string | number,
    details?: Record<string, unknown>,
  ): Promise<void> {
    await this.auditLog.record(
      {
        actorId,
        /*
         * On the caller's connection. A second pool connection here, taken while
         * the transaction holds a wallet lock, starves the pool under load: every
         * connection waits on that lock while the lock holder waits for a
         * connection. Found live, 3 Oct 2026: 20 concurrent credits → 9 × 500.
         */
        actorEmail: await this.actorEmailOf(actorId, executor),
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
    subjectType: AuditSubjectType,
    subjectId: string | number,
    details?: Record<string, unknown>,
  ) {
    // Fire-and-forget: an audit-write failure must never fail the admin action,
    // but it must be loud in the logs.
    void (async () => {
      await this.auditLog.record({
        actorId,
        actorEmail: await this.actorEmailOf(actorId),
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
   * Read the trail — `audit.view`, asserted HERE as well as in the guard.
   *
   * R-4.3. A guard runs on an HTTP request, and this method is what a report job
   * or an export would call. The trail records who approved every payout and
   * every permission grant, so "who may read it" is a privileged question in its
   * own right — it names which admins acted on which clients.
   *
   * ⚠️ THIS DOCSTRING USED TO SAY THE OPPOSITE, IN THREE PLACES.
   *
   * It read "master admin only", "the route carries `MasterAdminGuard`", and
   * "deliberately not expressed as a permission key … inventing an `audit.view`
   * key here would let a sub-admin be granted it" — while the code below checks
   * exactly `audit.view`, and `audit.view` is a real entry in
   * `permissions.json`. `MasterAdminGuard` no longer exists at all; migration
   * 0044 removed the master tier and the twelve routes it guarded were given
   * real keys.
   *
   * So every sentence here argued against the thing the method does, and would
   * have persuaded a reader that granting `audit.view` to a sub-admin was a
   * privilege escalation rather than the designed behaviour. Recorded rather
   * than quietly rewritten, because a docstring this confident is precisely what
   * stops somebody checking the line beneath it.
   */
  async listAuditLog(
    actor: AuthenticatedAdmin,
    query: {
      page?: string;
      limit?: string;
      cursor?: string;
      action?: string;
      subjectType?: string;
      actorId?: string;
      subjectId?: string;
      q?: string;
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

    /*
     * RBAC-03 reaches inside `details`, which nothing else can.
     *
     * `details` is free-form jsonb — no DTO for the interceptor to walk, no
     * catalogue path for `applyMask` to remove — so it was the one store a field
     * mask could not touch. Most of what was in there was denormalised context
     * and has been removed at the WRITE. What remains is the case that cannot
     * be: `client.email_change` records both addresses because there the
     * addresses ARE the change.
     *
     * So the record keeps them and the READ is narrowed, per the declaration in
     * `audit-detail-fields.ts`. The row is still written whole and the table is
     * still append-only, which is the difference between a redacted VIEW and a
     * redacted RECORD — only the first leaves the log usable as evidence.
     */
    const page = await this.auditLog.findAll({
      // D-54, resolved: client-subject rows follow the reader's territory.
      scope: actor.clientScope,
      page: parseInt(query.page ?? '1', 10) || 1,
      limit: parseInt(query.limit ?? '25', 10) || 25,
      // R-2.4. An audit trail with a gap is worse than none, because it is
      // believed — and OFFSET over an append-only table that only grows is
      // exactly where a gap appears.
      cursor: query.cursor ? decodeCursor(query.cursor, sort) : undefined,
      action: query.action,
      subjectType: query.subjectType,
      /*
       * The two INVESTIGATION filters. `actorId` was accepted by the store from
       * the day it was written and exposed by no route, so the filter existed
       * and was unreachable — the kind of gap that reads as a missing feature
       * and is actually a missing parameter.
       */
      actorId: query.actorId,
      subjectId: query.subjectId,
      q: query.q,
      sort,
      order,
    });

    return {
      ...page,
      // Both client-owned parts of the row: the declared `details` keys, and the
      // actor's own address when the actor IS a client. One call, so the screen
      // and the CSV cannot narrow different things.
      items: page.items.map((row) => maskAuditRow(row, actor.fieldMask)),
      maskedFields: maskedFieldsFor('client', actor.fieldMask),
    };
  }
}
