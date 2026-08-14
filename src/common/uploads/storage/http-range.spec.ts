import { describe, expect, it } from 'vitest';
import { etagFor, matchesEtag, parseRange } from './http-range';

/**
 * `Range` and `If-None-Match`.
 *
 * These matter because of what depends on them: a browser PDF viewer opens a scanned
 * document by asking for the trailer and then the first page, so a range served
 * wrongly does not error — it renders a blank or truncated document. On a KYC review
 * screen that means a reviewer deciding on half a passport, which is the kind of
 * failure that looks like a bad scan rather than a bug.
 */

describe('parseRange', () => {
  it('reads an ordinary closed range', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=200-299', 1000)).toEqual({ start: 200, end: 299 });
  });

  it('reads an open-ended range as "to the end"', () => {
    expect(parseRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 });
  });

  /*
   * ⚠️ The one that is easy to get backwards, and the FIRST request a PDF viewer
   * makes. `bytes=-500` means the LAST 500 bytes — where the trailer lives — not the
   * first 500. Reading it as a range starting at zero returns the header instead, and
   * the viewer concludes the file is not a PDF.
   */
  it('reads a suffix range as the LAST n bytes', () => {
    expect(parseRange('bytes=-500', 1000)).toEqual({ start: 500, end: 999 });
    // A suffix longer than the object is the whole object, not an error.
    expect(parseRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 });
  });

  it('clamps an end past the object rather than refusing it', () => {
    // Legal, and common: a client that does not know the size asks for more.
    expect(parseRange('bytes=900-99999', 1000)).toEqual({ start: 900, end: 999 });
  });

  it('reports a start past the end as unsatisfiable', () => {
    // Distinct from `null` on purpose: an empty 206 would let a viewer conclude the
    // document is truncated.
    expect(parseRange('bytes=1000-', 1000)).toBe('unsatisfiable');
    expect(parseRange('bytes=5000-6000', 1000)).toBe('unsatisfiable');
    expect(parseRange('bytes=-0', 1000)).toBe('unsatisfiable');
  });

  it('ignores headers it does not implement, so the whole object is served', () => {
    // RFC 7233 permits ignoring a Range we decline; every browser copes. Refusing
    // would break a client that asked politely for something unimplemented.
    expect(parseRange('bytes=0-99,200-299', 1000)).toBeNull(); // multi-range
    expect(parseRange('items=0-99', 1000)).toBeNull(); // unknown unit
    expect(parseRange('bytes=-', 1000)).toBeNull();
    expect(parseRange('nonsense', 1000)).toBeNull();
  });

  it('handles a single-byte object', () => {
    expect(parseRange('bytes=0-0', 1)).toEqual({ start: 0, end: 0 });
    expect(parseRange('bytes=1-', 1)).toBe('unsatisfiable');
  });
});

describe('matchesEtag', () => {
  const etag = '"1f4-18c"';

  it('matches an identical tag', () => {
    expect(matchesEtag(etag, etag)).toBe(true);
  });

  it('matches within a list, as browsers send', () => {
    expect(matchesEtag(`"other", ${etag}`, etag)).toBe(true);
  });

  it('matches `*`', () => {
    expect(matchesEtag('*', etag)).toBe(true);
  });

  /*
   * WEAK comparison, per RFC 7232 for this header.
   *
   * A proxy may weaken an ETag in transit. Comparing strictly would not fail
   * visibly — it would silently stop every revalidation from matching, which reads as
   * "caching just does not work here" and gets investigated months later.
   */
  it('ignores the weak prefix on either side', () => {
    expect(matchesEtag(`W/${etag}`, etag)).toBe(true);
  });

  it('does not match a different tag', () => {
    expect(matchesEtag('"deadbeef"', etag)).toBe(false);
    expect(matchesEtag('', etag)).toBe(false);
  });
});

describe('etagFor', () => {
  it('changes when either the size or the timestamp changes', () => {
    const base = etagFor(500, 1_700_000_000_000);
    expect(etagFor(501, 1_700_000_000_000)).not.toBe(base);
    expect(etagFor(500, 1_700_000_001_000)).not.toBe(base);
    expect(etagFor(500, 1_700_000_000_000)).toBe(base);
  });

  it('is quoted, as the header syntax requires', () => {
    expect(etagFor(1, 2)).toMatch(/^".+"$/);
  });
});
