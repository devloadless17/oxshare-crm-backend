/**
 * "Is there anything in this file that WANTS to run?"
 *
 * `file-signature.ts` answers a different question — is this really the type it
 * claims to be — and that is the question that stops an HTML document arriving
 * as `passport.pdf`. It says nothing about a file that is genuinely a PDF and is
 * genuinely hostile.
 *
 * ## Why a PDF is the one accepted type that can be
 *
 * A JPEG, PNG and WebP are pixels: decoded by an image decoder, with no place
 * for a script to live. A PDF is a DOCUMENT FORMAT with an execution model. It
 * can carry JavaScript, open a file on the viewer's machine (`/Launch`), embed
 * another file wholesale (`/EmbeddedFile`), or play media (`/RichMedia`). Those
 * are legitimate features of the format and the reason PDF is a standing malware
 * carrier.
 *
 * ## Why the browser protections are not enough on their own
 *
 * `uploads.controller.ts` serves every KYC document `default-src 'none';
 * sandbox` with `nosniff` and `no-store`, which contains it completely IN THE
 * BROWSER. The exposure is the step after that: a reviewer opens client
 * documents all day, and the ordinary way to read a scan properly is to save it
 * and open it in a desktop reader. Nothing about our headers follows the file
 * there. The person best placed to be attacked through the KYC queue is the one
 * person who has to open everything in it.
 *
 * ## ⚠️ WHAT THIS IS AND IS NOT
 *
 * It is a scan for the literal markers, on the raw bytes. It is NOT a parser and
 * NOT a sanitiser, and it can be evaded: PDF 1.5 can put the document catalogue
 * inside a COMPRESSED OBJECT STREAM, where `/JavaScript` is deflated and this
 * function cannot see it. Names can also be written with hex escapes
 * (`/J#61vaScript`), which is handled below, but the compression case is not.
 *
 * So this stops the ordinary hostile PDF — the ones that are mass-produced, and
 * anything not crafted specifically against this check — and it does not claim
 * to stop a determined attacker. That is worth having at near-zero cost, and it
 * is worth saying plainly rather than letting the next reader assume the
 * problem is solved. `StoredFilesService` exposes a `ScanUploads` seam for a
 * real scanner when one is warranted; see the note there.
 *
 * ## The list is SHORT on purpose, and `/OpenAction` is deliberately absent
 *
 * A false rejection here is a client who cannot finish onboarding and does not
 * know why, holding a document that is completely fine. So every marker below
 * has to be one that has NO legitimate reason to appear in a scanned identity
 * document.
 *
 * `/OpenAction` does not meet that bar. It is how a PDF asks to open at a
 * particular zoom or page (`/OpenAction [0 /Fit]`), which real scanners and real
 * "Print to PDF" drivers emit. It is dangerous only when the action it names is
 * a script — and in that case `/JavaScript` or `/JS` is present anyway and is
 * caught on its own. Blocking the container rather than the payload would refuse
 * honest documents to catch nothing extra. `/AA` (additional actions) is absent
 * for the same reason.
 */

/** A marker, and the plain-language reason it has no place in an ID document. */
interface ActiveMarker {
  /** The PDF name, without its leading slash. */
  readonly name: string;
  readonly why: string;
}

const ACTIVE_PDF_MARKERS: readonly ActiveMarker[] = [
  { name: 'JavaScript', why: 'runs a script when the document is opened' },
  { name: 'JS', why: 'runs a script when the document is opened' },
  { name: 'Launch', why: 'asks the reader to run another program' },
  { name: 'EmbeddedFile', why: 'carries another file inside it' },
  { name: 'RichMedia', why: 'embeds Flash or video content' },
];

/**
 * Undo the `#xx` hex escapes a PDF name may contain.
 *
 * `/J#61vaScript` and `/JavaScript` are the SAME NAME to a PDF reader — §7.3.5
 * of the spec — so a scan that only looks for the plain spelling is defeated by
 * a two-character change. Applied to the whole buffer before matching, which is
 * cheap and means every marker below is written once, in its readable form.
 */
function decodeNameEscapes(text: string): string {
  return text.replace(/#([0-9a-fA-F]{2})/g, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

/**
 * The active-content markers present in a PDF, in the order listed above.
 *
 * Returns an empty array for a clean document and for anything that is not a
 * PDF — the caller decides which buckets care, and a JPEG has nothing to find.
 *
 * Decoded as `latin1`, not `utf8`: a PDF is binary, and `utf8` replaces every
 * invalid sequence with U+FFFD, which can eat the bytes of a marker sitting
 * beside compressed data. `latin1` is the one lossless byte-to-char mapping.
 */
export function findActivePdfFeatures(buffer: Buffer): readonly string[] {
  const text = decodeNameEscapes(buffer.toString('latin1'));
  const found: string[] = [];

  for (const marker of ACTIVE_PDF_MARKERS) {
    /*
     * `/Name` must be followed by a PDF delimiter or whitespace, so `/JS` does
     * not also match `/JSFoo` and `/Launch` does not match `/LaunchPad`. PDF
     * names end at whitespace or one of `()<>[]{}/%` (§7.2.2), and end-of-buffer
     * counts as an end too.
     */
    const pattern = new RegExp(`/${marker.name}(?=[\\s()<>\\[\\]{}/%]|$)`);
    if (pattern.test(text)) found.push(marker.name);
  }

  return found;
}

/**
 * What to tell the person holding the file.
 *
 * Names the fix, not the defect: whoever uploaded this is overwhelmingly likely
 * to be a client who exported from a banking app or a form-filler that added an
 * attachment, not an attacker — and "re-scan it or photograph it" is something
 * they can act on. It deliberately does not quote the marker; that detail
 * belongs in the alert, where a reviewer sees it.
 */
export const ACTIVE_CONTENT_REJECTION =
  'That PDF contains embedded scripts or attachments, so it cannot be accepted as an ' +
  'identity document. Please upload a plain scan or a photo of the document instead.';

/** The marker list, for the alert context and for tests. */
export function describeActiveFeatures(features: readonly string[]): string {
  const known = ACTIVE_PDF_MARKERS.filter((m) => features.includes(m.name));
  return known.map((m) => `/${m.name} (${m.why})`).join(', ');
}
