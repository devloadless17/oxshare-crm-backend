import { and, count, desc, eq, getTableColumns, isNull, sql, SQL } from 'drizzle-orm';
import { Inject, Injectable } from '@nestjs/common';
import {
  buildCursorPage,
  pageSize,
  type CursorPage,
  type CursorPosition,
} from '../common/pagination';
import { NotFoundError } from '../common/errors/domain-errors';
import { DRIZZLE_DB } from '../database/database.module';
import type { Db, Executor } from '../database/db';
import { notifications } from '../database/schema';

/**
 * One recipient of a notification. `kind` decides which principal table the
 * id points at — `users` for clients, `admins` for admins. Every read below
 * scopes on BOTH columns, which is the entire ownership check: a client
 * guessing an admin row's uuid still matches zero rows.
 */
export interface NotificationRecipient {
  kind: 'client' | 'admin';
  id: string;
}

export interface AppNotification {
  id: string;
  /** Catalogue slug, e.g. 'withdrawal.approved'. The frontends own the copy. */
  kind: string;
  /** Rendered client-side. Money values in here are STRINGS (§6.1). */
  params: Record<string, unknown>;
  readAt: Date | null;
  createdAt: Date;
}

/** See `client-tags.store.ts` on why this is narrower than `$inferSelect`. */
type NotificationColumns = {
  id: string;
  kind: string;
  params: Record<string, unknown>;
  readAt: Date | null;
  createdAt: Date;
};

const toNotification = (r: NotificationColumns): AppNotification => ({
  id: r.id,
  kind: r.kind,
  params: r.params,
  readAt: r.readAt,
  createdAt: r.createdAt,
});

/**
 * The in-app feed behind the bell in both frontends.
 *
 * Writes come only through the NOTIFICATION_DISPATCH port; reads and the two
 * read-markers come through the notifications controllers. The feed is
 * fixed-sort (newest first) — no caller-chosen columns, so no SORT_COLUMNS
 * allowlist, and every cursor is minted for `createdAt`.
 */
@Injectable()
export class NotificationsStore {
  constructor(@Inject(DRIZZLE_DB) private readonly db: Db) {}

  /**
   * Append one row.
   *
   * `executor` lets the dispatch port write inside the CALLER'S transaction, so
   * a state change and the notification about it commit together or not at all
   * — the same shape as `AuditLogStore.record`.
   *
   * Idempotent when `dedupeKey` is set: `onConflictDoNothing` against the
   * partial unique index absorbs a replayed insert (§6.3 — the constraint IS
   * the guard, never a check-then-insert). Returns whether a row was created,
   * so a caller can tell a first delivery from an absorbed replay.
   */
  async insert(
    data: {
      recipient: NotificationRecipient;
      kind: string;
      params: Record<string, unknown>;
      dedupeKey?: string;
    },
    executor?: Executor,
  ): Promise<boolean> {
    const rows = await (executor ?? this.db)
      .insert(notifications)
      .values({
        recipientKind: data.recipient.kind,
        recipientId: data.recipient.id,
        kind: data.kind,
        params: data.params,
        dedupeKey: data.dedupeKey,
      })
      // Bare, not targeted: Postgres cannot infer a PARTIAL unique index from
      // a column list Drizzle table-qualifies in the predicate. The table's
      // only unique constraints are the PK (freshly generated, cannot clash)
      // and the dedupe index, so "any conflict" and "the dedupe index" are the
      // same statement here.
      .onConflictDoNothing()
      .returning({ id: notifications.id });
    return rows.length > 0;
  }

