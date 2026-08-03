import { and, count, desc, eq, SQL } from 'drizzle-orm';
import { getDb } from '../database/db';
import { auditLog } from '../database/schema';

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
  createdAt: Date;
}

export const AuditLogStore = {
  async record(data: Omit<AuditEntry, 'id' | 'createdAt'>): Promise<AuditEntry> {
    const [row] = await getDb()
      .insert(auditLog)
      .values({
        actorId: data.actorId,
        actorEmail: data.actorEmail,
        action: data.action,
        subjectType: data.subjectType,
        subjectId: data.subjectId,
        details: data.details,
      })
      .returning();
    return { ...row, details: row.details ?? undefined };
  },

  async findAll(
    filter: {
      page?: number;
      limit?: number;
      action?: string;
      subjectType?: string;
      actorId?: string;
    } = {},
  ) {
    const page = Math.max(1, filter.page ?? 1);
    const limit = Math.min(100, Math.max(1, filter.limit ?? 25));

    const conditions: SQL[] = [];
    if (filter.action) conditions.push(eq(auditLog.action, filter.action));
    if (filter.subjectType) conditions.push(eq(auditLog.subjectType, filter.subjectType));
    if (filter.actorId) conditions.push(eq(auditLog.actorId, filter.actorId));
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const db = getDb();
    const [rows, [{ value: total }]] = await Promise.all([
      db
        .select()
        .from(auditLog)
        .where(where)
        .orderBy(desc(auditLog.createdAt))
        .limit(limit)
        .offset((page - 1) * limit),
      db.select({ value: count() }).from(auditLog).where(where),
    ]);

    return {
      items: rows.map((r) => ({ ...r, details: r.details ?? undefined })),
      total,
      page,
      limit,
    };
  },
};
