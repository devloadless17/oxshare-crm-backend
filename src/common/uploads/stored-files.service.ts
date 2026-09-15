import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { QuotaExceededError, ValidationError } from '../errors/domain-errors';
import {
  StoredObjectsStore,
  type StorageProvider,
  type UploaderKind,
} from '../../store/stored-objects.store';
import { ALERT_KINDS, raiseAlert } from '../logging/alerts';
import {
  ACTIVE_CONTENT_REJECTION,
  describeActiveFeatures,
  findActivePdfFeatures,
} from './active-content';
import { SIGNATURE_BYTES, signatureMatchesDeclared, sniffMimeType } from './file-signature';
import { objectKey } from './storage/storage-key';
import {
  STORAGE_DRIVER,
  type StorageDriver,
  type StorageGetOptions,
  type StorageObject,
} from './storage/storage-driver';

/**
 * Everything this system stores, and everything it refuses to store.
 *
 * ── What changed when object storage landed ─────────────────────────────────
 *
 * The public shape of this class is unchanged — `write`, `read`, `contentType`,
 * `remove` over a `FileBucket` — because it was already the right seam. What moved
 * is the bottom: it used to call `fs` directly, and now it calls a `StorageDriver`
 * (Cloudflare R2 in production, the local filesystem for development and tests).
 * Nothing above this class knows where the bytes live.
 *
 * `read` became ASYNC as part of that, and its callers now await it. The old
 * synchronous signature carried a comment explaining that a caller decides between
 * 404 and streaming before writing any headers — still true, and still satisfied:
 * awaiting first is not the same as streaming first.
 *
 * ── The rules this class exists to enforce ──────────────────────────────────
 *
 * Two, both of which predate object storage and neither of which the storage move
 * is allowed to weaken:
 *
 *  1. **The accepted TYPE is decided from the file's own magic bytes**, never from
 *     the multipart `Content-Type`. That header is a claim by the uploader, and an
 *     HTML document declared `image/png` is how a stored file becomes stored XSS on
 *     the origin that holds the session cookies.
 *  2. **The size is checked here as well as at the interceptor**, because a limit
 *     enforced in one place is a limit that moves when the interceptor is
 *     reconfigured.
 *
 * Object storage adds a third:
 *
 *  3. **Every stored object is registered** in `stored_objects` with its checksum,
 *     size, owner and uploader. "Who uploaded this document and when" had no answer
 *     before, and on a system holding identity documents for a regulated broker it
 *     is a question that gets asked under pressure.
 */

export interface FileBucket {
  /**
   * The bucket's name, used THREE ways that must stay in step: the object-key
   * prefix (`kyc/…`), the disk subdirectory (`uploads/kyc/…`), and
   * `stored_objects.bucket`. Mirrored on purpose — see `storage/storage-key.ts`.
   */
  dir: string;
  /** Hard ceiling, enforced here as well as at the interceptor. */
  maxBytes: number;
  /** Content types this bucket accepts, decided by magic bytes. */
  allowedMimeTypes: readonly string[];
  /** Extension to store per accepted type — never taken from the filename. */
  extensions: Readonly<Record<string, string>>;
  /**
   * What to tell somebody whose file was refused.
   *
   * Per bucket, because the honest answer differs: the KYC bucket accepts PDF and
   * is reached mostly from phones, so its message has to name both. A single shared
   * string was previously wrong for whichever bucket it was not written for — and a
   * rejection message that does not name the fix is a dead end for the person
   * holding the file.
   */
  rejectionMessage: string;
  /**
   * `Cache-Control` for objects in this bucket, stored ON the object.
   *
   * Absent for anything containing PII: identity documents are served `no-store`
   * and must never settle into a browser's disk cache.
   */
  cacheControl?: string;
  /**
   * Refuse a PDF that carries a script, an embedded file or a launch action.
   *
   * KYC only. The other buckets take images, which have no execution model, and
   * the logo bucket's SVG is handled by the CSP it is served under rather than
   * by content inspection — see the note on `PAYMENT_LOGO_BUCKET`.
   */
  rejectActiveContent?: boolean;
  /**
   * Does an object here belong to a client, for quota purposes?
   *
   * False for payment-method logos — a brand mark is uploaded by an administrator
   * and belongs to nobody, so counting it against anyone's allowance is meaningless.
   */
  countsTowardOwnerQuota: boolean;
}

