import { and, asc, count, desc, eq, isNull, or, sql, SQL, type SQLWrapper } from 'drizzle-orm';
import { clientScopePredicate, type ClientScope } from '../common/security/client-scope';
import { buildCursorPage, pageSize, type CursorPosition } from '../common/pagination';
import type { SortOrder } from '../common/sorting';
import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE_DB } from '../database/database.module';
import type { Db, Executor } from '../database/db';
import { auditLog } from '../database/schema';
import { currentClientIp } from '../common/logging/request-context';

/**
 * Subject types whose `subjectId` is itself a CLIENT's user id — the rows that
 * name a client in the SUBJECT and therefore follow the reader's scope:
 * `'user'` (tag assign/unassign, status changes), `'kyc_submission'` (keyed on
 * the client's own id), and `'ib_account'` (a partner IS a user, so
 * ib.approve / level_change / parent_change / suspend all carry the client's
 * id as the subject). `'kyc_document'` is deliberately NOT here: its subject is
 * the file's random uuid, which names no one.
 *
 * ⚠️ This is only HALF of "which rows name a client". Money and trading rows
 * carry the client's id in `details`, not the subject — see
 * `auditRowClientId()`. Adding a type here without teaching that function is
 * how the D-54 fix leaked money-audit rows to scoped readers (13 Aug walk).
 */
export const CLIENT_SUBJECT_TYPES = ['user', 'kyc_submission', 'ib_account'] as const;

/** A Postgres regex literal matching the canonical uuid shape. */
const UUID_SHAPE = sql`'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`;

/**
 * The CLIENT this audit row concerns, wherever the id lives — or NULL when it
 * concerns no client (a role edit, a settings change, an admin action).
 *
 * The trail is scoped on THIS expression, not on `subjectId` alone, because a
 * row names its client in one of three places:
 *   - the SUBJECT, for `CLIENT_SUBJECT_TYPES` (uuid-shape-guarded);
 *   - `details.clientId`, for `trading_account` rows (the subject is the MT5
 *     account uuid, which is not a client id);
 *   - `details.userId`, for `transaction` and `wallet` rows (the subject is the
 *     transaction / wallet uuid).
 * Every branch guards the uuid shape, so a malformed value yields NULL and the
 * row FAILS CLOSED (hidden from a scoped reader) rather than aborting the query
 * — the recoverable way to be wrong about the record that must not leak.
 */
function auditRowClientId(): SQL {
  return sql`(CASE
    WHEN ${auditLog.subjectType} IN ('user', 'kyc_submission', 'ib_account')
         AND ${auditLog.subjectId} ~* ${UUID_SHAPE} THEN ${auditLog.subjectId}::uuid
    WHEN ${auditLog.subjectType} = 'trading_account'
         AND ${auditLog.details}->>'clientId' ~* ${UUID_SHAPE}
         THEN (${auditLog.details}->>'clientId')::uuid
    WHEN ${auditLog.subjectType} IN ('transaction', 'wallet')
         AND ${auditLog.details}->>'userId' ~* ${UUID_SHAPE}
         THEN (${auditLog.details}->>'userId')::uuid
  END)`;
}

// D-21: admin action log — actor, action, subject, details, timestamp.
// First Postgres-backed store: entries survive backend restarts. Append-only
// by design — this store exposes no update and no delete, and none may ever
// be added. History not recorded is history lost.
/** Who — or what — acted. See `audit_log.actor_kind` in schema.ts. */
export type AuditActorKind = 'admin' | 'client' | 'system' | 'provider';

export interface AuditEntry {
  id: string;
  actorId: string;
  actorEmail: string;
  /**
   * Defaults to `admin` at the database level, because every row written before
   * this column existed was one. A caller that is NOT an admin must say so —
   * recording a client or a scheduled job as an admin with an `'unknown'` email
   * is a false statement in the one record that must not contain any.
   */
  actorKind?: AuditActorKind;
  action: string;
  subjectType: string;
  subjectId: string;
  details?: Record<string, unknown>;
  /** Where the action came from; absent for non-request work. */
  ipAddress?: string | null;
  createdAt: Date;
}

/**
 * The columns the audit trail may be ordered by — R-2.5.
 *
 * Deliberately SMALL. This table is append-only and only grows, so every
 * sortable column is one whose composite index has to be maintained on every
 * write forever — and the trail is written on every audited admin action. The
 * three offered are the three a reader actually asks for: when it happened, what
 * was done, and who did it.
 *
 * `actorEmail` rather than `actorId`: an operator scanning the log is looking
 * for a person, and grouping by an opaque uuid orders by nothing they can read.
 * The column is denormalised onto the row already (it is captured at write time
 * precisely so a later rename cannot rewrite history), so this needs no join.
 */
export const AUDIT_SORT_COLUMNS = {
  createdAt: auditLog.createdAt,
  action: auditLog.action,
  actorEmail: auditLog.actorEmail,
} as const;

export type AuditSortKey = keyof typeof AUDIT_SORT_COLUMNS;

