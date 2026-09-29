import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.module';
import type { Db } from '../database/db';
import { admins, apiKeys } from '../database/schema';
import { scopeOf, type ClientScope } from '../common/security/client-scope';

/**
 * The `api_keys` table — machine credentials for the admin API.
 *
 * ── This layer never sees a plaintext secret ───────────────────────────────
 *
 * It stores and looks up HASHES. Generating a key, hashing it, and showing the
 * plaintext once are all `api-keys.service.ts`, in the same way
 * `settings.service.ts` seals and only `SmtpConfigService` opens. Keeping the
 * generator out of the store means "what could read a live credential" is
 * answerable by finding one file rather than by auditing every caller.
 */

export interface ApiKeyRow {
  id: string;
  name: string;
  prefix: string;
  permissions: string[];
  createdBy: string | null;
  /** The creator's territory, snapshot at creation. `null`/`[]` = unrestricted. */
  scopedTagIds: string[] | null;
  /** The creator's intake grant, snapshot with the territory (D-60). */
  seesUntriaged: boolean;
  /** The creator's all-clients grant, snapshot with the territory (0154). */
  seesAllClients: boolean;
  /** The creator's effective field mask, snapshot at creation (0155). */
  maskedFields: string[];
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

/** A row plus the name of whoever created it, for the list screen. */
export interface ApiKeyListRow extends ApiKeyRow {
  createdByName: string | null;
}

export interface ApiKeyCreate {
  name: string;
  secretHash: string;
  prefix: string;
  permissions: string[];
  createdBy: string;
  /** The creator's territory, snapshot at creation — see the row comment. */
  scopedTagIds: string[] | null;
  seesUntriaged: boolean;
  seesAllClients: boolean;
  maskedFields: string[];
  expiresAt: Date | null;
}

@Injectable()
export class ApiKeysStore {
  constructor(@Inject(DRIZZLE_DB) private readonly db: Db) {}

