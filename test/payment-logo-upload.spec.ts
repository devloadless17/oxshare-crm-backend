import { afterAll, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  PAYMENT_LOGO_BUCKET,
  StoredFilesService,
} from '../src/common/uploads/stored-files.service';
import { sniffMimeType } from '../src/common/uploads/file-signature';

/**
 * Payment-method logo uploads.
 *
 * The assertion that earns its keep is the LAST one: an HTML document renamed
 * `.svg` and declared `image/svg+xml` must be refused. That substitution is how
 * an upload endpoint becomes stored XSS, and nothing about it fails loudly —
 * the file writes, the URL works, and it executes in whoever opens it.
 *
 * SVG is the one accepted type with no magic bytes, so it is also the one where
 * the type check is a text scan rather than a signature. These tests exist
 * because that scan is the only thing standing between the two cases.
 */

const files = new StoredFilesService();

/** A real 1x1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>',
);

const SVG_WITH_PROLOGUE = Buffer.from(
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!-- exported from a design tool -->\n' +
    '<svg xmlns="http://www.w3.org/2000/svg"><rect width="8" height="8"/></svg>',
);

/** A BOM, as Windows editors write. */
const SVG_WITH_BOM = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), SVG]);

afterAll(async () => {
  // The bucket writes under ./uploads; leave nothing behind.
  await rm(join(process.cwd(), 'uploads', PAYMENT_LOGO_BUCKET.dir), {
    recursive: true,
    force: true,
  });
});

describe('sniffing', () => {
  it('recognises the raster formats by signature', () => {
    expect(sniffMimeType(PNG)).toBe('image/png');
  });

  it('recognises SVG in all three shapes an editor produces', () => {
    expect(sniffMimeType(SVG)).toBe('image/svg+xml');
    expect(sniffMimeType(SVG_WITH_PROLOGUE)).toBe('image/svg+xml');
    expect(sniffMimeType(SVG_WITH_BOM)).toBe('image/svg+xml');
  });

  /*
   * ⚠️ THE one that matters. An HTML document is text, like SVG, so a naive
   * "is it text?" check would accept it — and a stored HTML page served from
   * our own origin is stored XSS.
   */
  it('refuses an HTML document, however it is dressed', () => {
    expect(
      sniffMimeType(Buffer.from('<!doctype html><html><body>hi</body></html>')),
    ).toBeUndefined();
    expect(sniffMimeType(Buffer.from('<html><script>alert(1)</script></html>'))).toBeUndefined();
    expect(sniffMimeType(Buffer.from('  \n <script>alert(1)</script>'))).toBeUndefined();
  });

  it('refuses arbitrary text and empty files', () => {
    expect(sniffMimeType(Buffer.from('just some notes'))).toBeUndefined();
    expect(sniffMimeType(Buffer.alloc(0))).toBeUndefined();
  });
});

describe('writing a logo', () => {
  it('stores a PNG under a generated name and the right extension', async () => {
    const stored = await files.write(PAYMENT_LOGO_BUCKET, PNG, 'image/png');

    expect(stored.mimeType).toBe('image/png');
    expect(stored.filename).toMatch(/^[0-9a-f-]{36}\.png$/);
    // NEVER the uploaded filename — that is client-controlled text on a path.
    expect(stored.size).toBe(PNG.length);
  });

  it('stores an SVG', async () => {
    const stored = await files.write(PAYMENT_LOGO_BUCKET, SVG, 'image/svg+xml');

    expect(stored.mimeType).toBe('image/svg+xml');
    expect(stored.filename).toMatch(/^[0-9a-f-]{36}\.svg$/);
  });

  /*
   * The declared type is a CLAIM by the uploader and is checked against the
   * bytes. A PNG declared as SVG is refused not because either is dangerous, but
   * because the two must agree — that agreement is what stops the dangerous case
   * below from having a way through.
   */
  it('refuses a file whose declared type contradicts its bytes', async () => {
    await expect(files.write(PAYMENT_LOGO_BUCKET, PNG, 'image/svg+xml')).rejects.toThrow();
  });

  /*
   * ⚠️ THE stored-XSS case, end to end. HTML declared as SVG must not be
   * written, whatever the multipart header said.
   */
  it('refuses an HTML document declared as SVG', async () => {
    const html = Buffer.from('<html><script>alert(document.cookie)</script></html>');
    await expect(files.write(PAYMENT_LOGO_BUCKET, html, 'image/svg+xml')).rejects.toThrow();
  });

  it('refuses a file over the bucket ceiling', async () => {
    const tooBig = Buffer.concat([PNG, Buffer.alloc(PAYMENT_LOGO_BUCKET.maxBytes)]);
    await expect(files.write(PAYMENT_LOGO_BUCKET, tooBig, 'image/png')).rejects.toThrow();
  });
});
