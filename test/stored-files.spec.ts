import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FakeStorageDriver } from '../src/common/uploads/storage/fake.storage-driver';
import {
  AVATAR_BUCKET,
  KYC_BUCKET,
  OWNER_STORAGE_QUOTA_BYTES,
  PAYMENT_LOGO_BUCKET,
  StoredFilesService,
} from '../src/common/uploads/stored-files.service';
import { QuotaExceededError } from '../src/common/errors/domain-errors';
import type { StoredObjectsStore } from '../src/store/stored-objects.store';
import { storageStub, storedObjectsStub } from './storage-stub';

/**
 * The upload rules that came with object storage.
 *
 * The magic-byte and size rules are covered by `payment-logo-upload.spec.ts`, which
 * predates this. What is asserted here is what the R2 move ADDED: the storage quota,
 * the dual-read fallback for documents that predate the move, and the ordering that
 * makes a failed registry write recoverable.
 */

/** A real 1x1 PNG — the smallest thing the sniffer accepts. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

/** The fake driver VERIFIES this, exactly as R2 does — see FakeStorageDriver.put. */
const PNG_SHA256 = createHash('sha256').update(PNG).digest('hex');

const CLIENT = '11111111-1111-4111-8111-111111111111';
const clientUploader = { id: CLIENT, kind: 'client' as const, ownerUserId: CLIENT };

describe('the storage quota', () => {
  it('accepts an upload that fits', async () => {
    const { files, registry } = storageStub();
    registry.setLiveBytes(OWNER_STORAGE_QUOTA_BYTES - PNG.length);

    await expect(
      files.write(AVATAR_BUCKET, PNG, 'image/png', clientUploader),
    ).resolves.toMatchObject({ mimeType: 'image/png' });
  });

  it('refuses the upload that would cross the ceiling', async () => {
    const { files, registry, driver } = storageStub();
    registry.setLiveBytes(OWNER_STORAGE_QUOTA_BYTES);

    await expect(files.write(AVATAR_BUCKET, PNG, 'image/png', clientUploader)).rejects.toThrow(
      QuotaExceededError,
    );
    // Refused BEFORE anything is stored: a rejection that still wrote bytes would
    // grow the very number it just refused.
    expect(driver.size).toBe(0);
  });

  it('says what was used and what the limit is, so the message is actionable', async () => {
    const { files, registry } = storageStub();
    registry.setLiveBytes(OWNER_STORAGE_QUOTA_BYTES);

    await expect(files.write(KYC_BUCKET, PNG, 'image/png', clientUploader)).rejects.toThrow(
      /50MB|allowance/,
    );
  });

  /*
   * A brand mark belongs to nobody, so it counts against nobody.
   *
   * The quota exists to bound what an untrusted uploader can cost us; the admin
   * console is not that, and an admin id is not even in `users` — attributing a logo
   * to the uploading admin would violate `stored_objects.owner_user_id`'s foreign key.
   */
  it('does not apply to a bucket that belongs to no client', async () => {
    const { files, registry } = storageStub();
    registry.setLiveBytes(OWNER_STORAGE_QUOTA_BYTES * 10);

    await expect(
      files.write(PAYMENT_LOGO_BUCKET, PNG, 'image/png', {
        id: '22222222-2222-4222-8222-222222222222',
        kind: 'admin',
        ownerUserId: null,
      }),
    ).resolves.toBeTruthy();
  });
});

describe('the registry write', () => {
  /*
   * Bytes first, row second — and if the row fails, the bytes go.
   *
   * The ordering is deliberate (a row pointing at bytes that were never written is a
   * claim the system would act on), and this is the half that keeps it honest: an
   * object nothing references can never be served, reviewed, or deleted on request.
   */
  it('removes the object when the registry insert fails', async () => {
    const driver = new FakeStorageDriver();
    const legacy = new FakeStorageDriver();
    const registry = {
      ...storedObjectsStub(),
      record: () => Promise.reject(new Error('registry is down')),
    };
    const files = new StoredFilesService(driver, legacy, registry as unknown as StoredObjectsStore);

    await expect(files.write(AVATAR_BUCKET, PNG, 'image/png', clientUploader)).rejects.toThrow(
      'registry is down',
    );

    expect(driver.size).toBe(0);
  });

  it('records the sniffed type and the checksum of the stored bytes', async () => {
    const { files, registry } = storageStub();
    const stored = await files.write(AVATAR_BUCKET, PNG, 'image/png', clientUploader);

    expect(registry.recorded).toHaveLength(1);
    expect(registry.recorded[0]).toMatchObject({
      bucket: 'avatars',
      storageKey: `avatars/${stored.filename}`,
      contentType: 'image/png',
      byteSize: PNG.length,
      sha256: stored.sha256,
      ownerUserId: CLIENT,
      uploadedByKind: 'client',
    });
  });
});

