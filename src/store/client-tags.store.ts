import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE_DB } from '../database/database.module';
import type { Db, Executor } from '../database/db';
import { clientTagAssignments, clientTags } from '../database/schema';
import { clientScopePredicate, type ClientScope } from '../common/security/client-scope';

export interface ClientTag {
  id: string;
  slug: string;
  label: string;
  color?: string;
  description?: string;
  createdAt: Date;
}

/**
 * The advisory-lock namespace for per-client tag changes (`lockAssignments`).
 * An arbitrary constant, distinct from `MANAGER_INVARIANT_LOCK` (715_001); the
 * two-key form it is used in cannot collide with a one-key lock anyway.
 */
const CLIENT_TAGS_LOCK_NAMESPACE = 715_002;

/** A tag ON a client, plus the provenance of that assignment. */
export interface ClientTagAssignment extends ClientTag {
  /** The admin who assigned it. Null on rows written before it was recorded. */
  assignedBy: string | null;
  assignedAt: Date;
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
   * Every tag with its client count, alphabetically — the count NARROWED to the
   * reader's territory.
   *
   * One grouped query rather than a count per tag: the /tags screen renders the
   * whole vocabulary, and a per-row count is the N+1 ARCHITECTURE §5 warns
   * about in exactly this table.
   *
   * ## Why the count is scoped and the vocabulary is not
   *
   * The count was platform-wide, which contradicted this system's own rule —
   * `admin-stats.service.ts` opens "A COUNT IS A DISCLOSURE", and the incident
   * pinned in `client-scope-enforcement.spec.ts` is exactly a total describing
   * rows the reader could not see. A desk restricted to one tag could read the
   * size of every cohort in the business off this screen.
   *
   * The LIST of tags stays whole on purpose. It is the vocabulary an operator
   * assigns from, and a desk that cannot see a label cannot be asked to use it;
   * the label is the business's taxonomy rather than a fact about any client.
   * What the count adds is a per-cohort POPULATION, which is a fact about
   * clients — so that is the half that follows the territory.
   */
  async findAllWithCounts(scope: ClientScope): Promise<ClientTagWithCount[]> {
    const scoped = clientScopePredicate(scope, clientTagAssignments.userId);
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
      .leftJoin(
        clientTagAssignments,
        /*
         * The scope rides in the JOIN CONDITION, not a WHERE. A WHERE would
         * drop the tag row itself as soon as no visible client carried it,
         * which quietly turns a scoped COUNT into a scoped LIST — and the
         * vocabulary is meant to stay whole.
         */
        scoped
          ? and(eq(clientTagAssignments.tagId, clientTags.id), scoped)
          : eq(clientTagAssignments.tagId, clientTags.id),
      )
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
  /**
   * One client's tags, WITH how each one got there.
   *
   * `assigned_by` and `assigned_at` have been written on every assignment
   * since the table existed and were selected by nothing, so "who moved this
   * client onto my desk, and when" was recorded and unanswerable from any
   * screen. Tags are RBAC-03 territory — they decide which admin sees whom —
   * which makes that a question about access, not about labels.
   *
   * The assigner's NAME is resolved by the caller (`AdminTagsService`): this
   * store has no business joining `admins`, and a page of clients needs one
   * lookup rather than one per row.
   */
  async tagsForClient(userId: string): Promise<ClientTagAssignment[]> {
    const rows = await this.db
      .select({
        id: clientTags.id,
        slug: clientTags.slug,
        label: clientTags.label,
        color: clientTags.color,
        description: clientTags.description,
        createdAt: clientTags.createdAt,
        assignedBy: clientTagAssignments.assignedBy,
        assignedAt: clientTagAssignments.assignedAt,
      })
      .from(clientTagAssignments)
      .innerJoin(clientTags, eq(clientTags.id, clientTagAssignments.tagId))
      .where(eq(clientTagAssignments.userId, userId))
      .orderBy(asc(clientTags.label));
    return rows.map((row) => ({
      ...toTag(row),
      assignedBy: row.assignedBy,
      assignedAt: row.assignedAt,
    }));
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
  /**
   * `assignedBy: null` is the SYSTEM assigning — registration attaching the
   * intake tag (D-60). The column was nullable from day one; the signature
   * just never admitted it.
   */
  async assign(
    userId: string,
    tagId: string,
    assignedBy: string | null,
    executor?: Executor,
  ): Promise<boolean> {
    const inserted = await (executor ?? this.db)
      .insert(clientTagAssignments)
      .values({ userId, tagId, assignedBy })
      .onConflictDoNothing()
      .returning();
    return inserted.length > 0;
  }

  /** Detach a tag. Returns whether anything was removed — same reasoning. */
  async unassign(userId: string, tagId: string, executor?: Executor): Promise<boolean> {
    const removed = await (executor ?? this.db)
      .delete(clientTagAssignments)
      .where(and(eq(clientTagAssignments.userId, userId), eq(clientTagAssignments.tagId, tagId)))
      .returning();
    return removed.length > 0;
  }

  /**
   * Make one client's tag changes take turns, for the rest of `executor`'s
   * transaction.
   *
   * A tag change is judged against the client's CURRENT tags ("does the client
   * stay in the actor's view afterwards?"), and that judgement is a read. Two
   * concurrent removals each saw the other tag still in place, both passed, and
   * together they hid the client from the actor with no confirmation. Holding
   * this lock across read-judge-write makes the second change see the first.
   *
   * An ADVISORY lock rather than `FOR UPDATE` on the `users` row: every money
   * path inserts rows referencing `users`, and a foreign-key check takes KEY
   * SHARE on the row it references — the conflict that deadlocked concurrent
   * withdrawals before `lockWallet` moved to NO KEY UPDATE. This lock touches no
   * row, so it can conflict with nothing but another tag change on this client.
   * Two keys (namespace, client), released at commit or rollback.
   */
  async lockAssignments(userId: string, executor: Executor): Promise<void> {
    await executor.execute(
      sql`SELECT pg_advisory_xact_lock(${CLIENT_TAGS_LOCK_NAMESPACE}, hashtext(${userId}))`,
    );
  }

  /** The ids of the tags a client carries — what a tag change is judged on. */
  async tagIdsForClient(userId: string, executor?: Executor): Promise<string[]> {
    const rows = await (executor ?? this.db)
      .select({ tagId: clientTagAssignments.tagId })
      .from(clientTagAssignments)
      .where(eq(clientTagAssignments.userId, userId));
    return rows.map((row) => row.tagId);
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
