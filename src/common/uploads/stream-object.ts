import type { Response } from 'express';
import type { StorageObject } from './storage/storage-driver';

/**
 * Send a stored object to a browser.
 *
 * Extracted from `uploads.controller.ts` because four handlers do this and each got
 * it slightly differently before — one of them forgot `Content-Type` entirely, which
 * is why an uploaded SVG logo silently failed to render on the deposit screen for
 * everybody. Response mechanics belong in one place; the controller keeps the part
 * that is actually about authorization.
 *
 * The caller supplies the security headers per route, because they genuinely differ:
 * an identity document is `no-store` with `default-src 'none'; sandbox`, and a
 * public brand mark needs `style-src 'unsafe-inline'` so an SVG can colour its own
 * shapes. Those are decisions about the CONTENT, so they stay with the handler that
 * knows what it is serving.
 */

export interface StreamHeaders {
  /** Decided from the STORED extension, which records what the magic bytes were. */
  contentType: string;
  /** `no-store, private` for PII; `public, max-age=…` for brand marks. */
  cacheControl: string;
  /** The per-response CSP. Never omitted — this origin holds the session cookies. */
  contentSecurityPolicy: string;
  /** `inline; filename="…"`, when the browser should display rather than download. */
  contentDisposition?: string;
}

/**
 * Strip anything that could break out of a quoted header value.
 *
 * `Content-Disposition: inline; filename="<name>"` interpolates a name into a quoted
 * string, so a `"` in it would let the rest be read as further header parameters.
 *
 * **This is defence in depth, not a live fix.** Every caller resolves the name
 * against a stored `<uuid><ext>` before reaching here, so a crafted value cannot get
 * this far today. The guard is one line and the check protecting it is three call
 * frames away in another file — the distance is the reason to have both.
 *
 * CR and LF matter most: those are header injection outright, not merely a broken
 * value.
 */
function safeHeaderFilename(name: string): string {
  return name.replace(/["\\\r\n]/g, '_');
}

/**
 * Pipe an object to the response, honouring conditional and partial requests.
 *
 * Returns nothing; the response is complete (or completing) when this resolves.
 */
export function streamObject(res: Response, object: StorageObject, headers: StreamHeaders): void {
  /*
   * A 304 carries no body, and MUST NOT carry Content-Length or Content-Type.
   *
   * Sending them makes some clients wait for a body that will never arrive. The
   * validators still go out so the browser can keep revalidating.
   */
  if (object.notModified) {
    if (object.etag) res.setHeader('ETag', object.etag);
    res.setHeader('Cache-Control', headers.cacheControl);
    res.status(304).end();
    return;
  }

  if (!object.stream) {
    // A driver returning neither a stream nor `notModified` is a bug in the driver,
    // not a missing file — the caller has already handled null.
    res.status(500).end();
    return;
  }

  res.setHeader('Content-Type', headers.contentType);
  // Never let a stored upload be sniffed into active content on the origin that
  // holds the session cookies.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', headers.contentSecurityPolicy);
  res.setHeader('Cache-Control', headers.cacheControl);
  if (headers.contentDisposition) {
    res.setHeader('Content-Disposition', headers.contentDisposition);
  }
  if (object.etag) res.setHeader('ETag', object.etag);

  /*
   * `Accept-Ranges` is what tells a PDF viewer it may fetch by range at all.
   *
   * Without it the viewer downloads the whole document before painting page one —
   * on a 10MB scan over a phone connection that is the difference between a
   * document that opens and one that appears broken.
   */
  res.setHeader('Accept-Ranges', 'bytes');

  if (object.partial && object.contentRange) {
    res.setHeader('Content-Range', object.contentRange);
    res.status(206);
  }

  // Set from the driver so the browser can show real progress and knows when the
  // body is complete. On a partial response this is the length of the PART.
  if (typeof object.contentLength === 'number') {
    res.setHeader('Content-Length', String(object.contentLength));
  }

  const source = object.stream;

  /*
   * If the reader goes away, stop reading.
   *
   * A reviewer closing a lightbox mid-load leaves the upstream request open
   * otherwise — the socket, the SDK's in-flight request and its buffers all held
   * until the object finishes transferring to nobody. Across a review queue that is
   * a slow leak with no obvious cause.
   */
  res.on('close', () => {
    if (!source.destroyed) source.destroy();
  });

  /*
   * A failure PART WAY THROUGH cannot be turned into an error response — the status
   * line and headers are already on the wire, and `Content-Length` has promised a
   * byte count we are not going to deliver.
   *
   * Destroying the response is the only honest signal available: it resets the
   * connection, so the client sees a truncated transfer and fails loudly. Ending it
   * cleanly instead would deliver a partial document that LOOKS complete, which on a
   * KYC review screen means a reviewer deciding on half a passport.
   */
  source.on('error', () => {
    if (!res.headersSent) {
      res.status(500).end();
      return;
    }
    res.destroy();
  });

  source.pipe(res);
}

/** `inline; filename="…"`, with the name made safe for a quoted header value. */
export function inlineDisposition(filename: string): string {
  return `inline; filename="${safeHeaderFilename(filename)}"`;
}
