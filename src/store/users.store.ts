import { and, count, desc, eq, ilike, or, sql, SQL } from 'drizzle-orm';
import type { CursorPosition } from '../common/pagination';
import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE_DB } from '../database/database.module';
import type { Db } from '../database/db';
import { users } from '../database/schema';

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
  refreshToken?: string;
  country?: string;
  phone?: string;
  createdAt: Date;
}

type Row = typeof users.$inferSelect;

const toUser = (r: Row): User => ({
  ...r,
  verificationLevel: r.verificationLevel === 1 ? 1 : 0,
  emailVerificationToken: r.emailVerificationToken ?? undefined,
  emailVerificationExpiry: r.emailVerificationExpiry ?? undefined,
  refreshToken: r.refreshToken ?? undefined,
  country: r.country ?? undefined,
  phone: r.phone ?? undefined,
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

  async findByEmail(email: string): Promise<User | undefined> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(eq(users.email, email.toLowerCase()))
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

  async update(id: string, patch: Partial<User>): Promise<User | undefined> {
    const { id: _ignored, createdAt: _also, ...rest } = patch;
    const [row] = await this.db.update(users).set(rest).where(eq(users.id, id)).returning();
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
    /** Keyset position — R-2.4. When present, `page` is ignored. */
    cursor?: CursorPosition;
    /** Counting is opt-in: it is a full scan of the filtered set. */
    withTotal?: boolean;
  }) {
    const db = this.db;
    const conditions: SQL[] = [];

    if (filter.type) conditions.push(eq(users.type, filter.type as 'individual'));
    if (filter.status) conditions.push(eq(users.status, filter.status as 'active'));
    if (typeof filter.level === 'number' && !Number.isNaN(filter.level)) {
      conditions.push(eq(users.verificationLevel, filter.level));
    }
    if (filter.q) {
      // Case-insensitive prefix/substring across the three searchable columns.
      const term = `%${filter.q}%`;
      conditions.push(
        or(ilike(users.email, term), ilike(users.firstName, term), ilike(users.lastName, term))!,
      );
    }
    /*
     * The keyset seek — R-2.4.
     *
     * `(created_at, id) < (cursor.created_at, cursor.id)` as a ROW comparison,
     * not `created_at < x OR (created_at = x AND id < y)`. The row form is what
     * Postgres can satisfy with a single index scan, and it is also the form
     * that is obviously correct: it says "everything ordered after this row",
     * which is exactly the question.
     *
     * The `id` tiebreak is load-bearing. Two clients registered in the same
     * millisecond would otherwise sit either side of a page boundary in an order
     * Postgres may change between queries — reintroducing the skipped row this
     * replaces.
     */
    if (filter.cursor) {
      conditions.push(
        sql`(${users.createdAt}, ${users.id}) < (${filter.cursor.createdAt}::timestamptz, ${filter.cursor.id}::uuid)`,
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

    const rows = await db
      .select(columns)
      .from(users)
      .where(where)
      // Both keys DESC, matching the cursor comparison above.
      .orderBy(desc(users.createdAt), desc(users.id))
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
