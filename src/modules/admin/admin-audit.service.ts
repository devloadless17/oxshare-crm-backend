import { Injectable, Logger } from '@nestjs/common';
import { AdminsStore } from '../../store/admins.store';
import { AuditLogStore } from '../../store/audit-log.store';
import type { Executor } from '../../database/db';
import { decodeCursor } from '../../common/pagination';

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

  listAuditLog(query: {
    page?: string;
    limit?: string;
    cursor?: string;
    action?: string;
    subjectType?: string;
  }) {
    return this.auditLog.findAll({
      page: parseInt(query.page ?? '1', 10) || 1,
      limit: parseInt(query.limit ?? '25', 10) || 25,
      // R-2.4. An audit trail with a gap is worse than none, because it is
      // believed — and OFFSET over an append-only table that only grows is
      // exactly where a gap appears.
      cursor: query.cursor ? decodeCursor(query.cursor) : undefined,
      action: query.action,
      subjectType: query.subjectType,
    });
  }
}