/**
 * How much one client may store, across every bucket.
 *
 * ## ⚠️ ASSUMPTION — no authoritative document states a per-client storage limit
 *
 * Recorded in DECISIONS. It is a business ceiling chosen to be generous rather than
 * tight: a complete KYC submission is three or four files, and a client correcting a
 * rejection re-uploads one or two, so 50MB is roughly twelve documents at the
 * maximum size. Nobody legitimate reaches it.
 *
 * It exists because the failure mode CHANGED with object storage. On local disk an
 * unbounded uploader filled a volume, which sets off an alarm. On R2 it is a silent
 * bill — the 10/min throttle still permits ~6GB per client per hour, and nothing
 * would report it until an invoice.
 */
export const OWNER_STORAGE_QUOTA_BYTES = 50 * 1024 * 1024;

/**
 * Profile photos: JPEG, PNG or WebP, up to 2MB.
 *
 * No PDF, unlike the KYC bucket. An avatar is rendered inline on every screen, and
 * the set of things a browser will render is exactly the set worth accepting.
 */
export const AVATAR_BUCKET: FileBucket = {
  dir: 'avatars',
  maxBytes: 2 * 1024 * 1024,
  allowedMimeTypes: ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'],
  extensions: {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
  },
  rejectionMessage: 'Only JPEG, PNG and WebP images are accepted.',
  // Private and short: a photo the owner has just replaced must not survive on
  // their own screen. Matches the header the serving route sets.
  cacheControl: 'private, max-age=300',
  countsTowardOwnerQuota: true,
};

/**
 * Identity documents: JPEG, PNG, WebP or PDF, up to 10MB.
 *
 * PDF is the difference from the avatar bucket, and it is the format most banks and
 * utilities issue a statement in — refusing it would mean refusing proof of address
 * in the form most clients actually hold.
 *
 * The ceiling comes from `modules/compliance/upload-limits.ts` so the interceptor,
 * the 413 message and this check cannot drift apart.
 */
export const KYC_BUCKET: FileBucket = {
  dir: 'kyc',
  // The only bucket that accepts a format with an execution model, so the only
  // one that has to look inside. See `active-content.ts`.
  rejectActiveContent: true,
  maxBytes: 10 * 1024 * 1024,
  allowedMimeTypes: ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'application/pdf'],
  extensions: {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'application/pdf': '.pdf',
  },
  /*
   * The message names the FIX, because most of these uploads come from a phone.
   *
   * iPhones photograph in HEIC by default and HEIC is not accepted — decoding it
   * would mean adding an image codec, which is a decision nobody has taken. So an
   * iPhone client can be refused for doing nothing wrong, and "that is not a valid
   * image" tells them only that the thing in their hand is not a photo. The setting
   * that resolves it is three levels into iOS Settings and is not something anyone
   * will guess.
   *
   * This does NOT decide the HEIC question; it makes the current answer usable while
   * that decision is outstanding.
   */
  rejectionMessage:
    'Only JPG, PNG, WEBP images and PDF files are allowed. ' +
    'If you are on an iPhone, set Settings → Camera → Formats to "Most Compatible" and retake the ' +
    'photo, or choose it from Photos so it is converted to JPG.',
  // Deliberately none: an identity document is served `no-store` and must not
  // settle into a disk cache. See uploads.controller.ts.
  countsTowardOwnerQuota: true,
};

