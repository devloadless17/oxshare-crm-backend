import {
  and,
  count,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  gte,
  lte,
  ne,
  sql,
  SQL,
} from 'drizzle-orm';
import { Inject, Injectable } from '@nestjs/common';
import {
  buildCursorPage,
  pageSize,
  type CursorPage,
  type CursorPosition,
} from '../common/pagination';
import { NotFoundError, ValidationError } from '../common/errors/domain-errors';
import {
  ADMIN_NOTIFICATION_KINDS,
  isAdminNotificationKind,
  type TaskStillOpen,
} from '../common/notifications/admin-notification-catalogue';
import { clientScopePredicate, type ClientScope } from '../common/security/client-scope';
import { DRIZZLE_DB } from '../database/database.module';
import type { Db, Executor } from '../database/db';
import type { PgTable } from 'drizzle-orm/pg-core';
import {
  admins,
  ibAccruals,
  ibApplications,
  kycSubmissions,
  notifications,
  transactions,
  transfers,
  users,
  type NotificationSubjectKind,
} from '../database/schema';
import { clientIdentitySearch } from './users.store';

/**
 * One recipient of a notification. `kind` decides which principal table the
 * id points at — `users` for clients, `admins` for admins. Every read below
 * scopes on BOTH columns, which is the entire ownership check: a client
 * guessing an admin row's uuid still matches zero rows.
 */
/** An admin by uuid, or a client by Portal ID (0159) — stored as text. */
export type NotificationRecipient = { kind: 'admin'; id: string } | { kind: 'client'; id: number };

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
 * WHO IS READING an admin feed, and therefore what they may see: their OWN
 * rows, of kinds they can act on right now, about clients inside their
 * territory right now. Built from the session on every request — never
 * cached — so a revoked permission or a narrowed scope takes the rows away on
 * the next read (migration 0140; this was write-time only before).
 */
export interface AdminFeedReader {
  adminId: string;
  /** `kindsVisibleTo(admin.permissions)`. Empty means an empty feed. */
  kinds: readonly string[];
  scope: ClientScope;
}

export interface AdminFeedFilter {
  /**
   * `inbox`: still somebody's work — not yet handled by anybody, read or not.
   * `history`: handled, with how it ended. A task is in exactly one of the two.
   */
  view: 'inbox' | 'history';
  /** A category's kinds, when the reader narrowed to one. */
  kinds?: readonly string[];
  /** Portal ID (exact) or name/email — `clientIdentitySearch`, as every client search. */
  q?: string;
  cursor?: CursorPosition;
  limit?: number;
}

/** One admin task, with the client it names joined in at read time. */
export interface AdminNotificationRow {
  id: string;
  kind: string;
  params: Record<string, unknown>;
  readAt: Date | null;
  createdAt: Date;
  subjectKind: NotificationSubjectKind;
  subjectId: string;
  client: {
    id: number;
    portalId: number | null;
    firstName: string | null;
    lastName: string | null;
  };
  resolvedAt: Date | null;
  resolution: string | null;
  resolvedByName: string | null;
}

/** What the fan-out asks the store to write — see `insertAdminTask`. */
export interface AdminTaskRow {
  kind: string;
  params: Record<string, unknown>;
  dedupeKey?: string;
  subjectKind: NotificationSubjectKind;
  subjectId: string;
  subjectUserId: number;
  stillOpen: TaskStillOpen;
}

/**
 * How each subject table spells "still waiting on somebody", per catalogue
 * rule. The fan-out locks the item row with it `FOR SHARE` and writes only if it
 * still holds — see `insertAdminTask` for why that closes the race.
 */
const OPEN_RULES: Readonly<
  Record<string, (id: string) => { table: PgTable; where: SQL | undefined }>
