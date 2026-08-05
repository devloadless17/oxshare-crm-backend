/**
 * What a file ACTUALLY is, read from its first bytes — a pure seam.
 *
 * No Nest, no Drizzle, no fs: the caller reads the header and passes it in, so
 * this is unit-testable without a container or a temp directory.
 *
 * ## Why the declared type is not enough
 *
 * `fileFilter` and the stored filename were both decided from `file.mimetype`,
 * which is the `Content-Type` the CLIENT wrote into the multipart part header.
 * It is a claim by the uploader, not an observation, and multer cannot check it:
 * a `fileFilter` runs before any bytes are on disk.
 *
 * So an authenticated client could upload an HTML document, declare it
 * `image/png`, and have it stored as `<uuid>.png` under `./uploads/kyc` — the
 * same directory every identity document lives in, on the API host's local disk
 * (ARCHITECTURE §8.5's private-S3 move is still pending).
 *
 * `uploads.controller.ts` sends `X-Content-Type-Options: nosniff`, which is what
 * stops a reviewing admin's browser from executing it, so this is defence in
 * depth rather than an open hole. That is exactly the argument for adding it: a
 * single header is the whole thing standing between a stored file and a stored
 * XSS against the one account that can read every client's documents, and a
 * header is easy to lose in a proxy config.
 *
 * ## Signatures only, deliberately
 *
 * This does not parse the files. A signature check answers "is this plausibly
 * the type it claims", which is the question that matters here; a full parse
 * would mean running a decoder over hostile input, which trades this risk for a
 * larger one.
 */

/** The four types KYC accepts, by their leading bytes. */
const SIGNATURES: { mime: string; magic: number[]; offset?: number }[] = [
  { mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  { mime: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'application/pdf', magic: [0x25, 0x50, 0x44, 0x46] }, // %PDF
  // RIFF....WEBP — the container tag sits at byte 8, after a 4-byte length.
  { mime: 'image/webp', magic: [0x52, 0x49, 0x46, 0x46] },
];

/** How many bytes a caller needs to read for `sniffMimeType` to decide. */
export const SIGNATURE_BYTES = 16;

function startsWith(header: Buffer, magic: number[], offset = 0): boolean {
  if (header.length < offset + magic.length) return false;
  return magic.every((byte, i) => header[offset + i] === byte);
}

/**
 * The type the bytes say it is, or `undefined` for anything unrecognised.
 *
 * `undefined` rather than a guess: an unrecognised file is not a JPEG we failed
 * to identify, it is a file we have no reason to accept.
 */
export function sniffMimeType(header: Buffer): string | undefined {
  for (const { mime, magic } of SIGNATURES) {
    if (!startsWith(header, magic)) continue;
    if (mime === 'image/webp') {
      // RIFF is a container: AVI and WAV share the same first four bytes. The
      // 'WEBP' tag at byte 8 is what distinguishes them, so a RIFF file that is
      // not WebP falls through to undefined rather than being accepted.
      return startsWith(header, [0x57, 0x45, 0x42, 0x50], 8) ? mime : undefined;
    }
    return mime;
  }
  return undefined;
}

/**
 * Does the content agree with what the client said it was?
 *
 * Both halves must hold. Content alone would let a real JPEG be stored under a
 * `.pdf` name; the declared type alone is the hole this closes.
 */
export function signatureMatchesDeclared(header: Buffer, declaredMime: string): boolean {
  const actual = sniffMimeType(header);
  if (!actual) return false;

  const declared = declaredMime.toLowerCase().trim();
  // `image/jpg` is not a registered type but browsers and phone cameras send it.
  // Refusing it would reject real passport photos to no benefit.
  if (actual === 'image/jpeg') return declared === 'image/jpeg' || declared === 'image/jpg';
  return actual === declared;
}
