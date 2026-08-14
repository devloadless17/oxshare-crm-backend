import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';
import type {
  StorageDriver,
  StorageLogger,
  StorageGetOptions,
  StorageListPage,
  StorageObject,
  StoragePutOptions,
} from './storage-driver';

/**
 * Cloudflare R2, through the S3-compatible API.
 *
 * ## The bucket is PRIVATE and no URL to it is ever emitted
 *
 * Nothing here presigns, and nothing here returns a URL. Browsers reach a document
 * through `GET /v1/uploads/...` on the API, which authorises, audits and then
 * streams these bytes. That is stronger than a signed URL on the properties that
 * matter for identity documents — no replayable link exists, every read is recorded,
 * and the response keeps the `nosniff` and CSP-sandbox headers a presigned URL
 * cannot carry. See DECISIONS for the recorded deviation from R-7.3.
 *
 * Because of that, there is deliberately no `isOwnUrl` / `keyFromUrl` pair here: the
 * sibling `customer-communication-platform` implementation needs them because it
 * hands presigned URLs to Meta, and every string that comes back has to be
 * re-validated against SSRF. This driver is only ever given keys built by
 * `storage-key.ts`.
 *
 * ## No client PII in object metadata
 *
 * The sibling implementation stores a human-readable label (team, phone, contact
 * name) as object metadata so the R2 dashboard is greppable, which is right for chat
 * media and wrong here. `uploads.controller.ts` keeps document filenames as UUIDs
 * "carrying nothing about the person" precisely so the audit trail can identify a
 * document without copying identity data somewhere else. Object metadata would be a
 * third copy — outside Postgres, outside our backups, and visible to anyone with
 * dashboard access. Only the checksum goes in.
 */

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

/**
 * Per-operation deadline.
 *
 * `requestTimeout` on the request handler bounds ONE http attempt; with
 * `maxAttempts: 3` the wall-clock a caller can wait is a multiple of it. This is the
 * number that actually bounds a held request, so every `send` carries it as an
 * `AbortSignal`.
 *
 * 20s is generous for a ≤10MB object (the ceiling in `upload-limits.ts`). If that
 * ceiling is ever raised, raise this with it — a flat budget that suits a phone
 * photo will fail a large document and fail it after doing all the work.
 */
const OPERATION_TIMEOUT_MS = 20_000;

/** Enough for the reconciliation sweep to page efficiently; R2 caps a page at 1000. */
const DEFAULT_LIST_LIMIT = 1000;

export class R2StorageDriver implements StorageDriver {
  readonly name = 'r2' as const;

  private readonly client: S3Client;
  private readonly bucket: string;

