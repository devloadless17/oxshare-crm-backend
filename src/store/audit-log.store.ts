import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
  SQL,
  type SQLWrapper,
} from 'drizzle-orm';
import { clientScopePredicate, type ClientScope } from '../common/security/client-scope';
import {
  DEFAULT_PAGE_SIZE,
  buildCursorPage,
  pageSize,
  type CursorPosition,
} from '../common/pagination';
import type { SortOrder } from '../common/sorting';
import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE_DB } from '../database/database.module';
import type { Db, Executor } from '../database/db';
import { auditLog, users } from '../database/schema';
import { currentClientIp, currentFieldMask } from '../common/logging/request-context';
import { clientIdByPortalId, escapeLike, parsePortalId } from './users.store';
import { HIDDEN_TEXT } from '../common/security/mask-by-shape';

/**
 * The subject types whose rows concern ONE client. `audit_log_client_of` (0156)
 * resolves that client for each and the insert trigger stamps it into
 * `audit_log.client_id`, which the reader's client scope filters on (D-54).
 *
 * A row of one of these types whose client could NOT be resolved keeps a NULL
 * `client_id` and is hidden from every scoped reader — a hidden row, never a
 * leaked one. `test/audit-scope-client-id.spec.ts` writes one row of each type
 * and fails if the database does not resolve it, so this list and the SQL
 * function cannot drift apart.
 */
export const CLIENT_SUBJECT_TYPES = [
  'user',
  'kyc_submission',
  'ib_account',
  'trading_account',
  'transaction',
  'wallet',
  'ib_application',
  'transfer',
  'ib_accrual',
  'kyc_document',
  'deposit_proof',
] as const;

/**
 * The subject types whose rows concern NO client: administrators, roles,
 * settings, catalogues and whole-list exports. For these alone a NULL
 * `client_id` is trusted to mean "about nobody" and the row is shown to every
 * `audit.view` holder.
 *
 * `route` (a refused request) is here because the trigger reads the request
 * line: a line naming a client by uuid or Portal ID is stamped with that client
 * and scoped like any client row; a line naming none is about nobody.
 *
 * Every subject a writer can pass is in exactly one of the two lists —
 * `AuditSubjectType` is their union and `record()` takes nothing else, so a new
 * kind of row is a compile error until somebody decides which it is. Before
 * this, an unlisted type was shown to everyone, which is how every KYC
 * document read and every commission reversal reached administrators holding
 * no territory over the client.
 */
export const NON_CLIENT_SUBJECT_TYPES = [
  'admin',
  'admin_invite',
  'agencies',
  'api_key',
  'app_settings',
  'audit_log',
  'client_list',
  'client_tag',
  'currency',
  'external_links',
  'ib_applications',
  'ib_commission_type',
  'ib_level',
  'ib_partners',
  'ip_allowlist',
  'kyc_config',
  'kyc_queue',
  'leverages',
  'payment_method',
  'payment_provider',
  'platform_link',
  'rejection_reason',
  'role',
  'route',
  'trading_account_list',
  'trading_products',
  'transaction_list',
  'wallet_list',
  'withdrawal_method',
  'withdrawal_queue',
] as const;

export type AuditSubjectType =
  (typeof CLIENT_SUBJECT_TYPES)[number] | (typeof NON_CLIENT_SUBJECT_TYPES)[number];

/**
 * What a scoped reader is shown in place of a client outside their territory,
 * wherever a row names one beside the client it is about — `details`, a
 * request line, a client actor. The fact, never the identity (R1/R2): not the
 * uuid, not the Portal ID, not the email.
 */
export const OUTSIDE_TERRITORY = '[client outside your territory]';

/** A client actor's email or IP, for a role whose mask hides it (D-82). */
export const HIDDEN_FROM_ROLE = HIDDEN_TEXT;

/**
 * Where an audit row's `details` names a CLIENT — by Portal ID since 0159.
 *
 * NAMED, not guessed. While a client id was a uuid its shape gave it away; a
 * Portal ID is a number like a level, an attempt count or a page size, so the
 * keys that carry one are listed: these at any depth on every action, plus
 * `before`/`after` on the two actions whose change IS a client (a new parent,
 * a new introducer) — on a level change the same two keys are levels.
 */