/**
 * Payment-method logos: JPEG, PNG, WebP or SVG, up to 1MB.
 *
 * Smaller than an avatar because these render at roughly 20px in the admin table and
 * on the client's deposit screen. A megabyte is already generous for a brand mark,
 * and the ceiling is what stops a 6MB press-kit PNG landing in a list every client
 * loads.
 *
 * ## ⚠️ SVG IS ACCEPTED, AND IT IS THE ONE ENTRY HERE WITH A SHARP EDGE
 *
 * An SVG is a DOCUMENT, not an image: it can carry `<script>`, and one served from
 * our own origin is stored XSS. It is accepted because it is the obvious format for
 * a brand mark, and it is SAFE HERE only because of two things that must both stay
 * true:
 *
 *   1. `uploads.controller.ts` serves every logo with `Content-Security-Policy:
 *      default-src 'none'; style-src 'unsafe-inline'; sandbox` and
 *      `X-Content-Type-Options: nosniff`. That stops script executing even when the
 *      file is navigated to directly as a top-level document, which is the only way
 *      an SVG executes anything.
 *   2. Both frontends render logos through `<img>`, which does not execute script
 *      inside an SVG at all.
 *
 * `looksLikeSvg` in file-signature.ts is a TYPE check, not a sanitiser — it rejects
 * an HTML document renamed `.svg`, which is the substitution that turns an upload
 * into stored XSS, but it does not strip anything.
 *
 * IF EITHER PROTECTION IS REMOVED — a logo inlined into the DOM with
 * `dangerouslySetInnerHTML`, or the CSP dropped from that route — SVG comes straight
 * back out of this list. Nothing else in this bucket carries that condition.
 */
export const PAYMENT_LOGO_BUCKET: FileBucket = {
  dir: 'payment-logos',
  maxBytes: 1024 * 1024,
  allowedMimeTypes: ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/svg+xml'],
  extensions: {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
  },
  rejectionMessage: 'Only JPEG, PNG, WebP and SVG images are accepted.',
  // Public and long: brand marks change roughly never and every client loads them.
  cacheControl: 'public, max-age=86400',
  // A brand mark belongs to nobody. Counting it against an admin's allowance would
  // be meaningless, and there is no client to charge it to.
  countsTowardOwnerQuota: false,
};

export interface StoredFile {
  /** The generated name, `<uuid><ext>`. Never anything the client supplied. */
  filename: string;
  mimeType: string;
  size: number;
  /** Lowercase hex SHA-256 of the stored bytes. */
  sha256: string;
}

/** Who is uploading, for the registry. */
export interface Uploader {
  id: string;
  kind: UploaderKind;
  /**
   * The client the file is ABOUT, when that differs from the uploader — an admin
   * uploading on a client's behalf — or null for objects belonging to nobody.
   */
  ownerUserId?: string | null;
}

@Injectable()
export class StoredFilesService {
  /** DI token for the legacy-disk fallback driver. See `uploads.module.ts`. */
  static readonly LEGACY_DISK_DRIVER = Symbol('LEGACY_DISK_DRIVER');

  private readonly logger = new Logger(StoredFilesService.name);

  constructor(
    @Inject(STORAGE_DRIVER) private readonly driver: StorageDriver,
    @Inject(StoredFilesService.LEGACY_DISK_DRIVER) private readonly legacy: StorageDriver,
    private readonly registry: StoredObjectsStore,
  ) {}

