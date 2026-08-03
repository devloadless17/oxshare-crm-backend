import { Injectable, Logger } from '@nestjs/common';
import { AdminsStore } from '../../store/admins.store';
import { AuditLogStore } from '../../store/audit-log.store';

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

  // ─── Audit log (D-21, append-only) ────────────────────────────────────────
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

  listAuditLog(query: { page?: string; limit?: string; action?: string; subjectType?: string }) {
    return this.auditLog.findAll({
      page: parseInt(query.page ?? '1', 10) || 1,
      limit: parseInt(query.limit ?? '25', 10) || 25,
      action: query.action,
      subjectType: query.subjectType,
    });
  }
}
