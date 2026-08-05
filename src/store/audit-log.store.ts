import { and, count, desc, eq, sql, SQL } from 'drizzle-orm';
import { buildCursorPage, pageSize, type CursorPosition } from '../common/pagination';
import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE_DB } from '../database/database.module';
import type { Db, Executor } from '../database/db';
import { auditLog } from '../database/schema';
import { currentClientIp } from '../common/logging/request-context';

// D-21: admin action log — actor, action, subject, details, timestamp.
// First Postgres-backed store: entries survive backend restarts. Append-only
// by design — this store exposes no update and no delete, and none may ever
// be added. History not recorded is history lost.
export interface AuditEntry {
  id: string;
  actorId: string;
  actorEmail: string;
  action: string;
  subjectType: string;
  subjectId: string;
  details?: Record<string, unknown>;
  /** Where the action came from; absent for non-request work. */
  ipAddress?: string | null;
  createdAt: Date;
}

@Injectable()
export class AuditLogStore {
  constructor(@Inject(DRIZZLE_DB) private readonly db: Db) {}

  /**
   * Append one entry.
   *
   * `executor` lets a caller write the row inside THEIR transaction (R-6.5), so
   * a money movement and the record of who authorised it commit together or not
   * at all. Omitted, it writes on the pool, which is what every non-money caller
   * wants. Same shape as the money services' `executor ?? this.db` (§6.2).
   */
  async record(
    data: Omit<AuditEntry, 'id' | 'createdAt'>,
    executor?: Executor,
  ): Promise<AuditEntry> {
    const [row] = await (executor ?? this.db)
      .insert(auditLog)
      .values({
        actorId: data.actorId,
        actorEmail: data.actorEmail,
        action: data.action,
        subjectType: data.subjectType,
        subjectId: data.subjectId,
        details: data.details,
        // Read from the request scope rather than passed in, so every existing
        // call site records it without change. Null for anything not driven by
        // a request — a scheduled job, a migration, a console.
        ipAddress: data.ipAddress ?? currentClientIp() ?? null,
      })
      .returning();
    return { ...row, details: row.details ?? undefined, ipAddress: row.ipAddress };
  }

  async findAll(
    filter: {
      page?: number;
      limit?: number;
      /** Keyset position — R-2.4. When present, `page` is ignored. */
      cursor?: CursorPosition;
      action?: string;
      subjectType?: string;
      actorId?: string;
    } = {},
  ) {
    const page = Math.max(1, filter.page ?? 1);
    const limit = pageSize(filter.limit);

    const conditions: SQL[] = [];
    if (filter.action) conditions.push(eq(auditLog.action, filter.action));
    if (filter.subjectType) conditions.push(eq(auditLog.subjectType, filter.subjectType));
    if (filter.actorId) conditions.push(eq(auditLog.actorId, filter.actorId));
    /*
     * Keyset seek — R-2.4. The audit log is append-only and grows forever, so it
     * is the list most certain to reach a depth where OFFSET hurts. It is also
     * the one where a skipped row matters most: an audit trail with a gap is
     * worse than no audit trail, because it is believed.
     */
    if (filter.cursor) {
      conditions.push(
        sql`(${auditLog.createdAt}, ${auditLog.id}) < (${filter.cursor.createdAt}::timestamptz, ${filter.cursor.id}::uuid)`,
      );
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const db = this.db;
    const usingCursor = Boolean(filter.cursor) || page <= 1;

    const rows = await db
      .select()
      .from(auditLog)
      .where(where)
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(limit + 1)
      .offset(usingCursor ? 0 : (page - 1) * limit);

    const [{ value: total }] = await db.select({ value: count() }).from(auditLog).where(where);

    const page_ = buildCursorPage(
      rows.map((r) => ({ ...r, details: r.details ?? undefined })),
      limit,
      total,
    );

    return { ...page_, page, limit };
  }
}
