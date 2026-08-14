import type { Readable } from 'node:stream';

/**
 * The object-storage port (ARCHITECTURE §8.5, PLATFORM-CONVENTIONS R-7.3).
 *
 * Deliberately framework-free: no Nest, no Drizzle, no `fs`, no aws-sdk. Two
 * things follow from that, and both are the reason this file exists separately
 * from its implementations.
 *
 * 1. It can be satisfied by an in-memory fake, so the whole upload and download
 *    path is testable without credentials and without billing the bucket.
 * 2. Nothing above it knows the bytes live on Cloudflare R2. `StoredFilesService`
 *    is the only caller, and it speaks keys and streams.
 *
 * ## What is deliberately NOT here
 *
 * `presignedGet`. Reads are proxied through the API rather than redirected to a
 * signed URL, because the admin app's CSP is `img-src 'self' data:` and because a
 * presigned URL cannot carry `X-Content-Type-Options` or `Content-Security-Policy`
 * — see the note in `modules/compliance/uploads.controller.ts` and the recorded
 * deviation in DECISIONS. If that trade ever flips (KYC egress becoming a real
 * line item is the trigger), it is added here and the controller changes; nothing
 * else moves. Adding it before then would be an unused signing surface on the most
 * sensitive data in the system.
 */

/** Conditional and partial read options, forwarded from the browser's own headers. */
export interface StorageGetOptions {
  /**
   * A raw HTTP `Range` header value, passed through untouched.
   *
   * Load-bearing for documents: a browser PDF viewer fetches the trailer and the
   * first page by range, so a read path that ignores this forces a full transfer
   * of a 10MB scan before the first page paints.
   */
  range?: string;
  /** A raw `If-None-Match` value. A match resolves to `notModified`, with no body. */
  ifNoneMatch?: string;
}

export interface StorageObject {
  /**
   * The bytes. **Always streamed, never buffered** — one whole identity document
   * in memory per concurrent reviewer is how a review queue exhausts the heap.
   *
   * Absent when `notModified` is true, because a 304 carries no body.
   */
  stream?: Readable;
  /** Total size for a full read, or the length of the returned part for a range read. */
  contentLength?: number;
  /** Present only on a partial read, and copied straight into `Content-Range`. */
  contentRange?: string;
  etag?: string;
  /** True when `ifNoneMatch` matched: respond 304 and send nothing. */
  notModified?: boolean;
  /** True when the provider answered a range request, so the response is a 206. */
  partial?: boolean;
}

export interface StoragePutOptions {
  /**
   * The SNIFFED content type — decided from the file's own magic bytes by
   * `StoredFilesService`, never from the uploader's multipart header.
   */
  contentType: string;
  /**
   * Lowercase hex SHA-256 of the body.
   *
   * Sent to the provider as an integrity checksum where supported, so a transfer
   * corrupted in flight is refused by the store rather than accepted and served
   * later as a damaged passport scan.
   */
  sha256: string;
  cacheControl?: string;
}

export interface StorageListPage {
  objects: ReadonlyArray<{
    key: string;
    size: number;
    /** Unix ms. The reconciliation sweep uses it to skip recent uploads — see below. */
    uploadedAt: number;
  }>;
  /** Absent when the listing is exhausted. */
  nextCursor?: string;
}

export interface StorageDriver {
  readonly name: 'r2' | 'disk';

  /**
   * Write bytes at `key`, overwriting any existing object.
   *
   * The caller has already validated size and sniffed the type; this only stores.
   */
  put(key: string, body: Buffer, options: StoragePutOptions): Promise<void>;

  /**
   * Open an object for reading, or `null` if it is not there.
   *
   * `null` rather than a thrown error because "not found" is an ordinary answer on
   * this path — the caller turns it into a 404, and with dual-read it first tries
   * the other provider. Anything that is NOT a miss must throw: treating an auth
   * failure or a throttle as "no such file" would render an outage as a screen
   * telling a reviewer the client never uploaded a document.
   */
  get(key: string, options?: StorageGetOptions): Promise<StorageObject | null>;

  /**
   * Delete an object. **Never throws**, and a missing key is a no-op.
   *
   * The contract is inherited from the disk implementation and is relied upon:
   * every caller deletes AFTER the database row is already correct, precisely so a
   * failed delete leaves an orphaned object and a correct row — the recoverable
   * direction. Rethrowing here would turn that deliberate ordering into a failed
   * request, and the reconciliation sweep exists to collect what this leaves behind.
   */
  delete(key: string): Promise<void>;

  /**
   * Enumerate stored objects under a prefix, for the reconciliation sweep.
   *
   * `uploadedAt` is what makes that sweep safe. Bytes are written before the
   * `stored_objects` row is inserted, so a very recent object with no row is
   * indistinguishable from an upload still in flight — a sweep that deleted on
   * sight would destroy a document mid-upload. The caller skips anything younger
   * than its grace window.
   */
  list(prefix: string, options?: { limit?: number; cursor?: string }): Promise<StorageListPage>;

  /**
   * Is the store reachable? For the readiness probe only.
   *
   * Never per request, and cached by the caller: a health check that costs a
   * billed round-trip on every poll is a health check somebody switches off.
   */
  healthy(): Promise<boolean>;
}

/**
 * The minimum a driver needs to report something it swallowed.
 *
 * Structurally typed rather than Nest's `Logger`, so the driver files stay free of
 * the framework — that is what lets the contract spec construct them directly. The
 * shape is satisfied by a Nest `Logger`, which is what `uploads.module.ts` passes.
 */
export interface StorageLogger {
  warn(message: string): void;
}

/** DI token for the active driver. Bound in `uploads.module.ts`. */
export const STORAGE_DRIVER = Symbol('STORAGE_DRIVER');
