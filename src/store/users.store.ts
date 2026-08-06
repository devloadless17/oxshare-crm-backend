import { and, asc, count, desc, eq, sql, SQL, type SQLWrapper } from 'drizzle-orm';
import type { CursorPosition } from '../common/pagination';
import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE_DB } from '../database/database.module';
import type { Db, Executor } from '../database/db';
import { clientTagAssignments, clientTags, users } from '../database/schema';
import {
  clientScopePredicate,
  UNRESTRICTED,
  type ClientScope,
} from '../common/security/client-scope';
import { ValidationError } from '../common/errors/domain-errors';

/**
 * The columns the client list may be ordered by — R-2.5's explicit allowlist.
 *
 * WHY AN ALLOWLIST AND NOT A COLUMN NAME FROM THE QUERY STRING: a sort
 * parameter interpolated into SQL is an injection point, and drizzle 0.45's
 * advisory (GHSA-gpj5-g38j-94v9) is specifically about improperly escaped
 * identifiers — a class this repo was only safe from because no dynamic column
 * name existed anywhere. This is the change that would have made it reachable,
 * so the mapping from a caller's string to a column object is total and closed.
 *
 * WHY IT MAY NOT EXCEED THE INDEXES: every entry needs a `(col DESC, id DESC)`
 * composite, or the seek degrades to a sort over 219,000 rows on every page.
 * Migration 0024 creates exactly these, `test/client-list-indexes.spec.ts`
 * asserts the query PLANS, and adding a key here without an index makes that
 * spec fail rather than making the screen quietly slow.
 *
 * `country` maps to a COALESCE expression, not to the bare column. It is
 * nullable, and `(country, id) < (?, ?)` is UNKNOWN — not false — for every
 * null row, so those clients would silently vanish from the list rather than
 * sorting to one end. On a compliance screen, rows disappearing without a word
 * is the worst available outcome. Migration 0024's index matches this
 * expression exactly; change one and the other stops being used.
 */
export const CLIENT_SORT_COLUMNS = {
  createdAt: users.createdAt,
  email: users.email,
  firstName: users.firstName,
  status: users.status,
  type: users.type,
  verificationLevel: users.verificationLevel,
  country: sql`coalesce(${users.country}, '')`,
} as const;

export type ClientSortKey = keyof typeof CLIENT_SORT_COLUMNS;

export const DEFAULT_CLIENT_SORT: ClientSortKey = 'createdAt';

/**
 * A caller's `?sort=` string, or a 400 naming what is allowed.
 *
 * NEVER a silent fallback to the default. R-2.5: "an unrecognised value is a
 * 400, never a silent fallback — a silently ignored sort is a lie the UI
 * tells." The admin clicks a header, the rows do not change, and there is
 * nothing anywhere to explain why.
 */
export function clientSortKey(value: string | undefined): ClientSortKey {
  if (value === undefined || value === '') return DEFAULT_CLIENT_SORT;
  if (value in CLIENT_SORT_COLUMNS) return value as ClientSortKey;
  throw new ValidationError(
    `Cannot sort clients by "${value}". Allowed: ${Object.keys(CLIENT_SORT_COLUMNS).join(', ')}.`,
  );
}

export function clientSortOrder(value: string | undefined): 'asc' | 'desc' {
  if (value === undefined || value === '') return 'desc';
  if (value === 'asc' || value === 'desc') return value;
  throw new ValidationError(`Cannot order by "${value}". Allowed: asc, desc.`);
}

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  firstName: string;
  lastName: string;
  type: 'individual' | 'referral' | 'partner';
  status: 'active' | 'suspended' | 'pending';
  verificationLevel: 0 | 1;
  emailVerified: boolean;
  emailVerificationToken?: string;
  emailVerificationExpiry?: Date;
  /** SHA-256 of the emailed reset token — never the token itself. */
  passwordResetTokenHash?: string;
  passwordResetExpiry?: Date;
  /** Cutoff for outstanding access tokens - see jwt.strategy.ts. */
  passwordChangedAt?: Date;
  /** Stored filename of the profile photo - see the column comment. */
  avatarFilename?: string;
  country?: string;
  phone?: string;
  /**
   * The partner who introduced them, or undefined for a direct signup.
   *
   * Set once at registration. Nothing updates it — see the column comment: a
   * mutable attribution is a route for one partner's earnings to move to
   * another.
   */
  referredByIbUserId?: string;
  createdAt: Date;
}

