import { FakeStorageDriver } from '../src/common/uploads/storage/fake.storage-driver';
import { StoredFilesService } from '../src/common/uploads/stored-files.service';
import type { RecordObjectInput, StoredObjectsStore } from '../src/store/stored-objects.store';

/**
 * A `StoredFilesService` backed entirely by memory, for the unit suites.
 *
 * Those suites construct their service directly rather than through Nest, so they
 * have to supply its collaborators themselves. Two are supplied here:
 *
 *  - a `FakeStorageDriver`, so nothing touches the filesystem or Cloudflare R2.
 *    **No test may ever reach the real bucket** — it would need credentials CI does
 *    not have, and it would bill a live account on every run.
 *  - a recording stand-in for `StoredObjectsStore`, because a real one needs a
 *    database and these suites are asserting the upload RULES (magic-byte sniffing,
 *    the size ceiling, the quota) rather than the registry's SQL.
 *
 * Where the registry's own behaviour is what matters — the unique constraint
 * absorbing a replay, the partial index behind the quota query — that is asserted
 * against real Postgres via Testcontainers, which is the only form of the question a
 * stub cannot answer.
 */

/**
 * An in-memory `StoredObjectsStore`.
 *
 * `liveBytes` is settable so a quota test can state the starting position it is
 * asserting about, rather than uploading 50MB to get there.
 */
export function storedObjectsStub() {
  const recorded: RecordObjectInput[] = [];
  const deleted: Array<{ bucket: string; storageKey: string }> = [];
  let liveBytes = 0;

  return {
    recorded,
    deleted,
    /** Pretend this owner already holds N bytes. */
    setLiveBytes(bytes: number) {
      liveBytes = bytes;
    },
    record(input: RecordObjectInput) {
      recorded.push(input);
      return Promise.resolve();
    },
    liveBytesForOwner() {
      return Promise.resolve(liveBytes);
    },
    findByKey() {
      return Promise.resolve(undefined);
    },
    ownerOfFilename() {
      return Promise.resolve(undefined);
    },
    markDeleted(bucket: string, storageKey: string) {
      deleted.push({ bucket, storageKey });
      return Promise.resolve();
    },
  };
}

export type StoredObjectsStub = ReturnType<typeof storedObjectsStub>;

export interface StorageStub {
  files: StoredFilesService;
  /** The active store — assert on `peek`, `has`, `size`, and the `calls` counters. */
  driver: FakeStorageDriver;
  /** The legacy-disk fallback, so a dual-read test can seed only the old store. */
  legacy: FakeStorageDriver;
  registry: StoredObjectsStub;
}

/**
 * Build a fully in-memory `StoredFilesService`.
 *
 * The active driver reports `name: 'disk'` (see `FakeStorageDriver`), which means
 * `read` short-circuits the legacy fallback exactly as it does when a deployment
 * genuinely runs on disk. A dual-read test wanting the fallback path must therefore
 * exercise it through `legacy` directly, or stand the service up with an active
 * driver that reports `'r2'`.
 */
export function storageStub(): StorageStub {
  const driver = new FakeStorageDriver();
  const legacy = new FakeStorageDriver();
  const registry = storedObjectsStub();
  const files = new StoredFilesService(driver, legacy, registry as unknown as StoredObjectsStore);
  return { files, driver, legacy, registry };
}

/** Just the service, for suites that only need it to be callable. */
export function storedFilesStub(): StoredFilesService {
  return storageStub().files;
}
