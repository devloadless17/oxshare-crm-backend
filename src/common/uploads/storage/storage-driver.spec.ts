import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { DiskStorageDriver } from './disk.storage-driver';
import { FakeStorageDriver } from './fake.storage-driver';
import { R2StorageDriver } from './r2.storage-driver';
import type { StorageDriver } from './storage-driver';

/**
 * ONE contract, run against EVERY driver.
 *
 * ── Why it is shaped this way ───────────────────────────────────────────────
 *
 * The whole upload and download path is tested against a fake, so the suite needs no
 * credentials and never bills the bucket. That is only worth anything while the fake
 * behaves like the real store — and the places they can quietly diverge are exactly
 * the places that matter: suffix ranges, conditional reads, whether a miss throws or
 * returns null.
 *
 * So the assertions live in one function and every driver is put through it. A fake
 * that drifts fails here rather than in production.
 *
 * ── The R2 arm is OFF by default ────────────────────────────────────────────
 *
 * `R2_LIVE_TEST=1` opts in, and nothing in CI sets it. Run it by hand after changing
 * the driver or upgrading the aws-sdk:
 *
 *   R2_LIVE_TEST=1 npx vitest run src/common/uploads/storage/storage-driver.spec.ts
 *
 * It writes under a `__contract-test/` prefix and deletes everything it wrote.
 * `npm run r2:verify` is the lighter check for "are the credentials right"; this one
 * is for "does the driver still hold up its end".
 */

const PAYLOAD = Buffer.from('the quick brown fox jumps over the lazy dog. '.repeat(20));
const SHA256 = createHash('sha256').update(PAYLOAD).digest('hex');

