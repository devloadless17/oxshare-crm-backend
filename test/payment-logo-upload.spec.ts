import { describe, expect, it } from 'vitest';
import { PAYMENT_LOGO_BUCKET } from '../src/common/uploads/stored-files.service';
import { sniffMimeType } from '../src/common/uploads/file-signature';
import { storageStub } from './storage-stub';

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

// An admin uploading a brand mark: no owner, and so no storage quota — see
// PAYMENT_LOGO_BUCKET.countsTowardOwnerQuota.
const ADMIN_UPLOADER = {
  id: '00000000-0000-4000-8000-000000000001',
  kind: 'admin' as const,
  ownerUserId: null,
};

/*
 * In-memory: nothing here touches the filesystem or Cloudflare R2.
 *
 * This suite used to write under `./uploads` and delete the directory afterwards.
 * With the storage driver in place it asserts against the STORE instead, which is
 * both faster and honest about what is being tested — these cases are about which
 * bytes are accepted, not about where they land.
 */
const { files, driver, registry } = storageStub();

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
    const stored = await files.write(PAYMENT_LOGO_BUCKET, PNG, 'image/png', ADMIN_UPLOADER);

    expect(stored.mimeType).toBe('image/png');
    expect(stored.filename).toMatch(/^[0-9a-f-]{36}\.png$/);
    // NEVER the uploaded filename — that is client-controlled text on a path.
    expect(stored.size).toBe(PNG.length);
  });

  it('stores an SVG', async () => {
    const stored = await files.write(PAYMENT_LOGO_BUCKET, SVG, 'image/svg+xml', ADMIN_UPLOADER);

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
    await expect(
      files.write(PAYMENT_LOGO_BUCKET, PNG, 'image/svg+xml', ADMIN_UPLOADER),
    ).rejects.toThrow();
  });

  /*
   * ⚠️ THE stored-XSS case, end to end. HTML declared as SVG must not be
   * written, whatever the multipart header said.
   */
  it('refuses an HTML document declared as SVG', async () => {
    const html = Buffer.from('<html><script>alert(document.cookie)</script></html>');
    await expect(
      files.write(PAYMENT_LOGO_BUCKET, html, 'image/svg+xml', ADMIN_UPLOADER),
    ).rejects.toThrow();
  });

  it('refuses a file over the bucket ceiling', async () => {
    const tooBig = Buffer.concat([PNG, Buffer.alloc(PAYMENT_LOGO_BUCKET.maxBytes)]);
    await expect(
      files.write(PAYMENT_LOGO_BUCKET, tooBig, 'image/png', ADMIN_UPLOADER),
    ).rejects.toThrow();
  });
});

/*
 * The registry half, added with object storage.
 *
 * These assert the two properties that make "who uploaded this" answerable at all:
 * a row exists per stored object, and a REFUSED upload leaves neither a row nor an
 * object. The second is the one worth having — a rejection that still wrote bytes
 * would leave unreferenced files accumulating with nothing pointing at them.
 */
describe('the upload registry', () => {
  it('records the object with its SNIFFED type, size and checksum', async () => {
    const before = registry.recorded.length;
    const stored = await files.write(PAYMENT_LOGO_BUCKET, PNG, 'image/png', ADMIN_UPLOADER);

    const row = registry.recorded[before];
    expect(row.bucket).toBe(PAYMENT_LOGO_BUCKET.dir);
    expect(row.storageKey).toBe(`payment-logos/${stored.filename}`);
    expect(row.contentType).toBe('image/png');
    expect(row.byteSize).toBe(PNG.length);
    expect(row.sha256).toBe(stored.sha256);
    expect(row.uploadedById).toBe(ADMIN_UPLOADER.id);
    expect(row.uploadedByKind).toBe('admin');
    // A brand mark belongs to nobody — and an admin id is not in `users`, so
    // attributing it to the uploader would violate the foreign key.
    expect(row.ownerUserId).toBeNull();
  });

  it('writes the bytes the caller supplied, under the generated key', async () => {
    const stored = await files.write(PAYMENT_LOGO_BUCKET, SVG, 'image/svg+xml', ADMIN_UPLOADER);
    expect(driver.peek(`payment-logos/${stored.filename}`)).toEqual(SVG);
  });

  it('stores NOTHING when the bytes are refused', async () => {
    const objectsBefore = driver.size;
    const rowsBefore = registry.recorded.length;

    const html = Buffer.from('<html><script>alert(document.cookie)</script></html>');
    await expect(
      files.write(PAYMENT_LOGO_BUCKET, html, 'image/svg+xml', ADMIN_UPLOADER),
    ).rejects.toThrow();

    expect(driver.size).toBe(objectsBefore);
    expect(registry.recorded.length).toBe(rowsBefore);
  });
});