type Row = typeof users.$inferSelect;

const toUser = (r: Row): User => ({
  ...r,
  verificationLevel: r.verificationLevel === 1 ? 1 : 0,
  emailVerificationToken: r.emailVerificationToken ?? undefined,
  emailVerificationExpiry: r.emailVerificationExpiry ?? undefined,
  passwordResetTokenHash: r.passwordResetTokenHash ?? undefined,
  passwordResetExpiry: r.passwordResetExpiry ?? undefined,
  passwordChangedAt: r.passwordChangedAt ?? undefined,
  avatarFilename: r.avatarFilename ?? undefined,
  country: r.country ?? undefined,
  phone: r.phone ?? undefined,
  referredByIbUserId: r.referredByIbUserId ?? undefined,
});

@Injectable()
export class UsersStore {
  constructor(@Inject(DRIZZLE_DB) private readonly db: Db) {}

  async create(data: Omit<User, 'id' | 'createdAt'>): Promise<User> {
    const [row] = await this.db.insert(users).values(data).returning();
    return toUser(row);
  }

  async findById(id: string): Promise<User | undefined> {
    const [row] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return row ? toUser(row) : undefined;
  }

  /**
   * A client, if this ADMINISTRATOR may see them — the scoped `findById`.
   *
   * DELIBERATELY A DIFFERENT NAME rather than an optional argument on
   * `findById`. Every admin-facing by-id read has to go through a method whose
   * name says it applied the scope, so a call site that forgot is visible as a
   * different function rather than as a missing second argument nobody notices
   * in review. `findById` remains correct for the portal, jobs and anything
   * else that is not acting on behalf of an administrator.
   *
   * Returns undefined for an out-of-scope client, which is what makes the
   * caller's existing `NotFoundError` fire — 404, never 403. A 403 would
   * distinguish "no such client" from "not yours", and that difference is an
   * oracle for enumerating the client base an admin was specifically denied.
   */
  async findForAdmin(id: string, scope: ClientScope): Promise<User | undefined> {
    const scoped = clientScopePredicate(scope, users.id);
    const [row] = await this.db
      .select()
      .from(users)
      // In the WHERE clause, never a post-fetch comparison — the rule this
      // whole feature rests on. See common/security/client-scope.ts.
      .where(scoped ? and(eq(users.id, id), scoped) : eq(users.id, id))
      .limit(1);
    return row ? toUser(row) : undefined;
  }

