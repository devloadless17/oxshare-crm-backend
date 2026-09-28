import { describe, expect, it } from 'vitest';
import { versionFromIfMatch } from './if-match';

const DIGEST = 'dbd9037ba33558a337c4fe43b67fc407a24f00450c4a7ae81061583add997741';

describe('the version an If-Match names', () => {
  it('reads the ETag exactly as the API issued it', () => {
    expect(versionFromIfMatch(`"${DIGEST}"`)).toBe(DIGEST);
    expect(versionFromIfMatch(DIGEST)).toBe(DIGEST);
  });

  /*
   * The production bug (28 Sep 2026): Caddy's `encode zstd gzip` appends the
   * encoding to a strong ETag it compresses. These are the exact values the
   * production image handed a browser and a gzip client for one form.
   */
  it('finds the digest inside the ETag as Caddy rewrites it for a compressed response', () => {
    expect(versionFromIfMatch(`"${DIGEST}-zstd"`)).toBe(DIGEST);
    expect(versionFromIfMatch(`"${DIGEST}-gzip"`)).toBe(DIGEST);
    expect(versionFromIfMatch(`"${DIGEST}-br"`)).toBe(DIGEST);
  });

  it('finds it inside an ETag a proxy weakened, too', () => {
    expect(versionFromIfMatch(`W/"${DIGEST}"`)).toBe(DIGEST);
    expect(versionFromIfMatch(`W/"${DIGEST}-gzip"`)).toBe(DIGEST);
    expect(versionFromIfMatch(` "${DIGEST.toUpperCase()}" `)).toBe(DIGEST);
  });

  it('names no version when the header is absent or blank — the caller sent none', () => {
    expect(versionFromIfMatch(undefined)).toBeUndefined();
    expect(versionFromIfMatch('   ')).toBeUndefined();
  });

  it('never invents a digest: anything else is returned as sent, and matches nothing', () => {
    expect(versionFromIfMatch('"v1"')).toBe('"v1"');
    expect(versionFromIfMatch('*')).toBe('*');
    // One hex digit too many is not our digest with something around it.
    expect(versionFromIfMatch(`"${DIGEST}a"`)).toBe(`"${DIGEST}a"`);
  });
});
