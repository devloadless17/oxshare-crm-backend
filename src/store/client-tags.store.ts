import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE_DB } from '../database/database.module';
import type { Db } from '../database/db';
import { clientTagAssignments, clientTags } from '../database/schema';

export interface ClientTag {
  id: string;
  slug: string;
  label: string;
  color?: string;
  description?: string;
  createdAt: Date;
}

/** A tag plus how many clients carry it — the /tags screen's row. */
export interface ClientTagWithCount extends ClientTag {
  clientCount: number;
}

/**
 * The columns a tag is built from — deliberately NARROWER than
 * `typeof clientTags.$inferSelect`.
 *
 * Several queries below project only these (a count join, a client's tags),
 * and typing the mapper as the full row would force an `as Row` cast at each
 * one. A cast is exactly what would stop the compiler noticing the day a
 * projection drops a column the mapper reads.
 */
type TagColumns = {
  id: string;
  slug: string;
  label: string;
  color: string | null;
  description: string | null;
  createdAt: Date;
};

const toTag = (r: TagColumns): ClientTag => ({
  id: r.id,
  slug: r.slug,
  label: r.label,
  color: r.color ?? undefined,
  description: r.description ?? undefined,
  createdAt: r.createdAt,
});

/**
 * ADM-14 client labels.
 *
 * A tag stopped being merely descriptive once `admin_client_tag_scopes`
 * arrived: it now decides which administrators can see a client. Every write
 * through this store is privilege-adjacent, which is why `tags.assign` is a
 * permission separate from `tags.manage`.
 */
@Injectable()
export class ClientTagsStore {
  constructor(@Inject(DRIZZLE_DB) private readonly db: Db) {}

  /**
   * Every tag with its client count, alphabetically.
   *
   * One grouped query rather than a count per tag: the /tags screen renders the
   * whole vocabulary, and a per-row count is the N+1 ARCHITECTURE §5 warns
   * about in exactly this table.
   */
  async findAllWithCounts(): Promise<ClientTagWithCount[]> {
    const rows = await this.db
      .select({
        id: clientTags.id,
        slug: clientTags.slug,
        label: clientTags.label,
        color: clientTags.color,
        description: clientTags.description,
        createdAt: clientTags.createdAt,
        // LEFT JOIN + count of the joined key, so a tag nobody carries reports
        // 0 rather than vanishing from the list.
        clientCount: sql<number>`count(${clientTagAssignments.userId})::int`,
      })
      .from(clientTags)
      .leftJoin(clientTagAssignments, eq(clientTagAssignments.tagId, clientTags.id))
      .groupBy(clientTags.id)
      .orderBy(asc(clientTags.label));

    return rows.map((r) => ({ ...toTag(r), clientCount: r.clientCount }));
  }

  async findAll(): Promise<ClientTag[]> {
    const rows = await this.db.select().from(clientTags).orderBy(asc(clientTags.label));
    return rows.map(toTag);
  }

  async findById(id: string): Promise<ClientTag | undefined> {
    const [row] = await this.db.select().from(clientTags).where(eq(clientTags.id, id)).limit(1);
    return row ? toTag(row) : undefined;
  }

  async findBySlug(slug: string): Promise<ClientTag | undefined> {
    const [row] = await this.db.select().from(clientTags).where(eq(clientTags.slug, slug)).limit(1);
    return row ? toTag(row) : undefined;
  }

  async findByIds(ids: readonly string[]): Promise<ClientTag[]> {
    if (ids.length === 0) return [];
    const rows = await this.db
      .select()
      .from(clientTags)
      .where(inArray(clientTags.id, [...ids]));
    return rows.map(toTag);
  }

  async create(data: {
    slug: string;
    label: string;
    color?: string;
    description?: string;
    createdBy: string;
  }): Promise<ClientTag> {
    const [row] = await this.db.insert(clientTags).values(data).returning();
    return toTag(row);
  }

  async update(
    id: string,
    patch: { label?: string; color?: string | null; description?: string | null },
  ): Promise<ClientTag | undefined> {
    const [updated] = await this.db
      .update(clientTags)
      .set(patch)
      .where(eq(clientTags.id, id))
      .returning();
    return updated ? toTag(updated) : undefined;
  }

  async delete(id: string): Promise<boolean> {
    const deleted = await this.db.delete(clientTags).where(eq(clientTags.id, id)).returning();
    return deleted.length > 0;
  }

  // ─── assignments ──────────────────────────────────────────────────────────

  /** The tags one client carries, for the row and the profile. */
  async tagsForClient(userId: string): Promise<ClientTag[]> {
    const rows = await this.db
      .select({
        id: clientTags.id,
        slug: clientTags.slug,
        label: clientTags.label,
        color: clientTags.color,
        description: clientTags.description,
        createdAt: clientTags.createdAt,
      })
      .from(clientTagAssignments)
      .innerJoin(clientTags, eq(clientTags.id, clientTagAssignments.tagId))
      .where(eq(clientTagAssignments.userId, userId))
      .orderBy(asc(clientTags.label));
    return rows.map(toTag);
  }

  /**
   * The tags carried by each of these clients, in ONE query.
   *
   * The client list renders 25 rows with their tags; fetching per row is the
   * N+1 that ARCHITECTURE §5 names as the actual risk at this table's size —
   * 25 extra round trips per keystroke of the search box.
   */
  async tagsForClients(userIds: readonly string[]): Promise<Map<string, ClientTag[]>> {
    const byUser = new Map<string, ClientTag[]>();
    if (userIds.length === 0) return byUser;

    const rows = await this.db
      .select({
        userId: clientTagAssignments.userId,
        id: clientTags.id,
        slug: clientTags.slug,
        label: clientTags.label,
        color: clientTags.color,
        description: clientTags.description,
        createdAt: clientTags.createdAt,
      })
      .from(clientTagAssignments)
      .innerJoin(clientTags, eq(clientTags.id, clientTagAssignments.tagId))
      .where(inArray(clientTagAssignments.userId, [...userIds]))
      .orderBy(asc(clientTags.label));

    for (const row of rows) {
      const list = byUser.get(row.userId) ?? [];
      list.push(toTag(row));
      byUser.set(row.userId, list);
    }
    return byUser;
  }

  /**
   * Attach a tag. Idempotent BY CONSTRAINT, never by check-then-insert.
   *
   * `ON CONFLICT DO NOTHING` against the composite primary key — ARCHITECTURE
   * §6.3's rule. Two admins tagging the same client in the same instant is
   * ordinary, and a check-then-insert would race into a 500 on the second one.
   *
   * Returns whether a row was actually created, so the caller can skip an audit
   * entry for a no-op rather than recording an event that did not happen.
   */
  async assign(userId: string, tagId: string, assignedBy: string): Promise<boolean> {
    const inserted = await this.db
      .insert(clientTagAssignments)
      .values({ userId, tagId, assignedBy })
      .onConflictDoNothing()
      .returning();
    return inserted.length > 0;
  }

  /** Detach a tag. Returns whether anything was removed — same reasoning. */
  async unassign(userId: string, tagId: string): Promise<boolean> {
    const removed = await this.db
      .delete(clientTagAssignments)
      .where(and(eq(clientTagAssignments.userId, userId), eq(clientTagAssignments.tagId, tagId)))
      .returning();
    return removed.length > 0;
  }

  /** How many clients carry a tag — what the delete confirmation quotes. */
  async countClientsForTag(tagId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(clientTagAssignments)
      .where(eq(clientTagAssignments.tagId, tagId));
    return row?.n ?? 0;
  }
}