  /**
   * Fan one event out to many recipients in ONE statement.
   *
   * A single multi-row insert rather than a loop, for two reasons that are
   * really one: a loop is N round-trips, and a loop that fails on recipient
   * #2 strands recipients #3..N unnotified. One statement either lands every
   * row or none — and with `onConflictDoNothing`, replayed recipients are
   * absorbed per-row without disturbing the rest.
   */
  async insertMany(
    recipients: NotificationRecipient[],
    event: { kind: string; params: Record<string, unknown>; dedupeKey?: string },
  ): Promise<number> {
    if (recipients.length === 0) return 0;
    const rows = await this.db
      .insert(notifications)
      .values(
        recipients.map((recipient) => ({
          recipientKind: recipient.kind,
          recipientId: recipient.id,
          kind: event.kind,
          params: event.params,
          dedupeKey: event.dedupeKey,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: notifications.id });
    return rows.length;
  }

  /** The feed, newest first, keyset-paged (R-2.4). */
  async findPage(
    recipient: NotificationRecipient,
    filter: { cursor?: CursorPosition; limit?: number; unreadOnly?: boolean } = {},
  ): Promise<CursorPage<AppNotification>> {
    const limit = pageSize(filter.limit);

    const conditions: SQL[] = [
      eq(notifications.recipientKind, recipient.kind),
      eq(notifications.recipientId, recipient.id),
    ];
    if (filter.unreadOnly) conditions.push(isNull(notifications.readAt));
    if (filter.cursor) {
      // Fixed DESC ordering, so "after this row" is always `<` — the
      // direction-following rule audit-log.store.ts records, with only one
      // direction to follow.
      conditions.push(
        sql`(${notifications.createdAt}, ${notifications.id}) < (${filter.cursor.value}::timestamptz, ${filter.cursor.id}::uuid)`,
      );
    }

    const rows = await this.db
      // The whole row PLUS the sort value as text, for the cursor — see
      // `buildCursorPage`. A Date is millisecond-precision and the column is
      // microsecond, so a cursor minted from it skips the rows sharing the
      // boundary millisecond. A bell that drops notifications when several
      // arrive together is the visible form of that here.
      .select({
        ...getTableColumns(notifications),
        cursorValue: sql<string>`${notifications.createdAt}::text`,
      })
      .from(notifications)
      .where(and(...conditions))
      // Both keys in the same direction — what lets the composite index serve
      // the seek without a sort step.
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(limit + 1);

    /*
     * `cursorValue` is carried THROUGH the mapper, not dropped by it.
     *
     * `toNotification` builds the API shape, which has no business holding a
     * seek artefact — so mapping first discarded the one field the cursor needs
     * and `buildCursorPage` fell back to the Date. It refuses that now, loudly,
     * which is how this was found. The artefact is re-attached here and
     * `buildCursorPage` strips it before the row becomes a response.
     */
    return buildCursorPage(
      rows.map((row) => ({ ...toNotification(row), cursorValue: row.cursorValue })),
      limit,
    );
  }

  /** The badge number. Served by the partial unread index. */
  async unreadCount(recipient: NotificationRecipient): Promise<number> {
    const [{ value }] = await this.db
      .select({ value: count() })
      .from(notifications)
      .where(
        and(
          eq(notifications.recipientKind, recipient.kind),
          eq(notifications.recipientId, recipient.id),
          isNull(notifications.readAt),
        ),
      );
    return value;
  }

  /**
   * Mark one row read. Idempotent — an already-read row is returned as-is.
   *
   * The ownership check IS the WHERE clause (the transfers.service.ts:97
   * stance): a row belonging to someone else matches nothing and reads as
   * absent, so the caller learns "no such notification", not "exists but not
   * yours".
   */
  async markRead(recipient: NotificationRecipient, id: string): Promise<AppNotification> {
    const owned = and(
      eq(notifications.id, id),
      eq(notifications.recipientKind, recipient.kind),
      eq(notifications.recipientId, recipient.id),
    );

    const updated = await this.db
      .update(notifications)
      .set({ readAt: sql`now()` })
      .where(and(owned, isNull(notifications.readAt)))
      .returning();
    if (updated.length > 0) return toNotification(updated[0]);

    // Zero rows updated: either already read (fine — idempotent) or not owned.
    const [existing] = await this.db.select().from(notifications).where(owned);
    if (!existing) throw new NotFoundError('Notification not found.');
    return toNotification(existing);
  }

  /** Mark everything unread as read. Idempotent; returns rows touched. */
  async markAllRead(recipient: NotificationRecipient): Promise<number> {
    const updated = await this.db
      .update(notifications)
      .set({ readAt: sql`now()` })
      .where(
        and(
          eq(notifications.recipientKind, recipient.kind),
          eq(notifications.recipientId, recipient.id),
          isNull(notifications.readAt),
        ),
      )
      .returning({ id: notifications.id });
    return updated.length;
  }

  /**
   * Retention: drop rows older than `days`, read or not. Notifications are
   * UX, not records — the audit log and the ledger are the records — and this
   * table collects fan-out multiples of every event.
   */
  async pruneOlderThan(days: number): Promise<number> {
    const deleted = await this.db
      .delete(notifications)
      .where(sql`${notifications.createdAt} < now() - make_interval(days => ${days})`)
      .returning({ id: notifications.id });
    return deleted.length;
  }
}
