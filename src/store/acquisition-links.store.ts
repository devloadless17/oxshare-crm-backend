import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE_DB } from '../database/database.module';
import type { Db, Executor } from '../database/db';
import {
  acquisitionLinkTags,
  acquisitionLinks,
  admins,
  clientTagAssignments,
  clientTags,
  transactions,
  users,
} from '../database/schema';

/** A link's tag, as the console shows it. */
export interface AcquisitionLinkTag {
  id: string;
  slug: string;
  label: string;
  color?: string;
}

/** One administrator's sign-up link (0195), with what it has brought. */
export interface AcquisitionLink {
  id: string;
  code: string;
  name: string;
  ownerAdminId: string;
  ownerName: string;
  /** False when the owner is suspended: the link then tags nobody. */
  ownerActive: boolean;
  tags: AcquisitionLinkTag[];
  disabledAt: Date | null;
  createdAt: Date;
  /** Clients who signed up through it. Counts, never who. */
  signups: number;
  /** …of whom verified (level ≥ 1). */
  verified: number;
  /** …of whom have a successful deposit. */
  funded: number;
}

/** What a sign-up through a live link is given. */
export interface SignupAttribution {
  linkId: string;
  ownerAdminId: string;
  tagIds: string[];
}

/**
 * Administrators' sign-up links and the tags a sign-up arrives with.
 *
 * A tag is a territory (admin_client_tag_scopes), so every write here decides
 * who will SEE the clients a link brings — which is why the service, not this
 * store, judges whose tags may go on whose link.
 */
@Injectable()
export class AcquisitionLinksStore {
  constructor(@Inject(DRIZZLE_DB) private readonly db: Db) {}

  /** Every link, newest first, with its owner, tags and counts — ONE grouped read each. */
  async list(): Promise<AcquisitionLink[]> {
    return this.read();
  }

  async findById(id: string, executor?: Executor): Promise<AcquisitionLink | undefined> {
    const [link] = await this.read(id, executor);
    return link;
  }

