import { createReadStream, existsSync, mkdirSync } from 'node:fs';
import { unlink, writeFile } from 'node:fs/promises';
import type { Readable } from 'node:stream';
import { basename, extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ValidationError } from '../errors/domain-errors';
import { SIGNATURE_BYTES, signatureMatchesDeclared, sniffMimeType } from './file-signature';

/**
 * RECONSTRUCTED. Please review.
 *
 * This file was never committed: `.gitignore` carried an unanchored `uploads/`,
 * which matches a directory of that name at any depth, so it silently swallowed
 * `src/common/uploads/`. The commit that added the upload facility shipped
 * `file-signature.ts` and four importers, but not this — and the repo stopped
 * compiling. It is not in git history and not on disk, so it could not be
 * recovered; what follows is rebuilt from its call sites and from the design its
 * callers describe in their own comments. The gitignore pattern is now anchored.
 *
 * Where the original said something this does not, the original is right.
 *
 * ## What the callers require
 *
 *   write(bucket, buffer, declaredMime) -> { filename, mimeType, size }
 *   remove(bucket, filename | undefined)
 *   read(bucket, name) -> { stream } | null          (synchronous)
 *
 * ## The rules the callers state
 *
 * `auth.controller.ts`: "The accepted TYPES are decided from the file's own
 * magic bytes inside StoredFilesService, never from the multipart Content-Type
 * — that header is a claim by the uploader, and an HTML document declared
 * image/png is how a stored file becomes stored XSS."
 *
 * And: "the service checks the size again because a limit enforced in one place
 * is a limit that moves when the interceptor is reconfigured."
 *
 * Both are implemented below, and they are the reason this is a service rather
 * than two calls to `fs`.
 */

export interface FileBucket {
  /** Directory under ./uploads, e.g. `avatars`. */
  dir: string;
  /** Hard ceiling, enforced here as well as at the interceptor. */
  maxBytes: number;
  /** Content types this bucket accepts, decided by magic bytes. */
  allowedMimeTypes: readonly string[];
  /** Extension to store per accepted type — never taken from the filename. */
  extensions: Readonly<Record<string, string>>;
}

/**
 * Profile photos: JPEG, PNG or WebP, up to 2MB.
 *
 * No PDF, unlike the KYC bucket. An avatar is rendered inline on every screen,
 * and the set of things a browser will render is exactly the set worth
 * accepting.
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
};

/**
 * Payment-method logos: JPEG, PNG or WebP, up to 1MB.
 *
 * Smaller than an avatar because these render at roughly 20px in the admin
 * table and on the client's deposit screen. A megabyte is already generous for
 * a brand mark, and the ceiling is what stops a 6MB press-kit PNG landing in a
 * list every client loads.
 *
 * ## ⚠️ SVG IS ACCEPTED, AND IT IS THE ONE ENTRY HERE WITH A SHARP EDGE
 *
 * An SVG is a DOCUMENT, not an image: it can carry `<script>`, and one served
 * from our own origin is stored XSS. It is accepted because it is the obvious
 * format for a brand mark, and it is SAFE HERE only because of two things that
 * must both stay true:
 *
 *   1. `uploads.controller.ts` serves every logo with `Content-Security-Policy:
 *      default-src 'none'; sandbox` and `X-Content-Type-Options: nosniff`. That
 *      stops script executing even when the file is navigated to directly as a
 *      top-level document, which is the only way an SVG executes anything.
 *   2. Both frontends render logos through `<img>`, which does not execute
 *      script inside an SVG at all.
 *
 * `looksLikeSvg` in file-signature.ts is a TYPE check, not a sanitiser — it
 * rejects an HTML document renamed `.svg`, which is the substitution that turns
 * an upload into stored XSS, but it does not strip anything.
 *
 * IF EITHER PROTECTION IS REMOVED — a logo inlined into the DOM with
 * `dangerouslySetInnerHTML`, or the CSP dropped from that route — SVG comes
 * straight back out of this list. Nothing else in this bucket carries that
 * condition.
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
};

export interface StoredFile {
  /** The generated name, `<uuid><ext>`. Never anything the client supplied. */
  filename: string;
  mimeType: string;
  size: number;
}

@Injectable()
export class StoredFilesService {
  private readonly logger = new Logger(StoredFilesService.name);

  /** Everything lives under ./uploads/<bucket.dir>, beside the KYC documents. */
  private bucketPath(bucket: FileBucket): string {
    return join(process.cwd(), 'uploads', bucket.dir);
  }