const CLIENT_ID_KEYS: ReadonlySet<string> = new Set([
  'userId',
  'clientId',
  'clientUserId',
  'ibUserId',
  'parentIbUserId',
  'ownerUserId',
  'introducerId',
  'referredByIbUserId',
]);
const CLIENT_CHANGE_ACTIONS: ReadonlySet<string> = new Set([
  'ib.parent_change',
  'client.referrer_set',
]);

/** Subject types whose `subject_id` IS the client's Portal ID. */
const SUBJECT_IS_CLIENT: ReadonlySet<string> = new Set(['user', 'kyc_submission', 'ib_account']);

/** A client id: a positive integer, or its digits. */
function asClientId(value: unknown): number | undefined {
  if (typeof value === 'number')
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  if (typeof value === 'string' && /^[1-9][0-9]{0,9}$/.test(value)) return Number(value);
  return undefined;
}

/**
 * `details` with every client id it names passed through `replace` — keys,
 * nesting and every other value exactly as stored. Pure: the one definition
 * both of collecting the ids and of hiding the ones a reader may not see.
 */
export function mapClientIdsInDetails(
  action: string,
  details: unknown,
  replace: (id: number) => unknown,
): unknown {
  const changes = CLIENT_CHANGE_ACTIONS.has(action);
  const walk = (value: unknown, key: string | undefined, depth: number): unknown => {
    if (Array.isArray(value)) return value.map((item) => walk(item, key, depth + 1));
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k, depth + 1)]));
    }
    const namesClient =
      key !== undefined &&
      (CLIENT_ID_KEYS.has(key) ||
        (changes && depth === 1 && (key === 'before' || key === 'after')));
    const id = namesClient ? asClientId(value) : undefined;
    return id === undefined ? value : replace(id);
  };
  return walk(details, undefined, 0);
}

/**
 * A refused request's line, e.g. `PATCH /v1/admin/clients/1000245/status`: the
 * Portal ID after a client route names that client. Only there — a bare number
 * elsewhere in a path is a level, a page, a login.
 */
const CLIENT_IN_REQUEST_LINE =
  /^((?:GET|POST|PUT|PATCH|DELETE) \/.*?\/(?:clients|kyc|partners)\/)([1-9][0-9]{0,9})(?=\/|\?|$)/;

/** The client a request line names, if any. */
export function clientIdInRequestLine(subjectId: string): number | undefined {
  const match = CLIENT_IN_REQUEST_LINE.exec(subjectId);
  return match ? Number(match[2]) : undefined;
}

/**
 * The audit rows a PORTAL ID search returns: every row ABOUT that client, and
 * every row they performed. Exported so the planner test measures this
 * predicate rather than a copy of it.
 *
 * About: `client_id` (0156), the column the scope filter reads, so "rows about
 * client X" means exactly what "rows a scoped reader may see because of client
 * X" means. Served by `audit_log_client_id_idx`. Performed: `actor_id` for a
 * client actor (`audit_log_actor_idx`). The client is resolved once, as an
 * InitPlan (`clientIdByPortalId`).
 *
 * It does not widen what a scoped reader can learn: the scope predicate is
 * ANDed onto it in `findAll`, so an out-of-territory client's rows stay
 * invisible and their Portal ID finds nothing — the same answer an unused
 * number gets.
 */
