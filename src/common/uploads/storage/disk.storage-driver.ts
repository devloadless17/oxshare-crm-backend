import { createReadStream } from 'node:fs';
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import { etagFor, matchesEtag, parseRange } from './http-range';
import type {
  StorageDriver,
  StorageLogger,
  StorageGetOptions,
  StorageListPage,
  StorageObject,
  StoragePutOptions,
} from './storage-driver';

/**
 * The local filesystem, under `./uploads/<key>`.
 *
 * This is what the system did before object storage, kept for two jobs:
 *
 *  1. **Offline development and the test suite.** Selected by `STORAGE_DRIVER=disk`,
 *     which `env.validation.ts` refuses in production. It is an explicit opt-in and
 *     never a fallback — a store that silently degrades to somewhere else is how
 *     writes go missing with nothing reporting it.
 *  2. **Dual-read of legacy files.** Documents uploaded before the R2 move are still
 *     on the API host's disk, and `StoredFilesService` falls back to this driver on
 *     an R2 miss so those keep opening. There is no backfill migration.
 *
 * It implements `Range` and `If-None-Match` even though nothing on disk needs them,
 * because one shared contract spec runs against both drivers. A fake that behaves
 * differently from the real thing is worse than no fake at all — and the legacy-read
 * path means this driver really does serve documents to a browser PDF viewer.
 */

export class DiskStorageDriver implements StorageDriver {
  readonly name = 'disk' as const;

  /** Everything lives under `<root>/<key>`; the key already carries the bucket dir. */
  constructor(
    private readonly root: string,
    private readonly logger: StorageLogger = { warn: () => {} },
  ) {}

  private pathFor(key: string): string {
    return join(this.root, ...key.split('/'));
  }

  async put(key: string, body: Buffer, _options: StoragePutOptions): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
  }

  async get(key: string, options?: StorageGetOptions): Promise<StorageObject | null> {
    const path = this.pathFor(key);

    let size: number;
    let mtimeMs: number;
    try {
      const info = await stat(path);
      if (!info.isFile()) return null;
      size = info.size;
      mtimeMs = info.mtimeMs;
    } catch {
      // Missing file, missing directory, or a path that is not readable. All of
      // them are "not here" to a caller that is about to choose 404 or fall back.
      return null;
    }

    const etag = etagFor(size, mtimeMs);
    if (options?.ifNoneMatch && matchesEtag(options.ifNoneMatch, etag)) {
      return { notModified: true, etag };
    }

    if (options?.range) {
      const range = parseRange(options.range, size);
      if (range === 'unsatisfiable') {
        // Signalled as a miss rather than a partial: the caller turns an absent
        // object into a 404, and an unsatisfiable range on a file that exists is a
        // client error either way. Kept simple deliberately — no production read
        // path issues one, and inventing a 416 channel for it would be untested code.
        return null;
      }
      if (range) {
        return {
          stream: createReadStream(path, { start: range.start, end: range.end }),
          contentLength: range.end - range.start + 1,
          contentRange: `bytes ${range.start}-${range.end}/${size}`,
          etag,
          partial: true,
        };
      }
    }

    return { stream: createReadStream(path), contentLength: size, etag };
  }

  /** Never throws — see the port's contract. */
  async delete(key: string): Promise<void> {
    try {
      await unlink(this.pathFor(key));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // ENOENT is normal: the file may already be gone, or never have existed.
      if (!reason.includes('ENOENT')) {
        this.logger.warn(
          JSON.stringify({
            event: 'storage.delete_failed',
            severity: 'warn',
            provider: 'disk',
            key,
            message: reason,
          }),
        );
      }
    }
  }

  /**
   * One directory listing, sorted by key so paging is stable.
   *
   * The cursor is the last key of the previous page rather than an opaque token,
   * which is all a filesystem can offer and is enough for the reconciliation sweep.
   * Not recursive: keys are one level deep by construction (`<dir>/<uuid>.<ext>`).
   */
  async list(
    prefix: string,
    options?: { limit?: number; cursor?: string },
  ): Promise<StorageListPage> {
    const dir = prefix.replace(/\/+$/, '');
    let names: string[];
    try {
      names = await readdir(this.pathFor(dir));
    } catch {
      return { objects: [] };
    }

    const limit = options?.limit ?? 1000;
    const sorted = names
      .map((name) => `${dir}/${name}`)
      .filter((key) => key.startsWith(prefix) && (!options?.cursor || key > options.cursor))
      .sort();

    const page = sorted.slice(0, limit);
    const objects = [];
    for (const key of page) {
      try {
        const info = await stat(this.pathFor(key));
        if (info.isFile()) objects.push({ key, size: info.size, uploadedAt: info.mtimeMs });
      } catch {
        // Raced with a delete between readdir and stat. Skip it.
      }
    }

    return {
      objects,
      ...(sorted.length > page.length ? { nextCursor: page[page.length - 1] } : {}),
    };
  }

  /** The root has to exist and be writable; creating it is the cheapest proof. */
  async healthy(): Promise<boolean> {
    try {
      await mkdir(this.root, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  /** Exposed for the reconciliation script, which reports a filesystem path. */
  get rootPath(): string {
    return this.root + sep;
  }
}