  /**
   * Validate the bytes, store them, and record the object.
   *
   * The name is a random UUID plus an extension taken from the SNIFFED type — never
   * from the uploaded filename. A client-supplied name is how `..` and
   * `payload.html` get into a directory, and a client-supplied extension is how an
   * HTML document ends up served as active content from the origin holding the
   * session cookies.
   *
   * ## Ordering: bytes first, then the row
   *
   * If the registry insert fails, the object is deleted and the error propagates.
   * The reverse order would leave a row pointing at bytes that were never written —
   * a claim the system would then act on, serving a 404 for a document it believes
   * it holds. An object with no row is merely litter, and `scripts/r2-reconcile.mjs`
   * collects it.
   */
  async write(
    bucket: FileBucket,
    buffer: Buffer,
    declaredMime: string,
    uploader: Uploader,
    originalName?: string | null,
  ): Promise<StoredFile> {
    if (buffer.length === 0) throw new ValidationError('That file is empty.');

    // Checked here as well as at the interceptor, deliberately — see the note at
    // the top. Two enforcement points cost nothing and one of them moving is the
    // failure this guards against.
    if (buffer.length > bucket.maxBytes) {
      const limitMb = Math.floor(bucket.maxBytes / (1024 * 1024));
      throw new ValidationError(`That file is larger than the ${limitMb}MB limit.`);
    }

    /*
     * What the bytes ARE, not what the upload said they were.
     *
     * Both halves must hold: the sniffed type has to be one this bucket accepts,
     * AND it has to agree with what the client declared. Content alone would let a
     * real JPEG be stored under a mismatched declaration; the declaration alone is
     * the hole that lets HTML in.
     */
    const header = buffer.subarray(0, SIGNATURE_BYTES);
    const actual = sniffMimeType(header);

    if (!actual || !bucket.allowedMimeTypes.includes(actual)) {
      throw new ValidationError(bucket.rejectionMessage);
    }
    if (!signatureMatchesDeclared(header, declaredMime)) {
      throw new ValidationError(
        `The file content does not match its declared type. ${bucket.rejectionMessage}`,
      );
    }

    /*
     * The type is right. Is the CONTENT hostile?
     *
     * Everything above answers "is this the kind of file it claims to be", which
     * is the check that stops an HTML document arriving as `passport.pdf`. It
     * has nothing to say about a file that is a real PDF and is also a dropper.
     *
     * This runs on the whole buffer AFTER the size ceiling, never before: the
     * scan is linear in the file, so doing it first would let a 200MB body cost
     * a scan before the limit refused it.
     *
     * See `active-content.ts` for what the scan does and does not cover — it
     * catches the ordinary hostile PDF and says plainly that it is not a
     * sanitiser.
     */
    if (bucket.rejectActiveContent && actual === 'application/pdf') {
      const features = findActivePdfFeatures(buffer);
      if (features.length > 0) {
        /*
         * Alert BEFORE throwing. The throw unwinds to the exception filter and
         * the request ends as an ordinary 400, so this is the only place the
         * event is visible — and "a document with a script in it was offered to
         * the KYC queue" is a thing a person should get to see.
         *
         * `notify`, not `page`: the upload was refused, so nothing is stored and
         * nothing is running. Context carries the markers and the uploader, and
         * deliberately not the filename — that is client-supplied text on a path
         * that logs.
         */
        raiseAlert(
          this.logger,
          ALERT_KINDS.UPLOAD_ACTIVE_CONTENT,
          'notify',
          `A KYC upload was refused: the PDF carries ${describeActiveFeatures(features)}.`,
          {
            features: features.join(','),
            uploaderKind: uploader.kind,
            uploaderId: uploader.id,
            bytes: buffer.length,
          },
        );
        throw new ValidationError(ACTIVE_CONTENT_REJECTION);
      }
    }

    const owner = bucket.countsTowardOwnerQuota
      ? (uploader.ownerUserId ?? (uploader.kind === 'client' ? uploader.id : null))
      : null;
    if (owner) await this.assertWithinQuota(owner, buffer.length);

    const filename = `${randomUUID()}${bucket.extensions[actual] ?? '.bin'}`;
    const key = objectKey(bucket.dir, filename);
    const sha256 = createHash('sha256').update(buffer).digest('hex');

    await this.driver.put(key, buffer, {
      contentType: actual,
      sha256,
      ...(bucket.cacheControl ? { cacheControl: bucket.cacheControl } : {}),
    });

    try {
      await this.registry.record({
        bucket: bucket.dir,
        storageKey: key,
        provider: this.driver.name,
        contentType: actual,
        byteSize: buffer.length,
        sha256,
        originalName: originalName ?? null,
        ownerUserId: owner,
        uploadedById: uploader.id,
        uploadedByKind: uploader.kind,
      });
    } catch (error) {
      // The bytes are already stored. An object nothing references can never be
      // served, never be reviewed, and never be cleaned up by anything that reads
      // the registry — so it goes now rather than waiting for a sweep.
      await this.driver.delete(key);
      throw error;
    }

    this.logger.log(
      JSON.stringify({
        event: 'storage.upload',
        bucket: bucket.dir,
        key,
        provider: this.driver.name,
        bytes: buffer.length,
        contentType: actual,
        actorId: uploader.id,
        actorKind: uploader.kind,
      }),
    );

    return { filename, mimeType: actual, size: buffer.length, sha256 };
  }

