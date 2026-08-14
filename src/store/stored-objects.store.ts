import { and, eq, isNull, sql } from 'drizzle-orm';
import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE_DB } from '../database/database.module';
import type { Db } from '../database/db';
import { storedObjects } from '../database/schema';

/**
 * The upload registry (migration 0064).
 *
 * Read the migration header for why this table exists. This class is the only
 * thing that writes it, and it is deliberately thin: the interesting decisions —
 * the ordering of bytes-then-row, the quota ceiling, what counts as a duplicate —
 * belong to `common/uploads/stored-files.service.ts`, which is where they can be
 * read alongside the upload they govern.
 */

export type StorageProvider = 'r2' | 'disk';
export type UploaderKind = 'client' | 'admin';

export interface RecordObjectInput {
  bucket: string;
  storageKey: string;
  provider: StorageProvider;
  contentType: string;
  byteSize: number;
  /** Lowercase hex. */
  sha256: string;
  originalName?: string | null;
  ownerUserId?: string | null;
  uploadedById: string;
  uploadedByKind: UploaderKind;
}

export interface StoredObjectRow {
  id: string;
  bucket: string;
  storageKey: string;
  provider: StorageProvider;
  contentType: string;
  byteSize: number;
  sha256: string;
  originalName: string | null;
  ownerUserId: string | null;
  createdAt: Date;
  deletedAt: Date | null;
}

@Injectable()
export class StoredObjectsStore {
  constructor(@Inject(DRIZZLE_DB) private readonly db: Db) {}

  /**
   * Record an object that has ALREADY been written to the store.
   *
   * Called after the bytes land, never before — see the ordering note in
   * `StoredFilesService.write`. A row pointing at bytes that were never written is
   * a lie the system would go on to serve; an object with no row is merely litter,
   * and `scripts/r2-reconcile.mjs` collects it.
   *
   * Idempotent through `stored_objects_bucket_key_uq` rather than a check-then-
   * insert (ARCHITECTURE §6.3). A replayed upload updates the existing row instead
   * of writing a second one — an overwrite at the same key genuinely is the same
   * object, and its size and checksum are the fresher truth.
   */
  async record(input: RecordObjectInput): Promise<void> {
    await this.db
      .insert(storedObjects)
      .values({
        bucket: input.bucket,
        storageKey: input.storageKey,
        provider: input.provider,
        contentType: input.contentType,
        byteSize: input.byteSize,
        sha256: input.sha256,
        originalName: input.originalName ?? null,
        ownerUserId: input.ownerUserId ?? null,
        uploadedById: input.uploadedById,
        uploadedByKind: input.uploadedByKind,
      })
      .onConflictDoUpdate({
        target: [storedObjects.bucket, storedObjects.storageKey],
        set: {
          provider: input.provider,
          contentType: input.contentType,
          byteSize: input.byteSize,
          sha256: input.sha256,
          originalName: input.originalName ?? null,
          // Revives a row whose object was deleted and then re-written at the same
          // key. Leaving it soft-deleted would hide a live object from the quota.
          deletedAt: null,
        },
      });
  }

  /**
   * How many bytes this client currently holds, across every bucket.
   *
   * Soft-deleted rows are excluded: a client who was rejected and re-uploaded has
   * not consumed quota for the document that was replaced. Backed by the partial
   * index `stored_objects_owner_live_idx`.
   */
  async liveBytesForOwner(ownerUserId: string): Promise<number> {
    const [row] = await this.db
      .select({ total: sql<string>`COALESCE(SUM(${storedObjects.byteSize}), 0)` })
      .from(storedObjects)
      .where(and(eq(storedObjects.ownerUserId, ownerUserId), isNull(storedObjects.deletedAt)));
    // A byte count, not money — §6.1's no-coercion rule is about monetary values,
    // and a file size has no fractional part to lose. `bigint` arrives as a string
    // from the driver, so it is parsed here rather than left to a caller.
    return row?.total ? Number.parseInt(row.total, 10) : 0;
  }

  /** One object by its key, or undefined. Used by the reconciliation report. */
  async findByKey(bucket: string, storageKey: string): Promise<StoredObjectRow | undefined> {
    const [row] = await this.db
      .select()
      .from(storedObjects)
      .where(and(eq(storedObjects.bucket, bucket), eq(storedObjects.storageKey, storageKey)))
      .limit(1);
    return row as StoredObjectRow | undefined;
  }

  /**
   * The owner of a document, by its bare FILENAME.
   *
   * This is the lookup that used to be an unindexed `::text ILIKE '%name%'` across
   * three JSONB columns. The route it serves takes a filename and no bucket — the
   * client-scope check in `uploads.controller.ts` has only that — so the match is
   * on the key's suffix, covered by `stored_objects_key_idx`.
   *
   * `LIKE` with a leading `%` cannot use the index for a prefix seek, but the
   * pattern is anchored to a `/` + the full filename, so it is a scan over one
   * small index rather than three JSONB blobs cast to text. Returns `undefined`
   * for anything not in the registry, and the caller falls back to the legacy
   * JSONB search for objects uploaded before this table existed.
   */
  async ownerOfFilename(filename: string): Promise<string | undefined> {
    const [row] = await this.db
      .select({ ownerUserId: storedObjects.ownerUserId })
      .from(storedObjects)
      .where(sql`${storedObjects.storageKey} LIKE ${'%/' + filename}`)
      .limit(1);
    return row?.ownerUserId ?? undefined;
  }

  /** Soft-delete: the bytes are gone, the record that they existed is not. */
  async markDeleted(bucket: string, storageKey: string): Promise<void> {
    await this.db
      .update(storedObjects)
      .set({ deletedAt: new Date() })
      .where(and(eq(storedObjects.bucket, bucket), eq(storedObjects.storageKey, storageKey)));
  }
}