> = {
  'transaction:pending': (id) => ({
    table: transactions,
    where: and(eq(transactions.id, id), eq(transactions.state, 'pending')),
  }),
  'transaction:needs-attention': (id) => ({
    table: transactions,
    where: and(eq(transactions.id, id), eq(transactions.needsAttention, true)),
  }),
  'kyc:awaiting-review': (id) => ({
    table: kycSubmissions,
    where: and(
      // A KYC task's subject is the client, by Portal ID (text in the column).
      eq(kycSubmissions.userId, Number(id)),
      inArray(kycSubmissions.status, ['submitted', 'under_review']),
    ),
  }),
  'ib_application:pending': (id) => ({
    table: ibApplications,
    where: and(eq(ibApplications.id, id), eq(ibApplications.status, 'pending')),
  }),
  'transfer:pending': (id) => ({
    table: transfers,
    where: and(eq(transfers.id, id), eq(transfers.state, 'pending')),
  }),
  'ib_accrual:not-reversed': (id) => ({
    table: ibAccruals,
    where: and(eq(ibAccruals.id, id), ne(ibAccruals.status, 'reversed')),
  }),
};

/** Whether the store can check a catalogue kind's open state — pinned per kind by a spec. */
export function hasOpenRule(
  subjectKind: NotificationSubjectKind,
  stillOpen: TaskStillOpen,
): boolean {
  return Object.hasOwn(OPEN_RULES, `${subjectKind}:${stillOpen}`);
}

/**
 * `inArray` over an empty list is `false` — spelled out rather than trusted to
 * the ORM's version: an admin who can act on nothing must see nothing, and an
 * empty `IN ()` is a syntax error on the older builds.
 */
function kindIn(kinds: readonly string[]): SQL {
  return kinds.length === 0 ? sql`false` : inArray(notifications.kind, [...kinds]);
}