  /**
   * `logger` defaults to a no-op so the contract spec can construct a driver with
   * nothing else. `uploads.module.ts` always supplies a real one — the only thing
   * that reaches it is a swallowed delete, which is exactly the failure that needs a
   * trail rather than silence.
   */
  constructor(
    config: R2Config,
    private readonly logger: StorageLogger = { warn: () => {} },
  ) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      // Required by the SDK, unused by R2.
      region: 'auto',
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      /*
       * Retries stay ON. Object storage fails transiently, and the alternative to
       * a retry here is a client re-uploading their passport because of one
       * dropped connection. Bounded by the abort signal below.
       */
      maxAttempts: 3,
      requestHandler: {
        connectionTimeout: 3_000,
        requestTimeout: OPERATION_TIMEOUT_MS,
      },
      /*
       * ⚠️ RESPONSE CHECKSUM VALIDATION IS OFF, AND THIS IS NOT A SHORTCUT.
       *
       * Confirmed empirically by `npm run r2:verify` against the live bucket:
       * a FULL read validates fine, and a RANGE read fails with
       *
       *   Checksum mismatch: expected "Nj5e9Hbehmyx…" but received "2woEAykl…"
       *   in response header "x-amz-checksum-sha256"
       *
       * because R2 returns the checksum of the WHOLE object on a partial
       * response, and the SDK (default `WHEN_SUPPORTED` since 3.729.0) compares it
       * against the bytes of the PART it actually received. Those can never match
       * for any range smaller than the object.
       *
       * Cloudflare's own S3 compatibility matrix explains WHY, and it is not a bug
       * on either side — R2 supports SHA-256 only as a COMPOSITE checksum:
       *
       *   Algorithm      FULL_OBJECT   COMPOSITE
       *   CRC-64/NVME    ✅            ❌
       *   CRC-32         ❌            ✅
       *   CRC-32C        ❌            ✅
       *   SHA-1          ❌            ✅
       *   SHA-256        ❌            ✅        ← ours
       *
       * (https://developers.cloudflare.com/r2/api/s3/api/ — "Checksum Types")
       *
       * A composite checksum describes the object as a whole, so there is nothing
       * R2 could return that would validate a range. Switching to CRC-64/NVME would
       * not help either: a full-object checksum still cannot verify a partial body.
       * Turning response validation off for ranges is the correct answer, not a
       * workaround for a defect.
       *
       * That combination is exactly the read path this system depends on: a
       * browser PDF viewer fetches a scanned document by range, so leaving the
       * default on means every multi-page KYC document fails to open — and fails
       * with a checksum error, which reads like data corruption rather than a
       * client/server disagreement about what was being checksummed.
       *
       * What is NOT lost: integrity on WRITE. `put` sends an explicit
       * `ChecksumSHA256` which R2 verifies and refuses on mismatch (verify step 2),
       * and `stored_objects.sha256` records the same digest, so a corrupted object
       * is still detectable afterwards. `requestChecksumCalculation` is likewise
       * narrowed so the SDK stops attaching a redundant default CRC32 to every
       * request; an explicitly-supplied checksum is still always sent.
       *
       * Re-test with `npm run r2:verify` after any aws-sdk upgrade. If step 5
       * passes with these removed, R2 has started returning per-range checksums
       * and this can go.
       */
      responseChecksumValidation: 'WHEN_REQUIRED',
      requestChecksumCalculation: 'WHEN_REQUIRED',
      /*
       * Path-style, so the endpoint is `{endpoint}/{bucket}/{key}` rather than
       * putting the bucket in the hostname. Not load-bearing here — nothing parses
       * a URL this module produced, because it produces none — but a predictable
       * endpoint costs nothing and makes a captured request legible in a log.
       */
      forcePathStyle: true,
    });
  }

  async put(key: string, body: Buffer, options: StoragePutOptions): Promise<void> {
    await this.withDeadline((abortSignal) =>
      this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: options.contentType,
          ...(options.cacheControl ? { CacheControl: options.cacheControl } : {}),
          /*
           * End-to-end integrity: R2 verifies the body against this and REFUSES the
           * write on a mismatch, so a transfer corrupted in flight fails now rather
           * than being served months later as a damaged identity document.
           *
           * The SDK wants base64, while `stored_objects.sha256` holds hex because that
           * is what a human compares in a support ticket. Converted here so the
           * database keeps the readable form.
           */
          ChecksumSHA256: Buffer.from(options.sha256, 'hex').toString('base64'),
        }),
        { abortSignal },
      ),
    );
  }

  async get(key: string, options?: StorageGetOptions): Promise<StorageObject | null> {
    try {
      const res = await this.withDeadline((abortSignal) =>
        this.client.send(
          new GetObjectCommand({
            Bucket: this.bucket,
            Key: key,
            ...(options?.range ? { Range: options.range } : {}),
            ...(options?.ifNoneMatch ? { IfNoneMatch: options.ifNoneMatch } : {}),
          }),
          { abortSignal },
        ),
      );
      if (!res.Body) return null;
      return {
        // In the Node runtime the SDK's Body is a Node Readable.
        stream: res.Body as Readable,
        contentLength: typeof res.ContentLength === 'number' ? res.ContentLength : undefined,
        contentRange: res.ContentRange,
        etag: res.ETag,
        partial: Boolean(res.ContentRange),
      };
    } catch (error) {
      /*
       * A 304 arrives as a THROWN error, not a response.
       *
       * `IfNoneMatch` matching is a success from the caller's point of view — the
       * browser already holds the bytes — but the SDK treats any non-2xx as a
       * failure. Missing this turns a working cache hit into a 500.
       */
      if (httpStatusOf(error) === 304) {
        return { notModified: true, etag: options?.ifNoneMatch };
      }
      if (isNotFound(error)) return null;
      /*
       * Everything else propagates, deliberately.
       *
       * Collapsing an auth failure, a throttle or a network partition into "not
       * found" would render an outage as a screen telling a reviewer the client
       * never uploaded a document — a compliance conclusion drawn from an
       * infrastructure fault.
       */
      throw error;
    }
  }

  /**
   * Never throws — see the port's contract. A failed delete leaves an orphaned
   * object and a correct row, which the reconciliation sweep collects.
   */
  async delete(key: string): Promise<void> {
    try {
      await this.withDeadline((abortSignal) =>
        this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }), {
          abortSignal,
        }),
      );
    } catch (error) {
      if (isNotFound(error)) return;
      // Structured so a burst (an R2 outage) is greppable rather than one line lost
      // among request logs. Not rethrown: the caller's row is already correct.
      this.logger.warn(
        JSON.stringify({
          event: 'storage.delete_failed',
          severity: 'warn',
          provider: 'r2',
          key,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  async list(
    prefix: string,
    options?: { limit?: number; cursor?: string },
  ): Promise<StorageListPage> {
    const res = await this.withDeadline((abortSignal) =>
      this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          MaxKeys: options?.limit ?? DEFAULT_LIST_LIMIT,
          ...(options?.cursor ? { ContinuationToken: options.cursor } : {}),
        }),
        { abortSignal },
      ),
    );
    return {
      objects: (res.Contents ?? [])
        .filter((o): o is typeof o & { Key: string } => Boolean(o.Key))
        .map((o) => ({
          key: o.Key,
          size: o.Size ?? 0,
          uploadedAt: o.LastModified ? o.LastModified.getTime() : 0,
        })),
      ...(res.IsTruncated && res.NextContinuationToken
        ? { nextCursor: res.NextContinuationToken }
        : {}),
    };
  }

  async healthy(): Promise<boolean> {
    try {
      await this.withDeadline((abortSignal) =>
        this.client.send(new HeadBucketCommand({ Bucket: this.bucket }), { abortSignal }),
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * One operation, one deadline.
   *
   * The signal bounds the WHOLE operation including the SDK's retries, which
   * `requestTimeout` does not — that is the difference between a bounded request and
   * one that can hold an API worker for three attempts plus backoff.
   *
   * Shaped as "run this with a signal" rather than "send this command for me"
   * deliberately: a wrapper taking the command would have to name a single union
   * type for every S3 command, which erases the per-command input/output inference
   * and leaves every response typed `unknown`. Passing the signal inward keeps each
   * call site fully typed.
   */
  private async withDeadline<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OPERATION_TIMEOUT_MS);
    try {
      return await run(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }
}

function httpStatusOf(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
}

/**
 * Is this error "the object is not there", as opposed to a real failure?
 *
 * All three shapes are checked because the SDK uses different ones depending on the
 * operation: `GetObject` raises `NoSuchKey`, `HeadObject` raises `NotFound`, and some
 * paths surface only the status code. Checking one of the three is the bug that makes
 * a missing avatar a 500 while a missing document is a 404.
 */
function isNotFound(error: unknown): boolean {
  const name = (error as { name?: string })?.name;
  return name === 'NoSuchKey' || name === 'NotFound' || httpStatusOf(error) === 404;
}