/** Newest first — what the trail showed before it was sortable. */
export const DEFAULT_AUDIT_SORT: AuditSortKey = 'createdAt';

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
        /*
         * ⚠️ This line was MISSING while the interface above advertised the
         * field: `uploads.controller.ts` passed `actorKind: 'client'` for a
         * client reading their own KYC document, the insert dropped it, and
         * the column's default recorded every such read as an ADMIN's — a
         * false statement in the one record that must not contain any, and
         * precisely the D-47 shape (kept, unreadable — here: sent, unwritten).
         * Undefined still falls through to the database default.
         */
        actorKind: data.actorKind,
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
      /** R-2.5 server-side sort. Validated by `sortKey` before it gets here. */
      sort?: AuditSortKey;
      order?: SortOrder;
      /**
       * D-54, resolved (owner, 13 Aug 2026): rows whose SUBJECT is a client
       * follow the reader's client scope. Admin-subject rows (role edits,
       * invites, settings) stay visible to every `audit.view` holder — the
       * trail about administrators is not client data. Absent scope means the
       * caller is unrestricted, same convention as every other store.
       */
      scope?: ClientScope;
    } = {},
  ) {
    const page = Math.max(1, filter.page ?? 1);
    const limit = pageSize(filter.limit);

    const sortKey: AuditSortKey = filter.sort ?? DEFAULT_AUDIT_SORT;
    const direction = filter.order ?? 'desc';
    const sortColumn: SQLWrapper = AUDIT_SORT_COLUMNS[sortKey];

    const conditions: SQL[] = [];
    if (filter.action) conditions.push(eq(auditLog.action, filter.action));
    if (filter.subjectType) conditions.push(eq(auditLog.subjectType, filter.subjectType));
    if (filter.actorId) conditions.push(eq(auditLog.actorId, filter.actorId));
    if (filter.scope && !filter.scope.unrestricted) {
      /*
       * Keep a row if it names no client, or if that client is inside the
       * reader's territory. The predicate lives in the WHERE clause, never
       * fetch-then-filter — the D-45 rule, for the D-45 reason — and it reads
       * the client id from wherever the row keeps it (`auditRowClientId`), so
       * money and trading rows scope the same as tag and KYC rows. The intake
       * grant is honoured too: a row about an untagged client is visible to a
       * reader who holds `sees_untriaged` (`clientScopePredicate` adds that
       * branch), so completing a triage does not blank its own audit trail.
       */
      const rowClientId = auditRowClientId();
      const inScope = clientScopePredicate(filter.scope, rowClientId);
      // `inScope` is defined for a restricted scope, but keep the guard so a
      // future unrestricted-with-tags shape cannot silently drop the NULL branch.
      const scoped = inScope ? or(isNull(rowClientId), inScope) : undefined;
      if (scoped) conditions.push(scoped);
    }
    /*
     * Keyset seek — R-2.4. The audit log is append-only and grows forever, so it
     * is the list most certain to reach a depth where OFFSET hurts. It is also
     * the one where a skipped row matters most: an audit trail with a gap is
     * worse than no audit trail, because it is believed.
     */
    if (filter.cursor) {
      /*
       * The comparator FOLLOWS the sort direction, and the value is cast to the
       * sort column's own type — both for the reasons `users.store.ts` records.
       * Under `ORDER BY ... ASC`, "after this row" is `>`; a `<` left behind
       * would page backwards through a forwards list and silently re-serve rows
       * the reader had already seen. On an audit trail that reads as duplicated
       * history.
       */
      const comparator = direction === 'asc' ? sql`>` : sql`<`;
      const cast =
        sortKey === 'createdAt'
          ? sql`${filter.cursor.value}::timestamptz`
          : sql`${filter.cursor.value}::text`;
      const seekColumn = sortKey === 'createdAt' ? sql`${sortColumn}` : sql`${sortColumn}::text`;

      conditions.push(
        sql`(${seekColumn}, ${auditLog.id}) ${comparator} (${cast}, ${filter.cursor.id}::uuid)`,
      );
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const db = this.db;
    const usingCursor = Boolean(filter.cursor) || page <= 1;
    // Both keys in the SAME direction, matching migration 0035's composites —
    // a b-tree is readable backwards only when every ORDER BY column agrees.
    const orderBy = direction === 'asc' ? asc : desc;

    const rows = await db
      .select()
      .from(auditLog)
      .where(where)
      .orderBy(orderBy(sortColumn), orderBy(auditLog.id))
      .limit(limit + 1)
      .offset(usingCursor ? 0 : (page - 1) * limit);

    const [{ value: total }] = await db.select({ value: count() }).from(auditLog).where(where);

    // The sort key is stamped into the cursor so it cannot be replayed under a
    // different ordering — `decodeCursor` refuses one that was, rather than
    // seeking to a meaningless position and returning the wrong rows silently.
    const page_ = buildCursorPage(
      rows.map((r) => ({ ...r, details: r.details ?? undefined })),
      limit,
      total,
      sortKey,
    );

    return { ...page_, page, limit };
  }
}