async function collect(stream: Readable | undefined): Promise<Buffer> {
  if (!stream) throw new Error('expected a stream');
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

/**
 * The contract every driver must satisfy.
 *
 * `prefix` keeps concurrent arms from colliding, and matters for the live R2 arm in
 * particular — a shared key would make two runs of this file interfere.
 */
function describeDriverContract(name: string, makeDriver: () => StorageDriver, prefix: string) {
  describe(`${name} driver`, () => {
    let driver: StorageDriver;
    const written: string[] = [];

    const keyFor = (suffix: string) => `${prefix}/${randomUUID()}-${suffix}`;
    const put = async (suffix = 'obj', body = PAYLOAD) => {
      const key = keyFor(suffix);
      const sha = createHash('sha256').update(body).digest('hex');
      await driver.put(key, body, { contentType: 'application/octet-stream', sha256: sha });
      written.push(key);
      return key;
    };

    beforeEach(() => {
      driver = makeDriver();
    });

    afterAll(async () => {
      // Leave nothing behind, especially on the live arm.
      for (const key of written) await driver.delete(key);
    });

    it('stores bytes and reads back exactly what was written', async () => {
      const key = await put('roundtrip');
      const got = await driver.get(key);

      expect(got).not.toBeNull();
      expect(got?.contentLength).toBe(PAYLOAD.length);
      const body = await collect(got?.stream);
      expect(createHash('sha256').update(body).digest('hex')).toBe(SHA256);
    });

    /*
     * `null`, never a throw, and this is load-bearing.
     *
     * `StoredFilesService.read` distinguishes "not here" from "the store is broken":
     * a miss falls through to the legacy disk store, while a real failure must
     * propagate. A driver that threw on a miss would turn every legacy document into
     * a 500, and a driver that swallowed a real error would render an outage as a
     * screen saying the client never uploaded anything.
     */
    it('answers a missing key with null rather than throwing', async () => {
      await expect(driver.get(`${prefix}/definitely-not-here-${randomUUID()}`)).resolves.toBeNull();
    });

    it('serves a closed range as a partial read', async () => {
      const key = await put('range');
      const got = await driver.get(key, { range: 'bytes=0-99' });

      expect(got?.partial).toBe(true);
      expect(got?.contentLength).toBe(100);
      expect(got?.contentRange).toBe(`bytes 0-99/${PAYLOAD.length}`);
      expect(await collect(got?.stream)).toEqual(PAYLOAD.subarray(0, 100));
    });

    /*
     * ⚠️ The suffix range — the FIRST thing a PDF viewer asks for, and the one a
     * hand-rolled parser gets backwards. `bytes=-64` is the last 64 bytes.
     */
    it('serves a suffix range as the LAST n bytes', async () => {
      const key = await put('suffix');
      const got = await driver.get(key, { range: 'bytes=-64' });

      expect(got?.partial).toBe(true);
      expect(await collect(got?.stream)).toEqual(PAYLOAD.subarray(PAYLOAD.length - 64));
    });

    it('serves an open-ended range to the end of the object', async () => {
      const key = await put('open');
      const got = await driver.get(key, { range: `bytes=${PAYLOAD.length - 10}-` });

      expect(got?.contentLength).toBe(10);
      expect(await collect(got?.stream)).toEqual(PAYLOAD.subarray(PAYLOAD.length - 10));
    });

    /*
     * A 304 is a SUCCESS with no body. R2 raises it as a thrown error, which the
     * driver catches and converts — miss that and a working cache hit becomes a 500.
     */
    it('reports a matching If-None-Match as notModified, with no body', async () => {
      const key = await put('conditional');
      const first = await driver.get(key);
      expect(first?.etag).toBeTruthy();
      // Drain the first response so the live arm does not leak a socket.
      await collect(first?.stream);

      const second = await driver.get(key, { ifNoneMatch: first?.etag });
      expect(second?.notModified).toBe(true);
      expect(second?.stream).toBeUndefined();
    });

    it('serves the body when If-None-Match does not match', async () => {
      const key = await put('stale');
      const got = await driver.get(key, { ifNoneMatch: '"not-the-current-etag"' });

      expect(got?.notModified).toBeFalsy();
      expect(await collect(got?.stream)).toEqual(PAYLOAD);
    });

    it('overwrites in place at the same key', async () => {
      const key = await put('overwrite');
      const replacement = Buffer.from('replaced');
      await driver.put(key, replacement, {
        contentType: 'application/octet-stream',
        sha256: createHash('sha256').update(replacement).digest('hex'),
      });

      expect(await collect((await driver.get(key))?.stream)).toEqual(replacement);
    });

    it('deletes, and deleting again is a no-op rather than an error', async () => {
      const key = await put('delete');
      await driver.delete(key);
      await expect(driver.get(key)).resolves.toBeNull();

      // Never throws — every caller deletes AFTER its row is already correct, so a
      // failed delete must leave an orphan rather than fail the request.
      await expect(driver.delete(key)).resolves.toBeUndefined();
      await expect(driver.delete(`${prefix}/never-existed`)).resolves.toBeUndefined();
    });

    it('lists what it stored', async () => {
      const key = await put('listed');
      const page = await driver.list(`${prefix}/`);

      const found = page.objects.find((o) => o.key === key);
      expect(found).toBeDefined();
      expect(found?.size).toBe(PAYLOAD.length);
      // The reconciliation sweep skips recent uploads by this timestamp, so it has
      // to be a real one rather than zero.
      expect(found?.uploadedAt).toBeGreaterThan(0);
    });

    it('reports itself healthy', async () => {
      await expect(driver.healthy()).resolves.toBe(true);
    });
  });
}

// ── The fake, which the rest of the suite depends on being faithful ──────────
describeDriverContract('fake (in-memory)', () => new FakeStorageDriver(), 'contract');

// ── The disk driver: the dev/CI store, and the legacy-read path in production ─
// Sync, because a top-level `await` needs an ESM module target this tsconfig does
// not set — and the temp directory is needed while the describe blocks are being
// registered, not inside a test.
const diskRoot = mkdtempSync(join(tmpdir(), 'oxshare-storage-'));
describeDriverContract('disk', () => new DiskStorageDriver(diskRoot), 'contract');
afterAll(async () => {
  await rm(diskRoot, { recursive: true, force: true });
});

// ── R2: opt-in only. Never in CI, never without R2_LIVE_TEST=1. ──────────────
//
// THE 11 SKIPS IN A DEFAULT RUN ARE THIS BLOCK, and they are declared rather
// than forgotten. `npm test` reports "2385 passed | 11 skipped"; every one of
// those eleven is the contract below, unrun because the live arm bills a real
// Cloudflare account per execution.
//
// That is a deliberate trade with a real residual, worth stating plainly: the
// contract passes against the two drivers production does NOT use (fake, disk)
// and is skipped for the one it does. A fake cannot reproduce R2's own
// behaviour — `responseChecksumValidation: 'WHEN_REQUIRED'` is load-bearing
// because R2 returns a WHOLE-object checksum on a partial response, so without
// it every ranged read fails, which is every multi-page PDF in the review
// queue. Only this arm can catch that class.
//
// So it is opt-in, not abandoned, and it gets RUN rather than assumed:
//
//   VERIFIED 10 Sep 2026 — `R2_LIVE_TEST=1 npx vitest run` on this file with the
//   R2_* block from `.env`: 33 passed, 0 skipped (11 fake + 11 disk + 11 live).
//   Bucket `oxshare-crm-local`. Every key is written under the `__contract-test`
//   prefix and deleted in `afterAll`, so a passing run leaves nothing behind.
//
// Re-run it after any aws-sdk upgrade, after touching `r2.ts`, and before
// trusting the fake on a change that concerns ranges or checksums. Skipping
// forever would make the eleven read as an oversight instead of a decision.
// ─────────────────────────────────────────────────────────────────────────────
const liveR2 =
  process.env.R2_LIVE_TEST === '1' &&
  Boolean(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET,
  );

describe.skipIf(!liveR2)('live R2', () => {
  describeDriverContract(
    'r2',
    () =>
      new R2StorageDriver({
        accountId: process.env.R2_ACCOUNT_ID as string,
        accessKeyId: process.env.R2_ACCESS_KEY_ID as string,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY as string,
        bucket: process.env.R2_BUCKET as string,
      }),
    '__contract-test',
  );
});
