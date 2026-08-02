import { v4 as uuidv4 } from 'uuid';

// D-21: admin action log — actor, action, subject, details, timestamp.
// Append-only by design: the store exposes no update or delete. History not
// recorded is history lost, so this exists from the first admin slice even
// though Rev 9 doesn't list it. Moves to an append-only Postgres table later.
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

const entries: AuditEntry[] = [];

export const AuditLogStore = {
  record(data: Omit<AuditEntry, 'id' | 'createdAt'>): AuditEntry {
    const entry: AuditEntry = { ...data, id: uuidv4(), createdAt: new Date() };
    entries.push(entry);
    return entry;
  },

  findAll(filter: {
    page?: number;
    limit?: number;
    action?: string;
    subjectType?: string;
    actorId?: string;
  } = {}) {
    const page = Math.max(1, filter.page ?? 1);
    const limit = Math.min(100, Math.max(1, filter.limit ?? 25));

    let list = [...entries];
    if (filter.action) list = list.filter((e) => e.action === filter.action);
    if (filter.subjectType) list = list.filter((e) => e.subjectType === filter.subjectType);
    if (filter.actorId) list = list.filter((e) => e.actorId === filter.actorId);

    list.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return {
      items: list.slice((page - 1) * limit, page * limit),
      total: list.length,
      page,
      limit,
    };
  },
};