  async findByEmail(email: string): Promise<User | undefined> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(eq(users.email, email.toLowerCase()))
      .limit(1);
    return row ? toUser(row) : undefined;
  }

  /**
   * Look a user up by the HASH of their reset token.
   *
   * The caller hashes the token it received; this never sees the token itself,
   * which is the whole point of storing a digest (see schema.ts). Indexed,
   * because this lookup is unauthenticated and an attacker can trigger it at
   * will — without the index it is a sequential scan on demand.
   */
  async findByPasswordResetTokenHash(hash: string): Promise<User | undefined> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(eq(users.passwordResetTokenHash, hash))
      .limit(1);
    return row ? toUser(row) : undefined;
  }

  async findByVerificationToken(token: string): Promise<User | undefined> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(eq(users.emailVerificationToken, token))
      .limit(1);
    return row ? toUser(row) : undefined;
  }

  /**
   * Patch a user. A key present with `undefined` means CLEAR that column.
   *
   * Drizzle drops undefined values from `.set()`, which makes "clear this
   * field" inexpressible and, when every value is undefined, throws "No values
   * to set" — a runtime failure from what reads like an ordinary update. The
   * password-reset expiry path hit exactly that: clearing a dead token is an
   * update whose every field is a clear.
   *
   * `in` rather than a truthiness check, so omitting a key (leave it alone) and
   * passing it as undefined (clear it) stay distinguishable — which is the
   * distinction Drizzle's own behaviour loses.
   */
  /**
   * `executor` lets a caller write inside THEIR transaction, same shape as
   * `AuditLogStore.record` and the money services' `executor ?? this.db`.
   *
   * Needed because raising `verification_level` and writing the KYC decision
   * have to be one atomic act: they are what opens the withdrawal gate, and a
   * crash between them used to leave one of two states.
   */
  async update(id: string, patch: Partial<User>, executor?: Executor): Promise<User | undefined> {
    const { id: _ignored, createdAt: _also, ...rest } = patch;

    const values: Record<string, unknown> = {};
    for (const key of Object.keys(rest)) {
      const value = (rest as Record<string, unknown>)[key];
      values[key] = value === undefined ? null : value;
    }
    if (Object.keys(values).length === 0) return this.findById(id);

    const [row] = await (executor ?? this.db)
      .update(users)
      .set(values)
      .where(eq(users.id, id))
      .returning();
    return row ? toUser(row) : undefined;
  }

  async findAll(): Promise<User[]> {
    const rows = await this.db.select().from(users);
    return rows.map(toUser);
  }

  /**
   * Paginated, filtered and sorted IN SQL (ADM-01).
   *
   * The previous implementation loaded every row with `SELECT *` — including
   * password_hash and refresh_token — then filtered, sorted and sliced in
   * JavaScript. ARCHITECTURE §5 names ~219,000 clients and warns that "the risk
   * is unindexed filters and N+1 queries in the admin table"; the required
   * indexes existed and were never reached because no predicate got to SQL.
   *
   * Only the columns the admin list renders are selected — secrets never leave
   * the database.
   */
  async findPage(filter: {
    page: number;
    limit: number;
    q?: string;
    type?: string;
    status?: string;
    level?: number;
    /** Exact match on `users.country` — the ADM-14 "country tag". */
    country?: string;
    /** ADM-14 label filter, by tag SLUG so a rename cannot break a saved link. */
    tagSlug?: string;
    /** R-2.5 server-side sort. Validated by `clientSortKey` before it gets here. */
    sort?: ClientSortKey;
    order?: 'asc' | 'desc';
    /**
     * Row-level visibility. Defaults to UNRESTRICTED so an existing caller that
     * has not been updated keeps working — but every ADMIN caller must pass the
     * actor's real scope, which is what `test/client-scope-coverage.spec.ts`
     * enforces route by route.
     */
    scope?: ClientScope;
    /** Keyset position — R-2.4. When present, `page` is ignored. */
    cursor?: CursorPosition;
    /** Counting is opt-in: it is a full scan of the filtered set. */
    withTotal?: boolean;
  }) {
    const db = this.db;
    const conditions: SQL[] = [];
    const sortKey: ClientSortKey = filter.sort ?? DEFAULT_CLIENT_SORT;
    const direction = filter.order ?? 'desc';
    const sortColumn: SQLWrapper = CLIENT_SORT_COLUMNS[sortKey];

    if (filter.type) conditions.push(eq(users.type, filter.type as 'individual'));
    if (filter.status) conditions.push(eq(users.status, filter.status as 'active'));
    if (typeof filter.level === 'number' && !Number.isNaN(filter.level)) {
      conditions.push(eq(users.verificationLevel, filter.level));
    }
    if (filter.country) conditions.push(eq(users.country, filter.country));

    /*
     * The tag filter, and the client scope, are both EXISTS — never a join.
     *
     * A join multiplies rows the moment a client carries two matching tags,
     * which would duplicate them in the page AND corrupt the keyset seek (the
     * "last row" is then ambiguous). EXISTS short-circuits on the first match
     * and reads `client_tag_assignments_tag_idx` / the composite primary key
     * directly.
     */
    if (filter.tagSlug) {
      conditions.push(
        sql`EXISTS (
          SELECT 1 FROM ${clientTagAssignments} ta
          JOIN ${clientTags} t ON t.id = ta.tag_id
          WHERE ta.user_id = ${users.id} AND t.slug = ${filter.tagSlug}
        )`,
      );
    }

    // The row-level visibility predicate. In the WHERE clause, never after the
    // fetch — see common/security/client-scope.ts for why that is the whole
    // design. `undefined` for an unrestricted actor, and `and()` drops it.
    const scoped = clientScopePredicate(filter.scope ?? UNRESTRICTED, users.id);
    if (scoped) conditions.push(scoped);
    if (filter.q) {
      /*
       * ONE predicate over the three searchable columns concatenated, matching
       * the expression index in migration 0010 exactly.
       *
       * This was `ilike(email) OR ilike(first_name) OR ilike(last_name)`. A
       * LEADING wildcard cannot use a b-tree, so the unique index on email did
       * nothing for it and every keystroke was a sequential scan over the whole
       * table — precisely the "unindexed filters" ARCHITECTURE §5 warns about at
       * ~219,000 rows.
       *
       * pg_trgm's GIN index makes an infix ILIKE indexable, but ONLY when the
       * query's expression is character-for-character what the index was built
       * on. That is why this is written as one concatenation rather than three
       * ORs, and why the coalesce and the separator are not cosmetic: change
       * either here and the index silently stops being used, with nothing
       * failing and only the query plan to tell you.
       *
       * The space separator also stops a match spanning a column boundary — a
       * search for "n j" should not match first_name "John" against a
       * neighbouring column's leading character.
       */
      conditions.push(
        sql`(coalesce(${users.email}, '') || ' ' || coalesce(${users.firstName}, '') || ' ' || coalesce(${users.lastName}, '')) ILIKE ${`%${filter.q}%`}`,
      );
    }
    /*
     * The keyset seek — R-2.4.
     *
     * `(sort_col, id) < (cursor.value, cursor.id)` as a ROW comparison, not
     * `col < x OR (col = x AND id < y)`. The row form is what Postgres can
     * satisfy with a single index scan, and it is also the form that is
     * obviously correct: it says "everything ordered after this row", which is
     * exactly the question.
     *
     * The `id` tiebreak is load-bearing. Two clients registered in the same
     * millisecond — or sharing a status, a country or a first name, which is
     * far more common — would otherwise sit either side of a page boundary in
     * an order Postgres may change between queries, reintroducing the skipped
     * row this replaces.
     *
     * The COMPARATOR FOLLOWS THE SORT DIRECTION. Under `ORDER BY ... ASC`,
     * "after this row" is `>`, and leaving it as `<` would page backwards
     * through a forwards list: the first Next click would return rows the
     * caller had already seen, silently.
     *
     * The cursor's value is cast to the sort column's own type rather than
     * always to `timestamptz`. `::timestamptz` on an email address is a runtime
     * error at the database, from a value that looked fine in the URL.
     */
    if (filter.cursor) {
      const comparator = direction === 'asc' ? sql`>` : sql`<`;
      const cast =
        sortKey === 'createdAt'
          ? sql`${filter.cursor.value}::timestamptz`
          : sortKey === 'verificationLevel'
            ? sql`${filter.cursor.value}::integer`
            : sql`${filter.cursor.value}::text`;
      // The enum columns compare as text; `status`/`type` cast cleanly because
      // Postgres knows the enum's text representation.
      const seekColumn =
        sortKey === 'createdAt' || sortKey === 'verificationLevel'
          ? sql`${sortColumn}`
          : sql`${sortColumn}::text`;

      conditions.push(
        sql`(${seekColumn}, ${users.id}) ${comparator} (${cast}, ${filter.cursor.id}::uuid)`,
      );
    }

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const columns = {
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      type: users.type,
      status: users.status,
      verificationLevel: users.verificationLevel,
      country: users.country,
      createdAt: users.createdAt,
    };

    // OFFSET is kept for one release so both frontends can move at their own
    // pace (R-8.2, additive-for-a-cycle). It is the path to delete, not to
    // extend: a `page` deep into 219,000 rows makes Postgres walk and discard
    // everything before it.
    const usingCursor = Boolean(filter.cursor) || filter.page <= 1;

    /*
     * Both keys in the SAME direction, matching the seek and matching migration
     * 0024's `(col DESC, id DESC)` indexes.
     *
     * A b-tree can be read backwards only when every column of the ORDER BY
     * agrees, so `(col DESC, id DESC)` serves DESC forwards and ASC backwards
     * with no sort node either way. A mixed `col DESC, id ASC` would serve
     * neither and would silently reintroduce a sort over 219,000 rows.
     */
    const orderBy = direction === 'asc' ? asc : desc;

    const rows = await db
      .select(columns)
      .from(users)
      .where(where)
      .orderBy(orderBy(sortColumn), orderBy(users.id))
      // One extra row answers "is there a next page" with no second query and
      // no count.
      .limit(filter.limit + 1)
      .offset(usingCursor ? 0 : (filter.page - 1) * filter.limit);

    // Counted only on request: it is a full scan of the filtered set, run purely
    // to render "of 219,000", while `nextCursor !== null` answers "is there
    // more" for free.
    let total: number | undefined;
    if (filter.withTotal) {
      const [countRow] = await db
        .select({ value: sql<number>`count(*)::int` })
        .from(users)
        .where(where);
      total = countRow.value;
    }

    return { rows, total };
  }

  async count(): Promise<number> {
    const [{ value }] = await this.db.select({ value: count() }).from(users);
    return value;
  }
}
