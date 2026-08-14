/**
 * `Range` and `If-None-Match` semantics, as pure functions.
 *
 * R2 implements both server-side, so `R2StorageDriver` forwards the raw headers and
 * never calls into this file. The disk and in-memory drivers have to implement them
 * themselves — and they must implement them the SAME way, because one shared
 * contract spec runs against every driver. A fake that answers a range differently
 * from the real store is worse than no fake at all: it makes the suite green and the
 * document viewer broken.
 *
 * Extracted here rather than duplicated in each driver for exactly that reason.
 */

/** A resolved byte range, inclusive at both ends — the same convention HTTP uses. */
export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Parse a single-range `Range` header against a known total size.
 *
 * Three outcomes, and the distinction between the last two matters:
 *
 *  - a `ByteRange` — honour it, respond 206
 *  - `null` — a header we decline to honour (multi-range, an unknown unit, a
 *    malformed value). RFC 7233 permits ignoring it, and every browser copes with
 *    the whole object arriving instead. Refusing would break a client that asked
 *    politely for something we simply do not implement.
 *  - `'unsatisfiable'` — a range that starts past the end of the object. This is a
 *    client error rather than a preference, and returning an empty 206 for it
 *    would let a viewer conclude the file is truncated.
 */
export function parseRange(header: string, size: number): ByteRange | 'unsatisfiable' | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;

  let start: number;
  let end: number;

  if (rawStart === '') {
    // `bytes=-500` is a SUFFIX request — the last 500 bytes — not a range starting
    // at zero. Reading it as the latter is the classic off-by-everything here, and
    // it is what a PDF viewer sends first to find the trailer.
    const suffix = Number.parseInt(rawEnd, 10);
    if (suffix <= 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number.parseInt(rawStart, 10);
    end = rawEnd === '' ? size - 1 : Number.parseInt(rawEnd, 10);
  }

  if (!Number.isFinite(start) || start < 0 || start >= size) return 'unsatisfiable';
  // Asking past the end is legal and is clamped, not refused.
  end = Math.min(end, size - 1);
  if (end < start) return 'unsatisfiable';
  return { start, end };
}

/**
 * Does an `If-None-Match` header match this ETag?
 *
 * WEAK comparison — `W/` is stripped before comparing — because that is what RFC
 * 7232 specifies for this header, and because a proxy is allowed to weaken an ETag
 * in transit. Comparing strictly would not fail visibly; it would silently disable
 * caching, which is the kind of regression nobody reports.
 *
 * Handles `*` and a comma-separated list, both of which real clients send.
 */
export function matchesEtag(header: string, etag: string): boolean {
  if (header.trim() === '*') return true;
  const normalise = (v: string) => v.trim().replace(/^W\//, '');
  const target = normalise(etag);
  return header.split(',').some((candidate) => normalise(candidate) === target);
}

/** `<size>-<mtimeMs>` in hex — changes whenever the bytes could have changed. */
export function etagFor(size: number, mtimeMs: number): string {
  return `"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`;
}
