/**
 * Reconcile the object store against the `stored_objects` registry.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * This is the storage analogue of the ARCHITECTURE §11 ledger reconciliation, and it
 * exists for the same reason: two records of the same thing are written by different
 * steps, so "do they still agree" has to be a question somebody can actually ask.
 *
 * `StoredFilesService.write` stores the bytes FIRST and inserts the registry row
 * second, deliberately — a row pointing at bytes that were never written is a claim
 * the system would act on, whereas an object nobody references is only litter. This
 * script is what makes that trade honest by collecting the litter, and it reports in
 * BOTH directions because the two findings mean very different things:
 *
 *   ORPHANS   — an object with no live registry row. Cost, and a retention problem:
 *               an identity document nothing references is one nobody can review,
 *               serve, or delete on request.
 *   MISSING   — a live registry row whose object is gone. **This is the serious
 *               one.** The system believes it holds a document it cannot produce,
 *               and the first person to find out is usually a reviewer or a
 *               regulator.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *
 *   npm run r2:reconcile              # report only — always safe
 *   npm run r2:reconcile -- --prune   # ALSO delete confirmed orphans
 *
 * Not in CI: it costs R2 list requests, and a scheduled job that bills per run is one
 * somebody eventually disables. Run it after an incident, before an audit, or when
 * storage cost moves unexpectedly.
 *
 * ── The grace window is not optional ────────────────────────────────────────
 *
 * Objects younger than one hour are SKIPPED. Because bytes are written before the
 * row, a very recent orphan is indistinguishable from an upload still in flight —
 * and a sweep that deleted on sight would destroy a client's document part way
 * through them uploading it. `--prune` without this window is a data-loss bug, not
 * a cleanup.
 */

import { ListObjectsV2Command, DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { config as loadEnv } from 'dotenv';
import pg from 'pg';

loadEnv();

const PRUNE = process.argv.includes('--prune');

/** Objects younger than this are ignored entirely. See the header. */
const GRACE_MS = 60 * 60 * 1000;

/** The buckets, matching `FileBucket.dir` in stored-files.service.ts. */
const PREFIXES = ['kyc/', 'avatars/', 'payment-logos/'];

const REQUIRED = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`\n✖ Missing ${missing.join(', ')} in .env — nothing to reconcile.\n`);
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('\n✖ DATABASE_URL is not set — the registry side cannot be read.\n');
  process.exit(1);
}

const BUCKET = process.env.R2_BUCKET;

// The same client configuration as the driver — including the checksum settings,
// which are not optional against R2. See r2.storage-driver.ts.
const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
  maxAttempts: 3,
  requestHandler: { connectionTimeout: 3_000, requestTimeout: 20_000 },
  forcePathStyle: true,
  responseChecksumValidation: 'WHEN_REQUIRED',
  requestChecksumCalculation: 'WHEN_REQUIRED',
});

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });

/** Every object in the bucket under our prefixes, cursor-paginated. */
async function listStoredObjects() {
  const found = new Map(); // key -> { size, uploadedAt }
  for (const Prefix of PREFIXES) {
    let ContinuationToken;
    do {
      const page = await s3.send(
        new ListObjectsV2Command({ Bucket: BUCKET, Prefix, MaxKeys: 1000, ContinuationToken }),
      );
      for (const object of page.Contents ?? []) {
        if (!object.Key) continue;
        found.set(object.Key, {
          size: object.Size ?? 0,
          uploadedAt: object.LastModified ? object.LastModified.getTime() : 0,
        });
      }
      ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (ContinuationToken);
  }
  return found;
}

async function main() {
  await db.connect();

  console.log(`\nStorage reconciliation`);
  console.log(`  bucket : ${BUCKET}`);
  console.log(`  mode   : ${PRUNE ? 'REPORT + PRUNE (deletes orphans)' : 'report only'}`);

  const objects = await listStoredObjects();
  const { rows } = await db.query(
    `SELECT bucket, storage_key, byte_size, created_at
       FROM stored_objects
      WHERE deleted_at IS NULL AND provider = 'r2'`,
  );
  console.log(`\n  ${objects.size} object(s) in the bucket, ${rows.length} live registry row(s)`);

  const registered = new Map(rows.map((r) => [r.storage_key, r]));
  const cutoff = Date.now() - GRACE_MS;

  // ── Direction 1: objects with no live row ────────────────────────────────
  const orphans = [];
  let skippedRecent = 0;
  for (const [key, meta] of objects) {
    if (registered.has(key)) continue;
    if (meta.uploadedAt > cutoff) {
      // Very likely an upload in flight whose row is still being written. See the
      // header — deleting this is the data-loss bug, not the cleanup.
      skippedRecent += 1;
      continue;
    }
    orphans.push({ key, ...meta });
  }

  // ── Direction 2: live rows with no object ────────────────────────────────
  const absent = rows.filter((r) => !objects.has(r.storage_key));

  // ── Report ───────────────────────────────────────────────────────────────
  if (skippedRecent > 0) {
    console.log(`\n  ${skippedRecent} object(s) newer than the 1h grace window — skipped.`);
  }

  if (orphans.length === 0) {
    console.log(`\n✔ No orphaned objects.`);
  } else {
    const bytes = orphans.reduce((sum, o) => sum + o.size, 0);
    console.log(
      `\n⚠ ${orphans.length} ORPHANED object(s) — stored, but no live registry row ` +
        `(${(bytes / 1024 / 1024).toFixed(2)} MB):`,
    );
    for (const o of orphans.slice(0, 50)) {
      console.log(`    ${o.key}  ${o.size}B  ${new Date(o.uploadedAt).toISOString()}`);
    }
    if (orphans.length > 50) console.log(`    … and ${orphans.length - 50} more`);
  }

  if (absent.length === 0) {
    console.log(`✔ No missing objects — every live row has its bytes.`);
  } else {
    // Deliberately louder than the orphan report. This is the direction where the
    // system has lost something it claims to hold.
    console.log(
      `\n✖ ${absent.length} MISSING object(s) — the registry has a live row and the bytes are ` +
        `GONE. These are documents the system believes it holds:`,
    );
    for (const r of absent.slice(0, 50)) {
      console.log(`    ${r.storage_key}  ${r.byte_size}B  recorded ${r.created_at.toISOString()}`);
    }
    if (absent.length > 50) console.log(`    … and ${absent.length - 50} more`);
  }

  // ── Prune, only when asked ───────────────────────────────────────────────
  if (PRUNE && orphans.length > 0) {
    console.log(`\nDeleting ${orphans.length} orphaned object(s)…`);
    let deleted = 0;
    for (const o of orphans) {
      await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: o.key }));
      deleted += 1;
    }
    console.log(`  ✔ deleted ${deleted}`);
  } else if (orphans.length > 0) {
    console.log(`\n  Re-run with --prune to delete them.`);
  }

  // Exit non-zero on the serious direction only, so this can be wired to an alert
  // without an orphan (a cost issue) waking anybody at night.
  const exitCode = absent.length > 0 ? 1 : 0;
  console.log('');
  await db.end();
  process.exit(exitCode);
}

main().catch(async (error) => {
  console.error(`\n✖ FAILED: ${error?.message ?? error}\n`);
  await db.end().catch(() => {});
  process.exit(1);
});
