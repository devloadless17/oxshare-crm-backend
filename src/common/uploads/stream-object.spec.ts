import { describe, expect, it, vi } from 'vitest';
import { PassThrough, Readable } from 'node:stream';
import type { Response } from 'express';
import { inlineDisposition, streamObject } from './stream-object';

/**
 * The response mechanics.
 *
 * These are worth pinning because each has a failure mode that does not look like a
 * failure: a 304 with a body hangs, a 206 without `Content-Range` renders as a
 * truncated document, and a mid-stream error ended cleanly delivers half a passport
 * that looks whole.
 */

/**
 * A minimal Express `Response` that records what was set.
 *
 * Built ON a real `PassThrough` rather than as a plain object, because
 * `streamObject` calls `source.pipe(res)` — a stand-in that is not a genuine
 * writable fails inside Node's stream machinery rather than in an assertion, which
 * tells you nothing about the code under test.
 */
function fakeResponse() {
  const res = new PassThrough() as PassThrough & {
    headers: Record<string, string>;
    statusCode: number;
    headersSent: boolean;
    ended: boolean;
    wasDestroyed: boolean;
    setHeader(name: string, value: string): void;
    status(code: number): unknown;
    end(): unknown;
  };

  res.headers = {};
  res.statusCode = 200;
  res.headersSent = false;
  res.ended = false;
  res.wasDestroyed = false;

  res.setHeader = (name: string, value: string) => {
    res.headers[name.toLowerCase()] = value;
  };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  const streamEnd = res.end.bind(res);
  res.end = () => {
    res.ended = true;
    return streamEnd();
  };
  // `destroy` is real on a PassThrough; record that it was called without losing the
  // behaviour, since the mid-stream case asserts on both.
  const streamDestroy = res.destroy.bind(res);
  res.destroy = (error?: Error) => {
    res.wasDestroyed = true;
    return streamDestroy(error);
  };

  return res;
}

const HEADERS = {
  contentType: 'image/png',
  cacheControl: 'no-store, private',
  contentSecurityPolicy: "default-src 'none'; sandbox",
};

describe('a full response', () => {
  it('sets the security headers, the type, the length and Accept-Ranges', () => {
    const res = fakeResponse();
    streamObject(
      res as unknown as Response,
      { stream: Readable.from(Buffer.from('hello')), contentLength: 5 },
      HEADERS,
    );

    expect(res.headers['content-type']).toBe('image/png');
    // Never let a stored upload be sniffed into active content on the origin that
    // holds the session cookies.
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(res.headers['cache-control']).toBe('no-store, private');
    expect(res.headers['content-length']).toBe('5');
    // What tells a PDF viewer it may fetch by range at all. Without it the viewer
    // downloads the whole document before painting page one.
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.statusCode).toBe(200);
  });
});

describe('a partial response', () => {
  it('is a 206 carrying Content-Range and the length of the PART', () => {
    const res = fakeResponse();
    streamObject(
      res as unknown as Response,
      {
        stream: Readable.from(Buffer.from('01234')),
        contentLength: 5,
        contentRange: 'bytes 0-4/100',
        partial: true,
      },
      HEADERS,
    );

    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 0-4/100');
    // The PART's length, not the object's — a 206 declaring the whole size makes the
    // client wait for bytes that are not coming.
    expect(res.headers['content-length']).toBe('5');
  });
});

describe('a conditional hit', () => {
  /*
   * ⚠️ A 304 must carry NO body, and no `Content-Length` or `Content-Type`.
   *
   * Sending either makes some clients wait for a body that never arrives — a hang
   * rather than an error, which is the hardest kind to attribute.
   */
  it('is a bare 304 with the validator and nothing else', () => {
    const res = fakeResponse();
    streamObject(res as unknown as Response, { notModified: true, etag: '"abc"' }, HEADERS);

    expect(res.statusCode).toBe(304);
    expect(res.ended).toBe(true);
    expect(res.headers['etag']).toBe('"abc"');
    expect(res.headers['content-length']).toBeUndefined();
    expect(res.headers['content-type']).toBeUndefined();
    // Still sent, so the browser knows how to keep revalidating.
    expect(res.headers['cache-control']).toBe('no-store, private');
  });
});

describe('failure part way through', () => {
  /*
   * The status line and headers are already on the wire, and `Content-Length` has
   * promised a byte count that is not coming. Destroying the response resets the
   * connection so the client fails loudly; ending it cleanly would deliver a partial
   * document that LOOKS complete — on a review screen, a reviewer deciding on half a
   * passport.
   */
  it('destroys the response rather than ending it cleanly', () => {
    const res = fakeResponse();
    const source = new PassThrough();
    streamObject(res as unknown as Response, { stream: source, contentLength: 100 }, HEADERS);

    res.headersSent = true;
    source.emit('error', new Error('connection reset'));

    expect(res.wasDestroyed).toBe(true);
    expect(res.ended).toBe(false);
  });

  it('sends a 500 when nothing has been written yet', () => {
    const res = fakeResponse();
    const source = new PassThrough();
    streamObject(res as unknown as Response, { stream: source, contentLength: 100 }, HEADERS);

    res.headersSent = false;
    source.emit('error', new Error('connection reset'));

    expect(res.statusCode).toBe(500);
  });
});

describe('client disconnect', () => {
  /*
   * A reviewer closing a lightbox mid-load must not leave the upstream read running.
   * Otherwise the socket, the SDK's in-flight request and its buffers stay held until
   * the object finishes transferring to nobody — a slow leak with no obvious cause.
   */
  it('destroys the source stream', () => {
    const res = fakeResponse();
    const source = new PassThrough();
    const destroy = vi.spyOn(source, 'destroy');

    streamObject(res as unknown as Response, { stream: source, contentLength: 100 }, HEADERS);
    res.emit('close');

    expect(destroy).toHaveBeenCalled();
  });
});

describe('inlineDisposition', () => {
  it('quotes the filename', () => {
    expect(inlineDisposition('9f2c.pdf')).toBe('inline; filename="9f2c.pdf"');
  });

  /*
   * Defence in depth. Every caller resolves the name against a stored `<uuid><ext>`
   * first, so a crafted value cannot reach here today — but the check that protects
   * it is three call frames away in another file, and CR/LF is header injection
   * outright rather than merely a broken value.
   */
  it('strips anything that could break out of the quoted value', () => {
    expect(inlineDisposition('a".png')).toBe('inline; filename="a_.png"');
    expect(inlineDisposition('a\r\nX-Evil: 1')).not.toMatch(/[\r\n]/);
    expect(inlineDisposition('a\\b.png')).toBe('inline; filename="a_b.png"');
  });
});
