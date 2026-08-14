import { basename } from 'node:path';

/**
 * The object key scheme, as two pure functions.
 *
 * ## Why the key MIRRORS the URL path
 *
 * A stored KYC document is referenced in the database as `uploads/kyc/<uuid>.jpg`,
 * served at `GET /v1/uploads/kyc/<uuid>.jpg`, and its R2 key is `kyc/<uuid>.jpg`.
 * The three shapes differ by exactly one leading segment, and that is deliberate
 * rather than incidental — it is what made the move to object storage a change
 * inside the backend only:
 *
 *   - The database values are untouched. KYC file references live inside JSONB
 *     blobs (`kyc_submissions.document → frontFilePath`), so rewriting them would
 *     have meant a data migration over the compliance record.
 *   - The three pure URL builders in the frontends are untouched:
 *     `admin/src/lib/kyc-doc-url.ts`, `lib/avatar.ts`, `lib/asset-url.ts`.
 *   - Every ownership check is untouched. `submissionReferencesFile`,
 *     `assertDocumentInScope` and `ownerOfDocument` all compare `basename(path)`,
 *     which a prefix does not affect.
 *
 * If a future change makes a key stop being derivable from the served path, all of
 * the above becomes a migration. Keep them mirrored.
 *
 * ## Why keys are flat, with no date partitioning
 *
 * The obvious `kyc/2026/08/<uuid>.jpg` would break the mirror above for the sake of
 * a retention query that `stored_objects.created_at` already answers with an index.
 * R2 is not a filesystem — a flat prefix with a million objects is fine, and
 * `list()` is cursor-paginated for the reconciliation sweep.
 *
 * ## Why the filename is never trusted
 *
 * `basename` on the way in, always. Callers have usually matched the name against a
 * database column first, but a traversal guard that exists only at the call site is
 * one somebody can route around by adding a second call site. It is neutralised
 * where the key is built.
 */

/**
 * The provider key for a stored file: `<dir>/<filename>`.
 *
 * `dir` is the bucket's own directory name (`kyc`, `avatars`, `payment-logos`) — the
 * same value the disk driver uses as a subdirectory, which is what keeps the two
 * providers addressing one namespace.
 */
export function objectKey(dir: string, filename: string): string {
  const safe = basename(filename);
  if (!safe || safe === '.' || safe === '..' || safe.startsWith('.')) {
    throw new Error(`Refusing to build a storage key from an unsafe filename: ${filename}`);
  }
  return `${dir}/${safe}`;
}

/**
 * The value stored in the DATABASE for a KYC document: `uploads/<dir>/<filename>`.
 *
 * Kept identical to what multer's `diskStorage` produced before the R2 move, so
 * rows written before and after this change read the same and the frontends' URL
 * builders keep working with no branch. The `uploads/` segment is not part of the
 * object key — it is the API route prefix, and `objectKey` is what strips it.
 */
export function storedPath(dir: string, filename: string): string {
  return `uploads/${objectKey(dir, filename)}`;
}

/**
 * Recover the bare filename from any shape the database might hold.
 *
 * The shapes in the wild, all of which have been written at some point:
 * `uploads/kyc/x.jpg`, `./uploads/kyc/x.jpg`, `/uploads/kyc/x.jpg`,
 * `uploads\kyc\x.jpg` (Windows), and a bare `x.jpg` (avatars and logos store only
 * the filename). The admin app's `buildKycDocUrl` normalises the same set; this is
 * the backend half of that contract.
 *
 * Returns `null` for anything that cannot yield a safe name, so callers 404 rather
 * than guess.
 */
export function filenameFromStored(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const normalised = stored.replace(/\\/g, '/');

  /*
   * A trailing separator names a DIRECTORY, and `basename` does not agree.
   *
   * `basename('uploads/kyc/')` returns `'kyc'` — Node strips the trailing slash
   * first — so a path that names no file at all would resolve to the bucket's own
   * directory name. Downstream that becomes the key `kyc/kyc`, which 404s, so the
   * effect today is harmless; the reason to reject it here is that "this value names
   * a file" is the question this function answers, and answering it wrongly in a way
   * that happens to be safe is how the next caller gets surprised.
   */
  if (normalised.endsWith('/')) return null;

  const name = basename(normalised);
  if (!name || name === '.' || name === '..' || name.startsWith('.')) return null;
  return name;
}