  /**
   * Open a stored object for streaming, or `null` if it is not there.
   *
   * ## Dual-read, and why writes do NOT get the same treatment
   *
   * Files uploaded before the move to object storage are still on this host's disk,
   * and there is no backfill migration, so a miss on the active driver falls back to
   * the legacy disk driver. A read that finds the bytes wherever they are is
   * correct; nothing about which store answered is interesting to the caller.
   *
   * The WRITE path deliberately has no equivalent. If R2 is unreachable an upload
   * fails loudly, because falling back would scatter documents across two providers
   * with no record of which is which — recoverable in the read direction, genuinely
   * hard to unwind in the write direction.
   *
   * `basename` is applied when the key is built (`storage-key.ts`): the caller has
   * usually matched this name against a database column, but a path check that
   * exists in one place is one somebody can route around.
   */
  async read(
    bucket: FileBucket,
    name: string,
    options?: StorageGetOptions,
  ): Promise<StorageObject | null> {
    let key: string;
    try {
      key = objectKey(bucket.dir, name);
    } catch {
      // An unsafe filename is not an error worth propagating — the caller is about
      // to answer 404, which is also the right answer for a name we refuse to build
      // a key from.
      return null;
    }

    const found = await this.driver.get(key, options);
    if (found) return found;
    if (this.driver.name === 'disk') return null; // same store; a second look is a second miss

    return this.legacy.get(key, options);
  }

  /**
   * The `Content-Type` to serve a stored file with, or `null` if we never wrote that
   * shape.
   *
   * ## Why this is trustworthy, and why the extension is the right source
   *
   * Reading a type from a filename is normally exactly the mistake this service
   * exists to prevent — but this is OUR filename. `write()` generates it as
   * `<uuid><ext>` and picks `<ext>` from the bucket's map keyed on the type it
   * decided from the file's own MAGIC BYTES. The uploader's filename and their
   * multipart `Content-Type` are both discarded before that point, so the extension
   * here is a record of what the bytes actually were.
   *
   * ## Why serving without one was broken
   *
   * The routes streamed with no `Content-Type` at all, alongside
   * `X-Content-Type-Options: nosniff`. A PNG survives that — browsers still decode it
   * from its magic bytes — so nothing looked wrong for years. SVG has no magic bytes:
   * it is XML, and a browser that is forbidden to sniff and told nothing will not
   * render it as an image. The logo simply did not appear.
   *
   * `null` for an unrecognised extension, and the callers 404 on it. A file in one of
   * our buckets with an extension we never write is not one we wrote, and guessing a
   * type for it is the sniffing this whole class refuses to do.
   */
  contentType(bucket: FileBucket, name: string): string | null {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 ? name.slice(dot).toLowerCase() : '';
    if (!ext) return null;

    /*
     * The bucket's own map, read backwards. Two types can share an extension
     * (`image/jpeg` and `image/jpg` both write `.jpg`); the first wins, and the
     * buckets list the canonical spelling first for that reason.
     */
    for (const [mimeType, extension] of Object.entries(bucket.extensions)) {
      if (extension.toLowerCase() === ext) return mimeType;
    }
    return null;
  }