export function auditClientSearch(portalId: number): SQL {
  const clientId = clientIdByPortalId(portalId);
  return sql`(${auditLog.clientId} = ${clientId} OR (${auditLog.actorKind} = 'client' AND ${auditLog.actorId} = ${String(portalId)}))`;
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
 * What a writer hands `record()`. The subject type is the closed union, so a
 * new kind of row cannot be written until it is classified (see
 * `NON_CLIENT_SUBJECT_TYPES`).
 */
export interface AuditWrite extends Omit<
  AuditEntry,
  'id' | 'createdAt' | 'subjectType' | 'subjectId' | 'actorId'
> {
  subjectType: AuditSubjectType;
  /** An admin's uuid, or a client's Portal ID (0159) — stored as text. */
  actorId: string | number;
  /** The record's id, or a client's Portal ID — stored as text. */
  subjectId: string | number;
  /**
   * The client this row concerns, when the writer knows it better than the
   * row's own fields say. Absent, the insert trigger resolves it (0156) —
   * which is what every writer relies on today.
   */
  clientId?: number;
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
  async record(data: AuditWrite, executor?: Executor): Promise<AuditEntry> {
    const [row] = await (executor ?? this.db)
      .insert(auditLog)
      .values({
        actorId: String(data.actorId),
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
        subjectId: String(data.subjectId),
        details: data.details,
        // Read from the request scope rather than passed in, so every existing
        // call site records it without change. Null for anything not driven by
        // a request — a scheduled job, a migration, a console.
        ipAddress: data.ipAddress ?? currentClientIp() ?? null,
        clientId: data.clientId,
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
      /**
       * WHAT WAS DONE TO THIS ONE THING — a client id, an admin id, a
       * withdrawal id. The column is a VARCHAR carrying whatever the subject's
       * key is, so this is an exact match rather than a uuid parse: a row whose
       * subject is a provider reference is as investigable as one whose subject
       * is a client.
       *
       * The screen reaches this from a client profile, so an operator arrives
       * at "everything that has happened to this person" rather than typing an
       * id — but the filter takes the id, because the id is what the row keys
       * on and the trail must not depend on a name still existing.
       */
      subjectId?: string;
      /**
       * WHO DID IT, by the email the row carries.
       *
       * `actor_email` is denormalised onto the row on purpose — a deleted
       * admin's trail still names them — so searching it needs no join and
       * cannot be defeated by the admin being gone, which is exactly when the
       * question gets asked. Served by the pg_trgm GIN index from 0124; a
       * leading wildcard over an append-only table is otherwise a sequential
       * scan that gets slower every day.
       *
       * ⚠️ It searches the ACTOR only, never `details`. The details blob holds
       * arbitrary before/after values including client PII, and a free-text
       * match over it would let a reader with `audit.view` but a narrow client
       * scope confirm a client's existence from a row count — the same
       * existence probe the scope predicate below exists to prevent.
       *
       * A PORTAL ID is the one exception to "who did it": a number finds every
       * row about that client or performed by them. See the predicate below.
       */
      q?: string;
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
      /**
       * ⚠️ EXPORTS ONLY. Take `limit` literally instead of clamping it to
       * `MAX_PAGE_SIZE`.
       *
       * `pageSize()` clamps to 100, which is right for a LIST — it bounds what
       * one screen can ask the database for. It was wrong for the EXPORT, and
       * silently:
       *
       *   `streamCsv` asks for EXPORT_BATCH_SIZE (1,000) rows a batch and stops
       *   when a batch comes back SHORT, because a short batch means the end of
       *   the data. The clamp handed it 100. So the loop read 100 rows, saw
       *   100 < 1,000, concluded it had reached the end, and finished.
       *
       * Measured 11 Sep 2026: 1,600 rows in `audit_log`, 100 in the CSV — six
       * per cent of the forensic record, on the one table whose entire value is
       * completeness and the one an auditor actually exports.
       *
       * AND THE TRUNCATION NOTICE COULD NOT FIRE. `streamCsv` writes
       * `EXPORT_TRUNCATED_NOTICE` into the file when it passes
       * `MAX_EXPORT_ROWS` (200,000) — a real guard, correctly written, that this
       * clamp made unreachable by ending the stream 199,900 rows early. So the
       * file did not merely truncate, it truncated and said nothing, which is
       * the difference between a limit and a lie.
       *
       * A flag rather than a second query: duplicating the WHERE clause into an
       * `exportBatch` would give the list and the export two predicates that can
       * drift, and an export that quietly filters differently from the screen it
       * came from is worse than one that stops early.
       */
      unclampedLimit?: boolean;
    } = {},
  ) {
    const page = Math.max(1, filter.page ?? 1);
    const limit = filter.unclampedLimit
      ? Math.max(1, filter.limit ?? DEFAULT_PAGE_SIZE)
      : pageSize(filter.limit);

    const sortKey: AuditSortKey = filter.sort ?? DEFAULT_AUDIT_SORT;
    const direction = filter.order ?? 'desc';
    const sortColumn: SQLWrapper = AUDIT_SORT_COLUMNS[sortKey];

    const conditions: SQL[] = [];
    if (filter.action) conditions.push(eq(auditLog.action, filter.action));
    if (filter.subjectType) conditions.push(eq(auditLog.subjectType, filter.subjectType));
    if (filter.actorId) conditions.push(eq(auditLog.actorId, filter.actorId));
    if (filter.subjectId) conditions.push(eq(auditLog.subjectId, filter.subjectId));
    const searchedPortalId = parsePortalId(filter.q);
    if (searchedPortalId !== undefined) {
      // A Portal ID: every row about that client, or performed by them.
      conditions.push(auditClientSearch(searchedPortalId));
      if (filter.scope && !filter.scope.unrestricted) {
        /*
         * …and only a client the reader may see. The scope filter below hides
         * rows ABOUT an outside client, but a visible row that client PERFORMED
         * would still match the actor branch — confirming they exist and acted.
         * An outside Portal ID must answer exactly like an unused one.
         */
        conditions.push(
          clientScopePredicate(filter.scope, clientIdByPortalId(searchedPortalId)) ?? sql`false`,
        );
      }
    } else if (filter.q?.trim()) {
      /*
       * ⚠️ THE `::text` IS LOAD-BEARING, and leaving it out is how 0124 shipped
       * an index nothing could use.
       *
       * `ILIKE` is `~~*`, defined on `text`, so Postgres rewrites a varchar
       * expression here to `(...)::text`. An expression index matches on the
       * expression TREE, so an index built without the cast is a different tree
       * and is never chosen — the index exists, `\d` lists it, and every search
       * is a sequential scan over the append-only table guaranteed to become the
       * largest in the system. 0125 rebuilt the index with the cast; this is the
       * other half, and `test/search-at-scale.spec.ts` asks the planner whether
       * the two still agree.
       */
      conditions.push(
        sql`(coalesce(${auditLog.actorEmail}, '')::text) ILIKE ${`%${escapeLike(filter.q.trim())}%`}`,
      );
      // A CLIENT actor's email is client data: a role that hides it must not
      // be able to spell it out by fragment through this search (D-82).
      if (currentFieldMask().includes('client.email')) {
        conditions.push(sql`${auditLog.actorKind} <> 'client'`);
      }
    }
    if (filter.scope && !filter.scope.unrestricted) {
      /*
       * Keep a row about a client inside the reader's territory (the intake
       * grant included — completing a triage does not blank its own trail), or
       * a row about NO client — and "no client" is believed only for the types
       * declared to concern none. A client-type row whose client could not be
       * resolved stays hidden: 0156 turned the wrong answer from a leak into a
       * hidden row. In the WHERE clause, never fetch-then-filter (D-45).
       */
      conditions.push(
        or(
          and(
            isNull(auditLog.clientId),
            inArray(auditLog.subjectType, [...NON_CLIENT_SUBJECT_TYPES]),
          ),
          and(
            isNotNull(auditLog.clientId),
            // Defined for every restricted scope; `false` keeps a future shape
            // that returns undefined from widening instead of narrowing.
            clientScopePredicate(filter.scope, auditLog.clientId) ?? sql`false`,
          ),
        ) as SQL,
      );
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
      /*
       * The whole row PLUS the sort value as text, for the cursor.
       *
       * This table matters most for that fix: it is append-only, it is written
       * many times a second under load, and two rows sharing a millisecond is
       * the ordinary case rather than the exotic one. A cursor truncated to
       * milliseconds skips every row at the page boundary that shares it — a
       * GAP in the one record whose entire value is completeness, and which is
       * believed precisely because it is supposed to be complete.
       */
      .select({
        ...getTableColumns(auditLog),
        cursorValue: sql<string>`${sortColumn}::text`,
        /*
         * The Portal ID of the client this row concerns (`client_id`, 0156).
         * NULL for a row about no client (a role edit, a setting). A LEFT join
         * on the primary key: one index probe per row, and never a row lost.
         */
        clientPortalId: users.id,
      })
      .from(auditLog)
      .leftJoin(users, eq(users.id, auditLog.clientId))
      .where(where)
      .orderBy(orderBy(sortColumn), orderBy(auditLog.id))
      .limit(limit + 1)
      .offset(usingCursor ? 0 : (page - 1) * limit);

    const [{ value: total }] = await db.select({ value: count() }).from(auditLog).where(where);

    // The sort key is stamped into the cursor so it cannot be replayed under a
    // different ordering — `decodeCursor` refuses one that was, rather than
    // seeking to a meaningless position and returning the wrong rows silently.
    const page_ = buildCursorPage(
      (await this.withClientPortalIds(rows, filter.scope)).map((r) => ({
        ...r,
        details: r.details ?? undefined,
      })),
      limit,
      total,
      sortKey,
    );

    return { ...page_, page, limit };
  }

  /**
   * Each row as THIS reader may see it (R1, D-81/D-82).
   *
   * A client is named by Portal ID everywhere since 0159, so a visible client
   * needs no rewriting at all. What changes is a client OUTSIDE the reader's
   * territory named on a row they may see — the previous partner on a parent
   * change, a client acting on a record: shown as `OUTSIDE_TERRITORY`, never
   * their number or email. One query answers, for every client the page names,
   * whether it exists and whether this reader may see it.
   *
   * A CLIENT actor's email and IP are client data, hidden per the reader's role
   * like any other (D-82) — the static DTO cannot say so, because the same
   * columns hold an administrator's on every other row.
   */
  private async withClientPortalIds<
    T extends {
      actorId: string;
      actorEmail: string;
      actorKind: AuditActorKind;
      action: string;
      subjectType: string;
      subjectId: string;
      details: Record<string, unknown> | null;
      ipAddress: string | null;
      clientId: number | null;
    },
  >(
    rows: T[],
    scope: ClientScope | undefined,
  ): Promise<
    Array<Omit<T, 'clientId'> & { actorPortalId: number | null; subjectPortalId: number | null }>
  > {
    const actorOf = (row: T) => (row.actorKind === 'client' ? asClientId(row.actorId) : undefined);
    const subjectOf = (row: T) =>
      SUBJECT_IS_CLIENT.has(row.subjectType)
        ? asClientId(row.subjectId)
        : clientIdInRequestLine(row.subjectId);

    const ids = new Set<number>();
    for (const row of rows) {
      const actor = actorOf(row);
      const subject = subjectOf(row);
      if (actor !== undefined) ids.add(actor);
      if (subject !== undefined) ids.add(subject);
      mapClientIdsInDetails(row.action, row.details, (id) => ids.add(id));
    }
    const restricted = scope !== undefined && !scope.unrestricted;
    const visible = restricted
      ? sql<boolean>`coalesce(${clientScopePredicate(scope, users.id) ?? sql`false`}, false)`
      : sql<boolean>`true`;
    const found =
      ids.size === 0
        ? []
        : await this.db
            .select({ id: users.id, visible })
            .from(users)
            .where(inArray(users.id, [...ids]));
    const known = new Set(found.map((u) => u.id));
    const hidden = new Set(found.filter((u) => !u.visible).map((u) => u.id));

    const mask = currentFieldMask();
    const hideClientEmail = mask.includes('client.email');
    const hideClientIp = mask.includes('client.ipAddress');

    // `clientId` is the row's internal scope key — the scope already used it.
    return rows.map(({ clientId: _clientId, ...rest }) => {
      const row = rest as unknown as T;
      const actor = actorOf(row);
      const subject = subjectOf(row);
      const clientActor = row.actorKind === 'client';
      const hiddenActor = actor !== undefined && hidden.has(actor);
      const hiddenSubject = subject !== undefined && hidden.has(subject);
      return {
        ...rest,
        actorId: hiddenActor ? OUTSIDE_TERRITORY : row.actorId,
        actorEmail: hiddenActor
          ? OUTSIDE_TERRITORY
          : clientActor && hideClientEmail
            ? HIDDEN_FROM_ROLE
            : row.actorEmail,
        ipAddress: clientActor && (hiddenActor || hideClientIp) ? null : row.ipAddress,
        actorPortalId: actor !== undefined && known.has(actor) && !hiddenActor ? actor : null,
        subjectPortalId:
          subject !== undefined && known.has(subject) && !hiddenSubject ? subject : null,
        subjectId: hiddenSubject
          ? SUBJECT_IS_CLIENT.has(row.subjectType)
            ? OUTSIDE_TERRITORY
            : row.subjectId.replace(CLIENT_IN_REQUEST_LINE, `$1${OUTSIDE_TERRITORY}`)
          : row.subjectId,
        details:
          row.details === null
            ? null
            : (mapClientIdsInDetails(row.action, row.details, (id) =>
                hidden.has(id) ? OUTSIDE_TERRITORY : id,
              ) as Record<string, unknown>),
      };
    });
  }
}
