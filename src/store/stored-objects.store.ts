import { and, eq, isNull, sql } from 'drizzle-orm';
import { Inject, Injectable } from '@nestjs/common';
import { DRIZZLE_DB } from '../database/database.module';
import type { Db } from '../database/db';
import { clientDocumentPages, clientDocuments, storedObjects } from '../database/schema';

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
  ownerUserId?: number | null;
  /** An admin's uuid, or a client's Portal ID — stored as text (0159). */
  uploadedById: string | number;
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
  ownerUserId: number | null;
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
        uploadedById: String(input.uploadedById),
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
   * How many bytes count against this client's allowance, across every bucket.
   *
   * Soft-deleted rows are excluded: a client who was rejected and re-uploaded has
   * not consumed quota for the document that was replaced. Backed by the partial
   * index `stored_objects_owner_live_idx`.
   *
   * EVIDENCE is excluded too: a page of a FROZEN version of the client's identity
   * record (0151) — something they presented for review. The record keeps it for
   * ever and nobody can delete it, least of all the client, so counting it meant
   * every round of KYC permanently shrank the room for the next: a client
   * returned twice for a blurred 9MB scan could be refused the upload that would
   * finally have passed, with nothing they could remove to make space. What still
   * counts is what the client CAN remove — drafts, and anything no version holds.
   * Matched by the page's key, which is the registry key under `uploads/` (0151's
   * one spelling).
   */
  async liveBytesForOwner(ownerUserId: number): Promise<number> {
    const [row] = await this.db
      .select({ total: sql<string>`COALESCE(SUM(${storedObjects.byteSize}), 0)` })
      .from(storedObjects)
      .where(
        and(
          eq(storedObjects.ownerUserId, ownerUserId),
          isNull(storedObjects.deletedAt),
          sql`NOT EXISTS (
                SELECT 1 FROM ${clientDocumentPages}
                  JOIN ${clientDocuments} ON ${clientDocuments.id} = ${clientDocumentPages.documentId}
                 WHERE ${clientDocumentPages.storageKey} = 'uploads/' || ${storedObjects.storageKey}
                   AND ${clientDocuments.userId} = ${storedObjects.ownerUserId}
                   AND ${clientDocuments.frozenAt} IS NOT NULL)`,
        ),
      );
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

  /** Soft-delete: the bytes are gone, the record that they existed is not. */
  async markDeleted(bucket: string, storageKey: string): Promise<void> {
    await this.db
      .update(storedObjects)
      .set({ deletedAt: new Date() })
      .where(and(eq(storedObjects.bucket, bucket), eq(storedObjects.storageKey, storageKey)));
  }
}
