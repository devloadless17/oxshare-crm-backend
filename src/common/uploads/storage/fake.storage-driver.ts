import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { etagFor, matchesEtag, parseRange } from './http-range';
import type {
  StorageDriver,
  StorageGetOptions,
  StorageListPage,
  StorageObject,
  StoragePutOptions,
} from './storage-driver';

/**
 * An in-memory store, for tests.
 *
 * It reports `name: 'disk'` rather than inventing a third provider value. That is
 * deliberate: `stored_objects.provider` is written from `driver.name` and is
 * constrained to the two real providers, so a `'fake'` would either need a third
 * enum value that means nothing in production or would make every registry
 * assertion in the suite exercise a value no deployment can produce.
 *
 * ## Why this shares `http-range.ts` with the disk driver
 *
 * Because one contract spec runs against this, the disk driver, and — when
 * `R2_LIVE_TEST=1` — the real R2 driver. The point of a fake is that passing
 * against it means something, and that only holds while its range and conditional
 * semantics are the same code as the real ones rather than a second reading of the
 * same RFC.
 */
export class FakeStorageDriver implements StorageDriver {
  readonly name = 'disk' as const;

  private readonly objects = new Map<
    string,
    { body: Buffer; contentType: string; sha256: string; uploadedAt: number }
  >();

  /**
   * Counts every call, so a test can assert that dual-read fell back rather than
   * merely that it produced the right bytes — those look identical from outside.
   */
  readonly calls = { put: 0, get: 0, delete: 0, list: 0 };

  /** Set to make the next operation throw, for the "R2 is down" cases. */
  failWith: Error | null = null;

  private clock = 1_700_000_000_000;

  put(key: string, body: Buffer, options: StoragePutOptions): Promise<void> {
    this.calls.put += 1;
    if (this.failWith) return Promise.reject(this.failWith);

    /*
     * The checksum is VERIFIED here, not merely stored.
     *
     * R2 rejects a `ChecksumSHA256` that does not match the body, so a caller that
     * computes the digest over the wrong buffer fails against the real store and
     * would pass against a fake that only recorded what it was told. Checking makes
     * the fake fail the same way.
     */
    const actual = createHash('sha256').update(body).digest('hex');
    if (actual !== options.sha256) {
      return Promise.reject(
        new Error(`checksum mismatch: declared ${options.sha256}, body is ${actual}`),
      );
    }

    this.clock += 1000;
    this.objects.set(key, {
      body: Buffer.from(body),
      contentType: options.contentType,
      sha256: options.sha256,
      uploadedAt: this.clock,
    });
    return Promise.resolve();
  }

  get(key: string, options?: StorageGetOptions): Promise<StorageObject | null> {
    this.calls.get += 1;
    if (this.failWith) return Promise.reject(this.failWith);

    const found = this.objects.get(key);
    if (!found) return Promise.resolve(null);

    const size = found.body.length;
    const etag = etagFor(size, found.uploadedAt);

    if (options?.ifNoneMatch && matchesEtag(options.ifNoneMatch, etag)) {
      return Promise.resolve({ notModified: true, etag });
    }

    if (options?.range) {
      const range = parseRange(options.range, size);
      if (range === 'unsatisfiable') return Promise.resolve(null);
      if (range) {
        return Promise.resolve({
          stream: Readable.from(found.body.subarray(range.start, range.end + 1)),
          contentLength: range.end - range.start + 1,
          contentRange: `bytes ${range.start}-${range.end}/${size}`,
          etag,
          partial: true,
        });
      }
    }

    return Promise.resolve({
      stream: Readable.from(found.body),
      contentLength: size,
      etag,
    });
  }

  /** Never throws, even when `failWith` is set — that is the port's contract. */
  delete(key: string): Promise<void> {
    this.calls.delete += 1;
    this.objects.delete(key);
    return Promise.resolve();
  }

  list(prefix: string, options?: { limit?: number; cursor?: string }): Promise<StorageListPage> {
    this.calls.list += 1;
    if (this.failWith) return Promise.reject(this.failWith);

    const all = [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix) && (!options?.cursor || key > options.cursor))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

    const limit = options?.limit ?? 1000;
    const page = all.slice(0, limit);
    return Promise.resolve({
      objects: page.map(([key, o]) => ({
        key,
        size: o.body.length,
        uploadedAt: o.uploadedAt,
      })),
      ...(all.length > page.length ? { nextCursor: page[page.length - 1][0] } : {}),
    });
  }

  healthy(): Promise<boolean> {
    return Promise.resolve(!this.failWith);
  }

  // ── Test affordances ──────────────────────────────────────────────────────

  /** The raw bytes at a key, for asserting what was actually stored. */
  peek(key: string): Buffer | undefined {
    return this.objects.get(key)?.body;
  }

  has(key: string): boolean {
    return this.objects.has(key);
  }

  get size(): number {
    return this.objects.size;
  }

  reset(): void {
    this.objects.clear();
    this.calls.put = 0;
    this.calls.get = 0;
    this.calls.delete = 0;
    this.calls.list = 0;
    this.failWith = null;
  }
}
