import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.module';
import type { Db } from '../database/db';
import { admins, apiKeys } from '../database/schema';

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
  expiresAt: Date | null;
}

@Injectable()
export class ApiKeysStore {
  constructor(@Inject(DRIZZLE_DB) private readonly db: Db) {}

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
}
