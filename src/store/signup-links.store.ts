import { and, eq, inArray, sql } from 'drizzle-orm';
import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE_DB } from '../database/database.module';
import type { Db, Executor } from '../database/db';
import { AuditLogStore } from './audit-log.store';
import {
  adminClientTagScopes,
  admins,
  clientTagAssignments,
  clientTags,
  transactions,
  users,
} from '../database/schema';

/** What a sign-up arrives with: the administrator whose link it was, and the tags. */
export interface SignupArrival {
  adminId?: string;
  ibUserId?: number;
  tagIds: string[];
}

/** A tag an administrator's link gives — a tag of their territory. */
export interface SignupLinkTag {
  id: string;
  slug: string;
  label: string;
  color?: string;
}

/** What one administrator's link has brought. Counts, never who. */
export interface SignupCounts {
  signups: number;
  verified: number;
  funded: number;
}

/**
 * Administrators' sign-up links (0198): ONE per administrator, `/join/<slug>`.
 *
 * A link has no tags of its own. A sign-up through it gets the administrator's
 * territory tags AS THEY ARE AT THAT MOMENT — read here, live — so changing an
 * administrator's book on the Admin users page changes where their link sends
 * clients, at once, with no copy anywhere to go stale (0195's per-link tags
 * did exactly that).
 */
@Injectable()
export class SignupLinksStore {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Db,
    private readonly auditLog: AuditLogStore,
  ) {}

  /** The tags an administrator's link gives right now: their territory. */
  async tagsFor(adminId: string, executor?: Executor): Promise<SignupLinkTag[]> {
    const rows = await (executor ?? this.db)
      .select({
        id: clientTags.id,
        slug: clientTags.slug,
        label: clientTags.label,
        color: clientTags.color,
      })
      .from(adminClientTagScopes)
      .innerJoin(clientTags, eq(clientTags.id, adminClientTagScopes.tagId))
      .where(eq(adminClientTagScopes.adminId, adminId))
      .orderBy(clientTags.label);
    return rows.map((row) => ({ ...row, color: row.color ?? undefined }));
  }

  /**
   * Whose link `slug` is, and the tags a sign-up through it gets — or undefined
   * when no ACTIVE administrator has it (unknown, retired by a rename, or the
   * administrator is suspended). Never a refusal: a stale link must not cost the
   * broker a client.
   */
  async resolve(slug: string): Promise<{ adminId: string; tagIds: string[] } | undefined> {
    const [admin] = await this.db
      .select({ id: admins.id })
      .from(admins)
      .where(and(eq(admins.signupSlug, slug), eq(admins.status, 'active')))
      .limit(1);
    if (!admin) return undefined;
    return { adminId: admin.id, tagIds: (await this.tagsFor(admin.id)).map((tag) => tag.id) };
  }

  /**
   * The tags a partner's clients inherit: every tag ASSIGNED to the partner's
   * own client row.
   */
  async partnerTagIds(ibUserId: number, executor?: Executor): Promise<string[]> {
    const rows = await (executor ?? this.db)
      .select({ tagId: clientTagAssignments.tagId })
      .from(clientTagAssignments)
      .where(eq(clientTagAssignments.userId, ibUserId));
    return rows.map((row) => row.tagId);
  }

  /**
   * Create a client AND give them the tags they arrive with, in ONE
   * transaction, with one `client.acquired` audit row: a client never exists
   * without the book their administrator's link or partner put them in.
   * `create` is the caller's insert (it maps its own constraint errors).
   */
  async signUp<T extends { id: number; email: string }>(
    create: (tx: Executor) => Promise<T>,
    arrival: SignupArrival,
  ): Promise<T> {
    return this.db.transaction(async (tx: Executor) => {
      const user = await create(tx);
      await this.attach(user.id, arrival.tagIds, tx);
      await this.auditLog.record(
        {
          actorId: user.id,
          actorEmail: user.email,
          actorKind: 'client',
          action: 'client.acquired',
          subjectType: 'user',
          subjectId: user.id,
          details: {
            adminId: arrival.adminId ?? null,
            // A client id, under a CLIENT_ID_KEYS key, so a scoped reader is
            // never shown an out-of-territory partner's Portal ID.
            ibUserId: arrival.ibUserId ?? null,
            tagIds: [...new Set(arrival.tagIds)],
          },
        },
        tx,
      );
      return user;
    });
  }

  /** `attach`, in a transaction of its own — for a write outside a sign-up. */
  async attachNow(userId: number, tagIds: readonly string[]): Promise<void> {
    if (tagIds.length === 0) return;
    await this.db.transaction(async (tx: Executor) => this.attach(userId, tagIds, tx));
  }

  /** Attach tags to a client by the SYSTEM (assigned_by NULL), idempotently. */
  async attach(userId: number, tagIds: readonly string[], executor: Executor): Promise<void> {
    if (tagIds.length === 0) return;
    await executor
      .insert(clientTagAssignments)
      .values([...new Set(tagIds)].map((tagId) => ({ userId, tagId, assignedBy: null })))
      .onConflictDoNothing();
  }

  /** Every administrator's link (or one), with what it has brought — one grouped read. */
  async all(
    onlyAdminId?: string,
  ): Promise<
    { adminId: string; name: string; slug: string; active: boolean; counts: SignupCounts }[]
  > {
    const rows = await this.db
      .select({
        adminId: admins.id,
        name: admins.name,
        slug: admins.signupSlug,
        status: admins.status,
        signups: sql<number>`count(${users.id})::int`,
        verified: sql<number>`(count(${users.id}) FILTER (WHERE ${users.verificationLevel} >= 1))::int`,
        funded: sql<number>`(count(${users.id}) FILTER (WHERE EXISTS (
          SELECT 1 FROM ${transactions} tx
          WHERE tx.user_id = ${users.id} AND tx.direction = 'deposit' AND tx.state = 'success'
        )))::int`,
      })
      .from(admins)
      .leftJoin(users, eq(users.signedUpViaAdminId, admins.id))
      .where(onlyAdminId ? eq(admins.id, onlyAdminId) : undefined)
      .groupBy(admins.id)
      .orderBy(admins.name);
    return rows.map((row) => ({
      adminId: row.adminId,
      name: row.name,
      slug: row.slug,
      active: row.status === 'active',
      counts: { signups: row.signups, verified: row.verified, funded: row.funded },
    }));
  }

  /** One administrator's link and counts. */
  async one(adminId: string) {
    const [row] = await this.all(adminId);
    return row;
  }

  /** Set an administrator's link word. A taken one throws the unique violation. */
  async setSlug(adminId: string, slug: string): Promise<void> {
    await this.db.update(admins).set({ signupSlug: slug }).where(eq(admins.id, adminId));
  }

  /** Which of these administrators exist — for a guard before a write. */
  async exists(adminIds: readonly string[]): Promise<Set<string>> {
    if (adminIds.length === 0) return new Set();
    const rows = await this.db
      .select({ id: admins.id })
      .from(admins)
      .where(inArray(admins.id, [...adminIds]));
    return new Set(rows.map((row) => row.id));
  }
}