  /**
   * Narrow every live key an administrator created to what they may see NOW.
   *
   * A key is a snapshot of its creator's sight, taken when it was minted. When
   * the creator is later narrowed — fewer tags, no longer every client, a
   * stricter mask — each key is clamped to the intersection of what it had and
   * the creator's new ceiling. Never widened: an administrator gaining sight
   * does not quietly hand it to keys minted before.
   *
   * @returns how many keys were rewritten.
   */
  async clampToCreator(
    adminId: string,
    ceiling: ClientScope,
    mask: readonly string[],
  ): Promise<number> {
    const keys = await this.db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.createdBy, adminId), isNull(apiKeys.revokedAt)));
    for (const key of keys) {
      const own = scopeOf(key.scopedTagIds ?? [], key.seesUntriaged, key.seesAllClients);
      const seesAll = own.unrestricted && ceiling.unrestricted;
      const ownTags = own.unrestricted ? [...ceiling.tagIds] : [...own.tagIds];
      const allowedTags = ceiling.unrestricted ? ownTags : ceiling.tagIds;
      const tags = seesAll ? null : ownTags.filter((tagId) => allowedTags.includes(tagId));
      const intake =
        (own.unrestricted || own.includesUntriaged === true) &&
        (ceiling.unrestricted || ceiling.includesUntriaged === true);
      await this.db
        .update(apiKeys)
        .set({
          seesAllClients: seesAll,
          scopedTagIds: tags,
          seesUntriaged: intake,
          maskedFields: [...new Set([...(key.maskedFields ?? []), ...mask])],
        })
        .where(eq(apiKeys.id, key.id));
    }
    return keys.length;
  }

  /**
   * The authentication path: a hash to the row it belongs to.
   *
   * Filters `revoked_at IS NULL` in SQL rather than in the caller, so the query
   * matches `api_keys_active_idx` — the partial index exists for exactly this
   * lookup. EXPIRY is deliberately NOT filtered here: the caller distinguishes
   * "no such key" from "expired key" to answer the second one usefully, and a
   * row filtered away in SQL cannot be told apart from one that never existed.
   */
  async findActiveByHash(secretHash: string): Promise<ApiKeyRow | null> {
    const [row] = await this.db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.secretHash, secretHash), isNull(apiKeys.revokedAt)))
      .limit(1);
    return row ?? null;
  }

  /**
   * Note that a key was used — best effort, and throttled to once an hour.
   *
   * The throttle is the whole design. An UPDATE on every authenticated request
   * would put a write on the hot path of a read-only integration and make the
   * row a contention point under any real traffic. "Used within the last hour"
   * answers the question an operator actually asks — is anything still using
   * this key — and costs a write per key per hour instead of per request.
   *
   * Fire-and-forget at the call site: a failed timestamp must never fail the
   * request it was describing.
   */
  async touchLastUsed(id: string): Promise<void> {
    await this.db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(
        and(
          eq(apiKeys.id, id),
          // Only when it is stale, so concurrent requests do not all queue to
          // write the same value.
          sql`(${apiKeys.lastUsedAt} IS NULL OR ${apiKeys.lastUsedAt} < now() - interval '1 hour')`,
        ),
      );
  }

  async create(values: ApiKeyCreate): Promise<ApiKeyRow> {
    const [row] = await this.db.insert(apiKeys).values(values).returning();
    return row;
  }

  /**
   * Every key, newest first, INCLUDING revoked and expired ones.
   *
   * Revoked keys stay visible on purpose: "this key was revoked last Tuesday"
   * is what an operator investigating an incident needs, and hiding the row
   * would make a key that is still quoted in somebody's config look like one
   * that never existed.
   */
  async list(): Promise<ApiKeyListRow[]> {
    const rows = await this.db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        prefix: apiKeys.prefix,
        permissions: apiKeys.permissions,
        createdBy: apiKeys.createdBy,
        scopedTagIds: apiKeys.scopedTagIds,
        seesUntriaged: apiKeys.seesUntriaged,
        seesAllClients: apiKeys.seesAllClients,
        maskedFields: apiKeys.maskedFields,
        expiresAt: apiKeys.expiresAt,
        revokedAt: apiKeys.revokedAt,
        lastUsedAt: apiKeys.lastUsedAt,
        createdAt: apiKeys.createdAt,
        createdByName: admins.name,
      })
      .from(apiKeys)
      .leftJoin(admins, eq(apiKeys.createdBy, admins.id))
      .orderBy(desc(apiKeys.createdAt));
    return rows;
  }

  async findById(id: string): Promise<ApiKeyRow | null> {
    const [row] = await this.db.select().from(apiKeys).where(eq(apiKeys.id, id)).limit(1);
    return row ?? null;
  }

  /**
   * Revoke, and report whether this call is what revoked it.
   *
   * `revoked_at IS NULL` in the WHERE makes the write idempotent AND makes the
   * returned row mean something: two concurrent revocations both succeed, but
   * only the first gets a row back, so the caller can decide once whether to
   * write an audit entry. Checking first and then updating would let both write
   * one, for a single change.
   */
  async revoke(id: string): Promise<ApiKeyRow | null> {
    const [row] = await this.db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)))
      .returning();
    return row ?? null;
  }

  /**
   * Revoke every live key one administrator minted, and say how many.
   *
   * Suspension is "we are taking this person's access away NOW"
   * (`admin-rbac.service.ts`), and a key they issued carries THEIR permissions
   * and THEIR territory — snapshotted onto the row, so it keeps working with
   * their authority after their sessions are gone. Ending the sessions and
   * leaving the keys takes away the screen and not the access.
   *
   * Scoped to `created_by` rather than to every key, because the keys another
   * administrator minted are not this person's to lose.
   *
   * ⚠️ This does NOT run on deletion, and must not be made to. `admin.guard.ts`
   * is explicit that a key holds a snapshot rather than a live join to its
   * creator precisely so it "neither drifts with the creator's scope nor breaks
   * when they are deleted" — and `created_by` is `set null` there, so after a
   * delete there is nothing to match on anyway. Suspension is the case that
   * reasoning never covered: a decision about the person, made while the link
   * still exists.
   *
   * Same idempotent shape as `revoke`: `revoked_at IS NULL` in the WHERE means a
   * second suspension revokes nothing and reports 0, rather than restamping keys
   * that were already dead and overstating what this call did.
   */
  async revokeAllCreatedBy(adminId: string): Promise<number> {
    const rows = await this.db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiKeys.createdBy, adminId), isNull(apiKeys.revokedAt)))
      .returning({ id: apiKeys.id });
    return rows.length;
  }
}