/**
 * The in-app feed behind the bell in both frontends.
 *
 * Writes come only through the NOTIFICATION_DISPATCH port; reads and the
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
      /** Clients only — an admin row is a task; see `insertAdminTask`. */
      recipient: { kind: 'client'; id: number };
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
        recipientId: String(data.recipient.id),
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
   * Fan one TASK out to many admins — in ONE statement, and only while the
   * task is still open.
   *
   * ## Why the item is locked first
   *
   * The fan-out runs after the event committed, by design (it reads the whole
   * admin directory, which no money transaction should wait on). That leaves a
   * window: an admin can approve the withdrawal before the rows announcing it
   * land. Resolution is a trigger on the ITEM's update, so rows inserted after
   * it would stay open forever — the "it keeps showing" bug, by a race.
   *
   * `FOR SHARE` on the item row closes the window both ways. A decision already
   * holding the row makes this wait, then re-read the row, find it handled and
   * write nothing. A decision arriving second waits for this transaction, and
   * its trigger then sees these rows and resolves them.
   *
   * One multi-row insert rather than a loop: a loop that fails on recipient #2
   * strands #3..N unnotified, and with `onConflictDoNothing` a replayed
   * recipient is absorbed per-row without disturbing the rest.
   */
  async insertAdminTask(adminIds: readonly string[], task: AdminTaskRow): Promise<number> {
    if (adminIds.length === 0) return 0;
    return this.db.transaction(async (tx) => {
      if (!(await this.lockIfStillOpen(tx, task))) return 0;
      const rows = await tx
        .insert(notifications)
        .values(
          adminIds.map((adminId) => ({
            recipientKind: 'admin' as const,
            recipientId: adminId,
            kind: task.kind,
            params: task.params,
            dedupeKey: task.dedupeKey,
            subjectKind: task.subjectKind,
            subjectId: task.subjectId,
            subjectUserId: task.subjectUserId,
          })),
        )
        .onConflictDoNothing()
        .returning({ id: notifications.id });
      return rows.length;
    });
  }

  /**
   * Is the item still in the state that makes it somebody's work — and hold
   * it there until this transaction ends. Each subject table spells "open" in
   * its own columns (`OPEN_RULES`); a pairing with no rule throws, and the
   * fan-out logs it rather than writing a row nothing could ever resolve —
   * `admin-notification-catalogue.spec.ts` keeps the catalogue inside the rules.
   */
  private async lockIfStillOpen(
    tx: Executor,
    task: Pick<AdminTaskRow, 'subjectKind' | 'subjectId' | 'stillOpen'>,
  ): Promise<boolean> {
    const rule = OPEN_RULES[`${task.subjectKind}:${task.stillOpen}`];
    if (!rule) {
      throw new Error(
        `No open-state rule for a '${task.subjectKind}' task that is '${task.stillOpen}'.`,
      );
    }
    const { table, where } = rule(task.subjectId);
    // `and()` of nothing is undefined, and an unfiltered FOR SHARE would lock
    // the whole table — refuse rather than trust every rule to stay two-sided.
    if (!where) throw new Error(`Empty open-state rule for '${task.subjectKind}'.`);
    const rows = await tx
      .select({ one: sql<number>`1` })
      .from(table)
      .where(where)
      .for('share');
    return rows.length > 0;
  }

  /** The feed, newest first, keyset-paged (R-2.4). */
  async findPage(
    recipient: NotificationRecipient,
    filter: {
      cursor?: CursorPosition;
      limit?: number;
      unreadOnly?: boolean;
      readOnly?: boolean;
    } = {},
  ): Promise<CursorPage<AppNotification>> {
    const limit = pageSize(filter.limit);

    const conditions: SQL[] = [
      eq(notifications.recipientKind, recipient.kind),
      eq(notifications.recipientId, String(recipient.id)),
    ];
    if (filter.unreadOnly) conditions.push(isNull(notifications.readAt));
    else if (filter.readOnly) conditions.push(isNotNull(notifications.readAt));
    if (filter.cursor) conditions.push(this.after(filter.cursor));

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
          eq(notifications.recipientId, String(recipient.id)),
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
      eq(notifications.recipientId, String(recipient.id)),
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

  /**
   * Mark everything unread as read. Idempotent; returns rows touched.
   *
   * `upTo` is the newest row the reader was SHOWN. Without it, a notification
   * landing between the panel rendering and this request would be marked read
   * unseen — the portal marks what it displays, so that race is its ordinary
   * case, not an edge.
   *
   * `from` is the OLDEST row shown. The panel loads one page, so without it an
   * unread row beyond that page would be marked read without ever being seen.
   */
  async markAllRead(recipient: NotificationRecipient, upTo?: Date, from?: Date): Promise<number> {
    const updated = await this.db
      .update(notifications)
      .set({ readAt: sql`now()` })
      .where(
        and(
          eq(notifications.recipientKind, recipient.kind),
          eq(notifications.recipientId, String(recipient.id)),
          isNull(notifications.readAt),
          upTo ? lte(notifications.createdAt, upTo) : undefined,
          from ? gte(notifications.createdAt, from) : undefined,
        ),
      )
      .returning({ id: notifications.id });
    return updated.length;
  }

  // ── The admin feed: tasks, scoped and permission-checked on every read ────

  /**
   * THE one definition of what an admin may see — every admin read and marker
   * below starts from it, so the list, the badge and "mark read" cannot
   * disagree about a row. A row outside it does not exist for this reader: a
   * marker aimed at it answers "not found", never "not yours".
   */
  private adminVisibility(reader: AdminFeedReader): SQL[] {
    const conditions: SQL[] = [
      eq(notifications.recipientKind, 'admin'),
      eq(notifications.recipientId, reader.adminId),
      kindIn(reader.kinds),
    ];
    const scoped = clientScopePredicate(reader.scope, notifications.subjectUserId);
    if (scoped) conditions.push(scoped);
    return conditions;
  }

  /** The admin feed, newest first, keyset-paged, with the client joined in. */
  async findAdminPage(
    reader: AdminFeedReader,
    filter: AdminFeedFilter,
  ): Promise<CursorPage<AdminNotificationRow>> {
    const limit = pageSize(filter.limit);
    const conditions = this.adminVisibility(reader);

    // Reading a task never moves it: only handling it does (the owner's rule,
    // 5 Oct 2026 — clicking a deposit must not file it away unapproved).
    conditions.push(
      filter.view === 'inbox'
        ? isNull(notifications.resolvedAt)
        : isNotNull(notifications.resolvedAt),
    );
    if (filter.kinds) conditions.push(kindIn(filter.kinds));
    const q = filter.q?.trim();
    if (q) conditions.push(clientIdentitySearch(q, users));
    if (filter.cursor) conditions.push(this.after(filter.cursor));

    const rows = await this.db
      .select({
        id: notifications.id,
        kind: notifications.kind,
        params: notifications.params,
        readAt: notifications.readAt,
        createdAt: notifications.createdAt,
        subjectKind: notifications.subjectKind,
        subjectId: notifications.subjectId,
        subjectUserId: notifications.subjectUserId,
        resolvedAt: notifications.resolvedAt,
        resolution: notifications.resolution,
        clientPortalId: users.id,
        clientFirstName: users.firstName,
        clientLastName: users.lastName,
        resolverName: admins.name,
        cursorValue: sql<string>`${notifications.createdAt}::text`,
      })
      .from(notifications)
      .leftJoin(users, eq(users.id, notifications.subjectUserId))
      .leftJoin(admins, eq(admins.id, notifications.resolvedBy))
      .where(and(...conditions))
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(limit + 1);

    return buildCursorPage(
      rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        params: row.params,
        readAt: row.readAt,
        createdAt: row.createdAt,
        // The CHECK makes all three present on an admin row; the casts state
        // that invariant rather than widen every consumer to `| null`.
        subjectKind: row.subjectKind as NotificationSubjectKind,
        subjectId: row.subjectId as string,
        client: {
          id: row.subjectUserId as number,
          portalId: row.clientPortalId,
          firstName: row.clientFirstName,
          lastName: row.clientLastName,
        },
        resolvedAt: row.resolvedAt,
        resolution: row.resolution,
        resolvedByName: row.resolverName,
        cursorValue: row.cursorValue,
      })),
      limit,
    );
  }

  /**
   * The badge: how many tasks are waiting on this reader, in total and per
   * category — every unhandled one, seen or not, so it equals the Inbox. One
   * scan of the inbox index with a FILTER per category, so the total and the
   * categories are the same count cut two ways and cannot drift apart.
   */
  async adminInboxSummary(
    reader: AdminFeedReader,
    categories: Readonly<Record<string, readonly string[]>>,
  ): Promise<{ count: number; byCategory: Record<string, number> }> {
    const fields: Record<string, SQL<number>> = { total: sql<number>`count(*)::int` };
    for (const [category, kinds] of Object.entries(categories)) {
      fields[category] = sql<number>`(count(*) filter (where ${kindIn(kinds)}))::int`;
    }
    const [row] = await this.db
      .select(fields)
      .from(notifications)
      .where(and(...this.adminVisibility(reader), isNull(notifications.resolvedAt)));
    const byCategory: Record<string, number> = {};
    for (const category of Object.keys(categories)) byCategory[category] = row?.[category] ?? 0;
    return { count: row?.total ?? 0, byCategory };
  }

  /**
   * Mark one of the reader's rows SEEN — it stops reading as new. It does not
   * leave the Inbox: only handling the item does that. Idempotent; a row
   * outside the reader's visibility reads as absent.
   *
   * There is no unread or read-all for an admin any more (5 Oct 2026): both
   * existed to take tasks OUT of the Inbox unhandled, which is what the owner
   * ruled a task must never do.
   */
  async markAdminRead(
    reader: AdminFeedReader,
    id: string,
  ): Promise<{ id: string; readAt: Date | null }> {
    const target = and(eq(notifications.id, id), ...this.adminVisibility(reader));
    const [updated] = await this.db
      .update(notifications)
      .set({ readAt: sql`now()` })
      .where(and(target, isNull(notifications.readAt)))
      .returning({ id: notifications.id, readAt: notifications.readAt });
    if (updated) return updated;

    const [existing] = await this.db
      .select({ id: notifications.id, readAt: notifications.readAt })
      .from(notifications)
      .where(target);
    if (!existing) throw new NotFoundError('Notification not found.');
    return existing;
  }

  /**
   * END a task by a decision that leaves its item as it is — the clawback's
   * "the partner keeps it" — for EVERY admin who holds it, exactly as handling
   * the item would. One transaction:
   *
   *  1. the reader's own row, through `adminVisibility` (out of scope or of a
   *     kind they cannot act on reads as absent);
   *  2. the ITEM locked `FOR SHARE` and re-checked open — the fan-out's lock, so
   *     a reversal racing this either lands first (then this finds it handled
   *     and writes nothing) or waits for this decision to commit;
   *  3. every still-open row of that kind about that item resolved with the
   *     catalogue's outcome, credited to the reader;
   *  4. `withinTx` — the caller's audit row — so the decision and its record
   *     commit together or not at all.
   *
   * Returns `null` when somebody handled it first. The caller has already
   * checked the kind declares such a decision.
   */
  async closeAdminTask(
    reader: AdminFeedReader,
    id: string,
    withinTx: (
      tx: Executor,
      task: {
        kind: string;
        subjectKind: NotificationSubjectKind;
        subjectId: string;
        clientId: number;
      },
    ) => Promise<void>,
  ): Promise<{ kind: string; outcome: string } | null> {
    return this.db.transaction(async (tx) => {
      const [task] = await tx
        .select({
          kind: notifications.kind,
          subjectKind: notifications.subjectKind,
          subjectId: notifications.subjectId,
          subjectUserId: notifications.subjectUserId,
          resolvedAt: notifications.resolvedAt,
        })
        .from(notifications)
        .where(and(eq(notifications.id, id), ...this.adminVisibility(reader)));
      if (!task) throw new NotFoundError('Notification not found.');
      if (task.resolvedAt || !isAdminNotificationKind(task.kind)) return null;
      const spec: { stillOpen: TaskStillOpen; closeOutcome?: string } =
        ADMIN_NOTIFICATION_KINDS[task.kind];
      const outcome = spec.closeOutcome;
      // The CHECK makes all three present on an admin row.
      const subjectKind = task.subjectKind as NotificationSubjectKind;
      const subjectId = task.subjectId as string;
      if (!outcome) {
        throw new ValidationError(
          'This task ends only when its item is handled — open it and decide it there.',
        );
      }

      const open = await this.lockIfStillOpen(tx, {
        subjectKind,
        subjectId,
        stillOpen: spec.stillOpen,
      });
      if (!open) return null;

      const closed = await tx
        .update(notifications)
        .set({ resolvedAt: sql`now()`, resolution: outcome, resolvedBy: reader.adminId })
        .where(
          and(
            eq(notifications.recipientKind, 'admin'),
            eq(notifications.kind, task.kind),
            eq(notifications.subjectKind, subjectKind),
            eq(notifications.subjectId, subjectId),
            isNull(notifications.resolvedAt),
          ),
        )
        .returning({ id: notifications.id });
      if (closed.length === 0) return null;

      await withinTx(tx, {
        kind: task.kind,
        subjectKind,
        subjectId,
        clientId: task.subjectUserId as number,
      });
      return { kind: task.kind, outcome };
    });
  }

  /**
   * The reader opened the ITEM itself — a KYC review page — so the task about
   * it has been seen, whichever door they came through. It stays in the Inbox
   * until the item is handled. Returns rows touched.
   */
  async markAdminSubjectRead(
    reader: AdminFeedReader,
    subjectKind: NotificationSubjectKind,
    subjectId: string,
  ): Promise<number> {
    const updated = await this.db
      .update(notifications)
      .set({ readAt: sql`now()` })
      .where(
        and(
          ...this.adminVisibility(reader),
          eq(notifications.subjectKind, subjectKind),
          eq(notifications.subjectId, subjectId),
          isNull(notifications.readAt),
        ),
      )
      .returning({ id: notifications.id });
    return updated.length;
  }

  /**
   * Retention, per audience: drop rows older than `days`, read or not.
   * Notifications are UX, not records — the audit log and the ledger are the
   * records — and this table collects fan-out multiples of every event.
   */
  async pruneOlderThan(
    recipientKind: NotificationRecipient['kind'],
    days: number,
  ): Promise<number> {
    const deleted = await this.db
      .delete(notifications)
      .where(
        and(
          eq(notifications.recipientKind, recipientKind),
          sql`${notifications.createdAt} < now() - make_interval(days => ${days})`,
        ),
      )
      .returning({ id: notifications.id });
    return deleted.length;
  }

  /**
   * "After this row" in a fixed DESC order is always `<` — the
   * direction-following rule audit-log.store.ts records, with only one
   * direction to follow.
   */
  private after(cursor: CursorPosition): SQL {
    return sql`(${notifications.createdAt}, ${notifications.id}) < (${cursor.value}::timestamptz, ${cursor.id}::uuid)`;
  }
}
