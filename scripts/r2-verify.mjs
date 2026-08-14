/**
 * Prove the Cloudflare R2 configuration is real, once, by hand.
 *
 * ── Why this exists as a script and not a test ──────────────────────────────
 *
 * Everything else in this codebase that touches storage runs against the disk
 * driver or an in-memory fake, so `npm test` never reaches the bucket and never
 * bills it. That is the right default — but it means nothing in CI can tell you
 * whether the credentials in `.env` are correct, whether the endpoint resolves,
 * or whether the bucket name is spelled right. Those four values fail in ways
 * that look identical from the application: an upload that throws.
 *
 * So this is the one thing that talks to the live bucket. Run it after setting
 * or rotating credentials, and then leave it alone.
 *
 *   npm run r2:verify
 *
 * It writes ONE object under `__verify/`, reads it back, compares the bytes by
 * SHA-256, and deletes it. It also checks the two things that are genuinely
 * uncertain rather than merely unconfigured:
 *
 *   - **Checksums.** aws-sdk ≥ 3.729.0 changed its default checksum behaviour in
 *     a way that broke R2, and R2 later shipped support for the new scheme. Which
 *     side of that we are on is a property of the two versions in play today, not
 *     something a document can settle. This sends `ChecksumSHA256` explicitly —
 *     the thing `R2StorageDriver.put` does — and reports whether it was accepted.
 *   - **Range reads.** The document viewer depends on `206 Partial Content`
 *     working end to end. Cheap to check here, expensive to discover from a PDF
 *     that will not paint.
 *
 * ── It deliberately does NOT create the bucket ──────────────────────────────
 *
 * A missing bucket is reported, never created. The API token should be scoped to
 * one existing bucket with object read/write and nothing more; a script that can
 * create buckets implies a token that can, which is a larger grant than this
 * system needs.
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createHash, randomUUID } from 'node:crypto';
import { config as loadEnv } from 'dotenv';

loadEnv();

const REQUIRED = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`\n✖ Missing ${missing.join(', ')} in .env — nothing to verify.\n`);
  process.exit(1);
}

const ACCOUNT = process.env.R2_ACCOUNT_ID;
const BUCKET = process.env.R2_BUCKET;
const ENDPOINT = `https://${ACCOUNT}.r2.cloudflarestorage.com`;

// The SAME client configuration as src/common/uploads/storage/r2.storage-driver.ts.
// If these drift, this script stops proving anything about the application.
const s3 = new S3Client({
  region: 'auto',
  endpoint: ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
  maxAttempts: 3,
  requestHandler: { connectionTimeout: 3_000, requestTimeout: 20_000 },
  forcePathStyle: true,
  // Both narrowed for the reason spelled out at length in the driver: R2 returns
  // the WHOLE-object checksum on a partial response, and the SDK's default
  // validation compares it against the range it received, so every range read
  // fails. Step 5 below is what caught it, and step 5 is what re-catches it if a
  // future aws-sdk changes this again.
  responseChecksumValidation: 'WHEN_REQUIRED',
  requestChecksumCalculation: 'WHEN_REQUIRED',
});

const key = `__verify/${randomUUID()}.bin`;
// Big enough that a range read returns a meaningful slice, small enough to be free.
const body = Buffer.from(`oxshare-r2-verify ${new Date().toISOString()} `.repeat(64));
const sha256Hex = createHash('sha256').update(body).digest('hex');

const step = (n, what) => console.log(`\n[${n}] ${what}`);
const ok = (msg) => console.log(`    ✔ ${msg}`);
const warn = (msg) => console.log(`    ⚠ ${msg}`);

let created = false;

async function main() {
  console.log(`\nCloudflare R2 verification`);
  console.log(`  endpoint : ${ENDPOINT}`);
  console.log(`  bucket   : ${BUCKET}`);
  console.log(`  key      : ${key}`);

  step(1, 'HeadBucket — credentials and bucket name');
  await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
  ok('bucket reachable and the token can see it');

  step(2, 'PutObject with an explicit SHA-256 checksum');
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: body,
      ContentType: 'application/octet-stream',
      ChecksumSHA256: Buffer.from(sha256Hex, 'hex').toString('base64'),
    }),
  );
  created = true;
  ok(`wrote ${body.length} bytes; R2 accepted ChecksumSHA256`);

  step(3, 'HeadObject — size and content type survived the round trip');
  const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
  if (head.ContentLength !== body.length) {
    throw new Error(`size mismatch: wrote ${body.length}, stored ${head.ContentLength}`);
  }
  ok(`ContentLength ${head.ContentLength}, ContentType ${head.ContentType}, ETag ${head.ETag}`);

  step(4, 'GetObject — full read, bytes compared by SHA-256');
  const full = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const readBack = Buffer.from(await full.Body.transformToByteArray());
  const readHash = createHash('sha256').update(readBack).digest('hex');
  if (readHash !== sha256Hex) {
    throw new Error(`checksum mismatch\n  wrote ${sha256Hex}\n  read  ${readHash}`);
  }
  ok(`${readBack.length} bytes identical (sha256 ${sha256Hex.slice(0, 16)}…)`);

  step(5, 'GetObject with Range — the document viewer depends on 206');
  const partial = await s3.send(
    new GetObjectCommand({ Bucket: BUCKET, Key: key, Range: 'bytes=0-99' }),
  );
  const slice = Buffer.from(await partial.Body.transformToByteArray());
  if (slice.length !== 100 || !partial.ContentRange) {
    throw new Error(
      `range read wrong: got ${slice.length} bytes, ContentRange=${partial.ContentRange}`,
    );
  }
  if (!slice.equals(body.subarray(0, 100))) throw new Error('range read returned the wrong bytes');
  ok(`ContentRange ${partial.ContentRange}, 100 bytes, correct slice`);

  step(6, 'GetObject with If-None-Match — conditional read');
  try {
    await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key, IfNoneMatch: head.ETag }));
    warn('expected a 304 and got a body — the driver treats only a thrown 304 as a cache hit');
  } catch (error) {
    const status = error?.$metadata?.httpStatusCode;
    if (status === 304) ok('304 Not Modified, raised as an error exactly as the driver expects');
    else throw error;
  }

  step(7, 'ListObjectsV2 — the reconciliation sweep can enumerate');
  const listed = await s3.send(
    new ListObjectsV2Command({ Bucket: BUCKET, Prefix: '__verify/', MaxKeys: 10 }),
  );
  const found = (listed.Contents ?? []).some((o) => o.Key === key);
  if (!found) throw new Error('the object just written did not appear in a listing');
  ok(`listing works; ${listed.KeyCount ?? 0} object(s) under __verify/`);

  step(8, 'DeleteObject — cleaning up after ourselves');
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  created = false;
  const after = await s3
    .send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }))
    .then(() => true)
    .catch(() => false);
  if (after) throw new Error('object still present after delete');
  ok('deleted, and confirmed gone');

  console.log('\n✔ R2 is configured correctly. Nothing else needs to touch the live bucket.\n');
  console.log('  Reminder — two settings this script CANNOT check, in the Cloudflare dashboard:');
  console.log('    1. the public r2.dev URL for this bucket must be DISABLED');
  console.log('       (with one shared bucket, enabling it exposes every KYC document)');
  console.log('    2. the API token should be scoped to this bucket, Object Read & Write only\n');
}

main().catch(async (error) => {
  console.error(`\n✖ FAILED: ${error?.message ?? error}`);
  if (error?.$metadata) {
    console.error(`  http ${error.$metadata.httpStatusCode ?? '?'}  name ${error.name ?? '?'}`);
  }
  if (error?.name === 'InvalidAccessKeyId' || error?.name === 'SignatureDoesNotMatch') {
    console.error('  → R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY look wrong.');
  }
  if (error?.name === 'NoSuchBucket' || error?.$metadata?.httpStatusCode === 404) {
    console.error(`  → bucket "${BUCKET}" not found on account ${ACCOUNT}.`);
  }
  if (
    String(error?.message ?? '')
      .toLowerCase()
      .includes('checksum')
  ) {
    console.error(
      '  → a checksum incompatibility. Add requestChecksumCalculation: "WHEN_REQUIRED" and\n' +
        '    responseChecksumValidation: "WHEN_REQUIRED" to the S3Client in\n' +
        '    src/common/uploads/storage/r2.storage-driver.ts, with a comment naming this.',
    );
  }
  // Best effort: never leave the probe object behind on a mid-run failure.
  if (created) {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key })).catch(() => {});
  }
  console.error('');
  process.exit(1);
});