  async codeTaken(code: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: acquisitionLinks.id })
      .from(acquisitionLinks)
      .where(eq(acquisitionLinks.code, code))
      .limit(1);
    return row !== undefined;
  }

  private async read(id?: string, executor?: Executor): Promise<AcquisitionLink[]> {
    const db = executor ?? this.db;
    const rows = await db
      .select({
        id: acquisitionLinks.id,
        code: acquisitionLinks.code,
        name: acquisitionLinks.name,
        ownerAdminId: acquisitionLinks.ownerAdminId,
        ownerName: admins.name,
        ownerStatus: admins.status,
        disabledAt: acquisitionLinks.disabledAt,
        createdAt: acquisitionLinks.createdAt,
        signups: sql<number>`(SELECT count(*)::int FROM ${users} u WHERE u.acquisition_link_id = ${acquisitionLinks.id})`,
        verified: sql<number>`(SELECT count(*)::int FROM ${users} u WHERE u.acquisition_link_id = ${acquisitionLinks.id} AND u.verification_level >= 1)`,
        funded: sql<number>`(SELECT count(*)::int FROM ${users} u WHERE u.acquisition_link_id = ${acquisitionLinks.id} AND EXISTS (
          SELECT 1 FROM ${transactions} tx
          WHERE tx.user_id = u.id AND tx.direction = 'deposit' AND tx.state = 'success'
        ))`,
      })
      .from(acquisitionLinks)
      .innerJoin(admins, eq(admins.id, acquisitionLinks.ownerAdminId))
      .where(id ? eq(acquisitionLinks.id, id) : undefined)
      .orderBy(sql`${acquisitionLinks.createdAt} DESC`);
    if (rows.length === 0) return [];

    const tagRows = await db
      .select({
        linkId: acquisitionLinkTags.linkId,
        id: clientTags.id,
        slug: clientTags.slug,
        label: clientTags.label,
        color: clientTags.color,
      })
      .from(acquisitionLinkTags)
      .innerJoin(clientTags, eq(clientTags.id, acquisitionLinkTags.tagId))
      .where(
        inArray(
          acquisitionLinkTags.linkId,
          rows.map((row) => row.id),
        ),
      )
      .orderBy(asc(clientTags.label));
    const tagsByLink = new Map<string, AcquisitionLinkTag[]>();
    for (const tag of tagRows) {
      const list = tagsByLink.get(tag.linkId) ?? [];
      list.push({ id: tag.id, slug: tag.slug, label: tag.label, color: tag.color ?? undefined });
      tagsByLink.set(tag.linkId, list);
    }

    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      ownerAdminId: row.ownerAdminId,
      ownerName: row.ownerName,
      ownerActive: row.ownerStatus === 'active',
      tags: tagsByLink.get(row.id) ?? [],
      disabledAt: row.disabledAt,
      createdAt: row.createdAt,
      signups: row.signups,
      verified: row.verified,
      funded: row.funded,
    }));
  }

  /** A new link and its tags, in one transaction. */
  async create(data: {
    code: string;
    name: string;
    ownerAdminId: string;
    tagIds: readonly string[];
    createdBy: string;
  }): Promise<string> {
    return this.db.transaction(async (tx: Executor) => {
      const [row] = await tx
        .insert(acquisitionLinks)
        .values({
          code: data.code,
          name: data.name,
          ownerAdminId: data.ownerAdminId,
          createdBy: data.createdBy,
        })
        .returning({ id: acquisitionLinks.id });
      await this.replaceTags(row.id, data.tagIds, tx);
      return row.id;
    });
  }

  /** Name, owner and/or tags — the tag set replaced whole, in one transaction. */
  async update(
    id: string,
    patch: { name?: string; ownerAdminId?: string; tagIds?: readonly string[] },
  ): Promise<void> {
    await this.db.transaction(async (tx: Executor) => {
      await tx
        .update(acquisitionLinks)
        .set({
          ...(patch.name === undefined ? {} : { name: patch.name }),
          ...(patch.ownerAdminId === undefined ? {} : { ownerAdminId: patch.ownerAdminId }),
          updatedAt: new Date(),
        })
        .where(eq(acquisitionLinks.id, id));
      if (patch.tagIds !== undefined) await this.replaceTags(id, patch.tagIds, tx);
    });
  }

  async setDisabled(id: string, disabled: boolean): Promise<void> {
    await this.db
      .update(acquisitionLinks)
      .set({ disabledAt: disabled ? new Date() : null, updatedAt: new Date() })
      .where(eq(acquisitionLinks.id, id));
  }

  private async replaceTags(linkId: string, tagIds: readonly string[], tx: Executor) {
    await tx.delete(acquisitionLinkTags).where(eq(acquisitionLinkTags.linkId, linkId));
    if (tagIds.length === 0) return;
    await tx.insert(acquisitionLinkTags).values(tagIds.map((tagId) => ({ linkId, tagId })));
  }

  // ─── sign-up ──────────────────────────────────────────────────────────────

  /**
   * What a sign-up through `code` is given — or undefined when the code is
   * unknown, the link disabled, or its owner suspended. Never a refusal: a stale
   * marketing link must not cost the broker a client.
   */
  async resolveForSignup(code: string): Promise<SignupAttribution | undefined> {
    const [link] = await this.db
      .select({ id: acquisitionLinks.id, ownerAdminId: acquisitionLinks.ownerAdminId })
      .from(acquisitionLinks)
      .innerJoin(admins, eq(admins.id, acquisitionLinks.ownerAdminId))
      .where(
        and(
          eq(acquisitionLinks.code, code),
          isNull(acquisitionLinks.disabledAt),
          eq(admins.status, 'active'),
        ),
      )
      .limit(1);
    if (!link) return undefined;
    const tags = await this.db
      .select({ tagId: acquisitionLinkTags.tagId })
      .from(acquisitionLinkTags)
      .where(eq(acquisitionLinkTags.linkId, link.id));
    return { linkId: link.id, ownerAdminId: link.ownerAdminId, tagIds: tags.map((t) => t.tagId) };
  }

  /**
   * The tags a partner's clients inherit: every tag ASSIGNED to the partner's
   * own client row. Their country is theirs, not their clients' — it is
   * derived, so it is not in `client_tag_assignments` to begin with.
   */
  async partnerTagIds(ibUserId: number, executor?: Executor): Promise<string[]> {
    const rows = await (executor ?? this.db)
      .select({ tagId: clientTagAssignments.tagId })
      .from(clientTagAssignments)
      .where(eq(clientTagAssignments.userId, ibUserId));
    return rows.map((row) => row.tagId);
  }

  /** Attach tags to a client by the SYSTEM (assigned_by NULL), idempotently. */
  async attach(userId: number, tagIds: readonly string[], executor: Executor): Promise<void> {
    if (tagIds.length === 0) return;
    await executor
      .insert(clientTagAssignments)
      .values([...new Set(tagIds)].map((tagId) => ({ userId, tagId, assignedBy: null })))
      .onConflictDoNothing();
  }

  /** Which link brought a client (immutable — the column's trigger). */
  async linkOf(userId: number): Promise<string | undefined> {
    const [row] = await this.db
      .select({ linkId: users.acquisitionLinkId })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return row?.linkId ?? undefined;
  }
}