  /**
   * Validate the bytes, then write them under a generated name.
   *
   * The name is a random UUID plus an extension taken from the SNIFFED type —
   * never from the uploaded filename. A client-supplied name is how `..` and
   * `payload.html` get into a directory, and a client-supplied extension is how
   * an HTML document ends up served as active content from the origin holding
   * the session cookies.
   */
  async write(bucket: FileBucket, buffer: Buffer, declaredMime: string): Promise<StoredFile> {
    if (buffer.length === 0) throw new ValidationError('That file is empty.');

    // Checked here as well as at the interceptor, deliberately — see the note
    // above. Two enforcement points cost nothing and one of them moving is the
    // failure this guards against.
    if (buffer.length > bucket.maxBytes) {
      const limitMb = Math.floor(bucket.maxBytes / (1024 * 1024));
      throw new ValidationError(`That file is larger than the ${limitMb}MB limit.`);
    }

    /*
     * What the bytes ARE, not what the upload said they were.
     *
     * Both halves must hold: the sniffed type has to be one this bucket accepts,
     * AND it has to agree with what the client declared. Content alone would let
     * a real JPEG be stored under a mismatched declaration; the declaration
     * alone is the hole that lets HTML in.
     */
    const header = buffer.subarray(0, SIGNATURE_BYTES);
    const actual = sniffMimeType(header);

    if (!actual || !bucket.allowedMimeTypes.includes(actual)) {
      throw new ValidationError('Only JPEG, PNG and WebP images are accepted.');
    }
    if (!signatureMatchesDeclared(header, declaredMime)) {
      throw new ValidationError(
        'The file content does not match its declared type. Upload a genuine JPEG, PNG or WebP.',
      );
    }

    const filename = `${randomUUID()}${bucket.extensions[actual] ?? '.bin'}`;
    const dir = this.bucketPath(bucket);
    mkdirSync(dir, { recursive: true });
    await writeFile(join(dir, filename), buffer);

    return { filename, mimeType: actual, size: buffer.length };
  }

  /**
   * Open a stored file for streaming, or `null` if it is not there.
   *
   * Synchronous, because the caller decides between 404 and streaming before it
   * writes any headers.
   *
   * `basename` on the way in: the caller has already matched this name against a
   * database column, but a path check that exists in one place is a path check
   * somebody can route around. Traversal is neutralised where the path is built.
   */
  read(bucket: FileBucket, name: string): { stream: Readable; path: string } | null {
    const safe = basename(name);
    if (!safe || safe.startsWith('.')) return null;

    const path = join(this.bucketPath(bucket), safe);
    if (!existsSync(path)) return null;

    return { stream: createReadStream(path), path };
  }

  /**
   * The `Content-Type` to serve a stored file with, or `null` if we never wrote
   * that shape.
   *
   * ## Why this is trustworthy, and why the extension is the right source
   *
   * Reading a type from a filename is normally exactly the mistake this service
   * exists to prevent — but this is OUR filename. `write()` generates it as
   * `<uuid><ext>`, and picks `<ext>` from the bucket's map keyed on the type it
   * decided from the file's own MAGIC BYTES. The uploader's filename and their
   * multipart `Content-Type` are both discarded before that point. So the
   * extension here is a record of what the bytes actually were.
   *
   * ## Why serving without one was broken
   *
   * The routes streamed with no `Content-Type` at all, alongside
   * `X-Content-Type-Options: nosniff`. A PNG survives that — browsers still
   * decode it from its magic bytes — so nothing looked wrong for years. SVG has
   * no magic bytes: it is XML, and a browser that is forbidden to sniff and told
   * nothing will not render it as an image. The logo simply did not appear.
   *
   * `null` for an unrecognised extension, and the callers 404 on it. A file in
   * one of our buckets with an extension we never write is not one we wrote, and
   * guessing a type for it is the sniffing this whole class refuses to do.
   */
  contentType(bucket: FileBucket, name: string): string | null {
    const ext = extname(basename(name)).toLowerCase();
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
   * Delete a stored file. Absent or unset is a no-op, not an error.
   *
   * Accepts `undefined` because both callers pass a nullable column straight in:
   * a client removing a photo they never had, or replacing one where the
   * previous value was null, is an ordinary case rather than a failure.
   *
   * Never throws. Both call sites delete AFTER the row has been updated,
   * precisely so that a failed delete leaves an orphaned file and a correct
   * row — the recoverable direction. Rethrowing here would turn that
   * deliberate ordering into a failed request.
   */
  async remove(bucket: FileBucket, filename: string | null | undefined): Promise<void> {
    if (!filename) return;
    const safe = basename(filename);
    if (!safe) return;

    try {
      await unlink(join(this.bucketPath(bucket), safe));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // ENOENT is normal — the file may already be gone.
      if (!reason.includes('ENOENT')) {
        this.logger.warn(`Could not delete ${bucket.dir}/${safe}: ${reason}`);
      }
    }
  }
}

/**
 * Where an ADMINISTRATOR's avatar is served from.
 *
 * Composed at READ time, which is why the column holds a FILENAME. Kept here
 * rather than at each caller so the §8.5 move to private object storage — where
 * this becomes a signed, expiring URL — changes one expression instead of
 * hunting every screen that renders a photo.
 *
 * `admin-avatars`, not `avatars`, and the difference is the GUARD rather than
 * the storage: the bytes live in the client bucket alongside everyone else's,
 * but `/uploads/avatars/:file` is guarded by the portal's `JwtAuthGuard` and
 * checks ownership against `users`. An admin fetching their own photo through
 * it gets a 401 before the ownership check is even reached. See
 * `UploadsController.serveAdminAvatar`.
 */
export function adminAvatarUrl(filename: string): string {
  return `/uploads/admin-avatars/${filename}`;
}
