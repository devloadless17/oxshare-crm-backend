import { describe, expect, it } from 'vitest';
import { SIGNATURE_BYTES, signatureMatchesDeclared, sniffMimeType } from './file-signature';

/**
 * KYC upload type checking trusted `file.mimetype` — the Content-Type the
 * CLIENT writes into the multipart part header. It is a claim by the uploader,
 * not an observation, and multer cannot verify it because a `fileFilter` runs
 * before any bytes are on disk.
 *
 * So an authenticated client could upload an HTML document, declare it
 * `image/png`, and have it stored as `<uuid>.png` under `./uploads/kyc` — the
 * same directory holding every identity document, on the API host's local disk.
 *
 * `uploads.controller.ts` sends `X-Content-Type-Options: nosniff`, which is what
 * stops a reviewing admin's browser executing it. That one header being the
 * whole defence is the argument for this check, not against it: a header is easy
 * to lose in a proxy config, and the account it protects can read every client's
 * documents.
 */

function header(...bytes: number[]): Buffer {
  const buffer = Buffer.alloc(SIGNATURE_BYTES);
  Buffer.from(bytes).copy(buffer);
  return buffer;
}

const JPEG = header(0xff, 0xd8, 0xff, 0xe0);
const PNG = header(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const PDF = header(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34);
const WEBP = header(0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50);

describe('file signatures', () => {
  it('identifies the four types KYC accepts', () => {
    expect(sniffMimeType(JPEG)).toBe('image/jpeg');
    expect(sniffMimeType(PNG)).toBe('image/png');
    expect(sniffMimeType(PDF)).toBe('application/pdf');
    expect(sniffMimeType(WEBP)).toBe('image/webp');
  });

  it('returns undefined for something it does not recognise', () => {
    // Not a guess. An unrecognised file is not a JPEG we failed to identify, it
    // is a file we have no reason to accept.
    expect(sniffMimeType(Buffer.from('<!DOCTYPE html><script>'))).toBeUndefined();
    expect(sniffMimeType(Buffer.alloc(0))).toBeUndefined();
  });

  it('does not mistake other RIFF containers for WebP', () => {
    // AVI and WAV share RIFF's first four bytes; the 'WEBP' tag at byte 8 is the
    // only thing distinguishing them.
    const avi = header(0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x41, 0x56, 0x49, 0x20);
    expect(sniffMimeType(avi)).toBeUndefined();
  });
});

describe('declared type versus content', () => {
  /** The finding, stated as a test. */
  it('rejects HTML dressed as a PNG', () => {
    const html = Buffer.from('<!DOCTYPE html><script>alert(document.cookie)</script>');
    expect(signatureMatchesDeclared(html, 'image/png')).toBe(false);
  });

  it('rejects an SVG declared as an image, which a browser would execute', () => {
    // SVG is not in the accepted set at all, and it is the specific case that
    // makes "it is only an image" untrue — an SVG can carry script.
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
    expect(signatureMatchesDeclared(svg, 'image/png')).toBe(false);
    expect(signatureMatchesDeclared(svg, 'image/svg+xml')).toBe(false);
  });

  it('accepts each real type under its own declaration', () => {
    expect(signatureMatchesDeclared(JPEG, 'image/jpeg')).toBe(true);
    expect(signatureMatchesDeclared(PNG, 'image/png')).toBe(true);
    expect(signatureMatchesDeclared(PDF, 'application/pdf')).toBe(true);
    expect(signatureMatchesDeclared(WEBP, 'image/webp')).toBe(true);
  });

  it('rejects a real file under the WRONG declaration', () => {
    // Content alone is not the test: a genuine JPEG stored under a .pdf name is
    // still a file whose extension lies about it.
    expect(signatureMatchesDeclared(JPEG, 'application/pdf')).toBe(false);
    expect(signatureMatchesDeclared(PDF, 'image/png')).toBe(false);
  });

  it('tolerates image/jpg, which browsers and phone cameras really send', () => {
    // Not a registered type, but refusing it would reject genuine passport
    // photographs to no benefit.
    expect(signatureMatchesDeclared(JPEG, 'image/jpg')).toBe(true);
    expect(signatureMatchesDeclared(JPEG, 'IMAGE/JPEG')).toBe(true);
    expect(signatureMatchesDeclared(JPEG, ' image/jpeg ')).toBe(true);
  });

  it('rejects a file too short to carry a signature', () => {
    expect(signatureMatchesDeclared(Buffer.from([0xff, 0xd8]), 'image/jpeg')).toBe(false);
  });
});