  /**
   * Delete a stored object. Absent or unset is a no-op, not an error.
   *
   * Accepts `undefined` because callers pass a nullable column straight in: a client
   * removing a photo they never had, or replacing one where the previous value was
   * null, is an ordinary case rather than a failure.
   *
   * **Never throws.** Every call site deletes AFTER the row has been updated,
   * precisely so that a failed delete leaves an orphaned object and a correct row —
   * the recoverable direction. Rethrowing here would turn that deliberate ordering
   * into a failed request.
   *
   * The registry row is SOFT-deleted, not removed: "what did the document we refused
   * look like" is a question `kyc_submission_attempts` exists to answer, and erasing
   * the record from this side would reopen the same hole.
   */
  async remove(bucket: FileBucket, filename: string | null | undefined): Promise<void> {
    if (!filename) return;
    let key: string;
    try {
      key = objectKey(bucket.dir, filename);
    } catch {
      return;
    }

    await this.driver.delete(key);
    // Legacy copy too: a document written before the move lives on disk, and the
    // active driver's delete would silently do nothing for it.
    if (this.driver.name !== 'disk') await this.legacy.delete(key);

    try {
      await this.registry.markDeleted(bucket.dir, key);
    } catch (error) {
      // Same contract as the delete itself: never throw. A row still marked live for
      // bytes that are gone is what the reconciliation sweep reports.
      this.logger.warn(
        `Could not mark ${key} deleted in the registry: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  /** Is the active store reachable? For the readiness probe — see `health`. */
  healthy(): Promise<boolean> {
    return this.driver.healthy();
  }

  /** Which store is active, for the health payload and the reconciliation script. */
  get providerName(): StorageProvider {
    return this.driver.name;
  }

  /**
   * Refuse an upload that would take this client past their allowance.
   *
   * ## Honest limitation: advisory, not an invariant
   *
   * There is no natural row to `SELECT … FOR UPDATE` here, so two concurrent uploads
   * can both read the same total and both pass. That is accepted rather than papered
   * over: the overshoot is bounded by one file's ceiling times the 10/min throttle,
   * and this is a business limit against runaway cost, not a money invariant. The
   * §6 locking rules apply to the ledger, where a lost update is a wrong balance;
   * applying them here would imply a guarantee this does not make.
   */
  private async assertWithinQuota(ownerUserId: string, incomingBytes: number): Promise<void> {
    const used = await this.registry.liveBytesForOwner(ownerUserId);
    if (used + incomingBytes <= OWNER_STORAGE_QUOTA_BYTES) return;

    const limitMb = Math.floor(OWNER_STORAGE_QUOTA_BYTES / (1024 * 1024));
    const usedMb = (used / (1024 * 1024)).toFixed(1);
    throw new QuotaExceededError(
      `This account has used ${usedMb}MB of its ${limitMb}MB document allowance, and this file ` +
        'would take it over. Remove a document you no longer need, or contact support.',
    );
  }
}

/**
 * Where an ADMINISTRATOR's avatar is served from.
 *
 * Composed at READ time, which is why the column holds a FILENAME rather than a URL.
 * Kept here rather than at each caller so that a change to how photos are addressed
 * is one expression instead of every screen that renders one.
 *
 * `admin-avatars`, not `avatars`, and the difference is the GUARD rather than the
 * storage: the bytes live in the client bucket alongside everyone else's, but
 * `/uploads/avatars/:file` is guarded by the portal's `JwtAuthGuard` and checks
 * ownership against `users`. An admin fetching their own photo through it gets a 401
 * before the ownership check is even reached. See `UploadsController.serveAdminAvatar`.
 */
export function adminAvatarUrl(filename: string): string {
  return `/uploads/admin-avatars/${filename}`;
}