describe('dual-read of documents that predate object storage', () => {
  /**
   * An active driver that reports `'r2'`, so the legacy fallback is reachable.
   *
   * `FakeStorageDriver` reports `'disk'` (it stands in for a real provider value, and
   * a third one would mean nothing in production), and `read` short-circuits the
   * fallback when the active driver IS disk — the two would be the same store, so a
   * second look is just a second miss. This overrides the name to exercise the
   * production shape.
   */
  function r2Shaped() {
    const active = new FakeStorageDriver();
    Object.defineProperty(active, 'name', { value: 'r2' });
    const legacy = new FakeStorageDriver();
    const files = new StoredFilesService(
      active,
      legacy,
      storedObjectsStub() as unknown as StoredObjectsStore,
    );
    return { files, active, legacy };
  }

  it('falls back to the legacy disk store when the object storage misses', async () => {
    const { files, legacy } = r2Shaped();
    // A document written before the move: on disk, not in the bucket.
    await legacy.put('kyc/legacy.png', PNG, {
      contentType: 'image/png',
      sha256: PNG_SHA256,
    });

    const found = await files.read(KYC_BUCKET, 'legacy.png');
    expect(found).not.toBeNull();
    expect(found?.contentLength).toBe(PNG.length);
  });

  it('does not consult the legacy store when the active one answers', async () => {
    const { files, active, legacy } = r2Shaped();
    await active.put('kyc/current.png', PNG, {
      contentType: 'image/png',
      sha256: PNG_SHA256,
    });

    const before = legacy.calls.get;
    await files.read(KYC_BUCKET, 'current.png');
    expect(legacy.calls.get).toBe(before);
  });

  it('returns null when neither store has it', async () => {
    const { files } = r2Shaped();
    await expect(files.read(KYC_BUCKET, 'nowhere.png')).resolves.toBeNull();
  });

  /*
   * An unsafe name is a 404, not a crash.
   *
   * `objectKey` throws rather than building a key from `..` or a dotfile; `read`
   * catches that and answers null, because the caller is about to return 404 and
   * that is the right answer for a name we refuse to look up.
   */
  it('answers null for a name it refuses to build a key from', async () => {
    const { files } = r2Shaped();
    await expect(files.read(KYC_BUCKET, '..')).resolves.toBeNull();
    await expect(files.read(KYC_BUCKET, '.hidden')).resolves.toBeNull();
  });
});

describe('remove', () => {
  it('deletes from both stores and soft-deletes the registry row', async () => {
    const { files, registry, driver } = storageStub();
    const stored = await files.write(AVATAR_BUCKET, PNG, 'image/png', clientUploader);

    await files.remove(AVATAR_BUCKET, stored.filename);

    expect(driver.has(`avatars/${stored.filename}`)).toBe(false);
    expect(registry.deleted).toContainEqual({
      bucket: 'avatars',
      storageKey: `avatars/${stored.filename}`,
    });
  });

  /*
   * Never throws — every caller deletes AFTER its row is already correct, precisely
   * so a failed delete leaves an orphan and a correct row rather than a failed
   * request. The reconciliation sweep collects what this leaves behind.
   */
  it('is a no-op for an absent or unset filename', async () => {
    const { files } = storageStub();
    await expect(files.remove(AVATAR_BUCKET, null)).resolves.toBeUndefined();
    await expect(files.remove(AVATAR_BUCKET, undefined)).resolves.toBeUndefined();
    await expect(files.remove(AVATAR_BUCKET, 'never-existed.png')).resolves.toBeUndefined();
  });
});
