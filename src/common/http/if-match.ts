/**
 * THE VERSION AN `If-Match` HEADER NAMES — our digest, however the trip
 * decorated it.
 *
 * The KYC form's version is a sha256 hex digest, issued as a STRONG `ETag`
 * (`"<digest>"`). What comes back in `If-Match` is whatever the round trip made
 * of that, and in production it is never the original:
 *
 *  - Caddy's `encode` (production runs `encode zstd gzip`) rewrites a strong
 *    ETag on every response it compresses by APPENDING the encoding, so a
 *    browser is handed `"<digest>-zstd"` and a gzip client `"<digest>-gzip"`.
 *    Measured with the production image, `caddy:2` (v2.11.4), on 28 Sep 2026.
 *  - A CDN or nginx that compresses may WEAKEN it instead: `W/"<digest>"`.
 *
 * Compared as it arrived, every save of the builder in production answered 409
 * KYC_CONFIG_STALE — "someone else changed this form" — when nobody had.
 * Localhost has no proxy, so every test passed. The digest has a fixed shape,
 * so it is FOUND inside whatever was wrapped around it rather than peeled by a
 * list of known wrappers that the next proxy would outgrow.
 *
 * Absent or blank is `undefined`: the caller named no version, which the
 * service lets through (last write wins), so deploying the API first breaks no
 * screen. A value holding no digest is returned as sent, so it cannot match.
 */
export function versionFromIfMatch(ifMatch: string | undefined): string | undefined {
  const value = ifMatch?.trim();
  if (!value) return undefined;
  return /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/i.exec(value)?.[0].toLowerCase() ?? value;
}
