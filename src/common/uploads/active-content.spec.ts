import { describe, expect, it } from 'vitest';
import { findActivePdfFeatures } from './active-content';

/**
 * The PDF content scan.
 *
 * Two halves, and the SECOND is the one that decides whether this check can ship:
 * catching a hostile document is easy, and refusing a legitimate one is how a
 * security control gets removed a week later because onboarding broke. Every
 * "legitimate" case below is a construct real scanners and real PDF printers
 * emit.
 *
 * Deliberately NOT asserted: that this catches everything. It cannot — a PDF can
 * hide its catalogue in a compressed object stream, and `active-content.ts` says
 * so. A test claiming completeness would be the lie that file is careful not to
 * tell.
 */

const pdf = (body: string): Buffer => Buffer.from(`%PDF-1.4\n${body}\n%%EOF\n`, 'latin1');

describe('a PDF carrying active content is recognised', () => {
  it('finds JavaScript, under both the long and the short name', () => {
    const found = findActivePdfFeatures(pdf('1 0 obj<</S/JavaScript/JS(app.alert\\(1\\))>>endobj'));
    expect(found).toContain('JavaScript');
    expect(found).toContain('JS');
  });

  it('finds a /Launch action — the one that asks to run a program', () => {
    expect(findActivePdfFeatures(pdf('1 0 obj<</S/Launch/F(cmd.exe)>>endobj'))).toEqual(['Launch']);
  });

  it('finds an embedded file — a document carrying another document', () => {
    expect(findActivePdfFeatures(pdf('1 0 obj<</Type/EmbeddedFile>>endobj'))).toEqual([
      'EmbeddedFile',
    ]);
  });

  it('finds /RichMedia', () => {
    expect(findActivePdfFeatures(pdf('1 0 obj<</Subtype/RichMedia>>endobj'))).toEqual([
      'RichMedia',
    ]);
  });

  /**
   * §7.3.5: `/J#61vaScript` and `/JavaScript` are the same name to a reader.
   *
   * This is the whole reason the scan decodes before matching. A check that only
   * knew the plain spelling would be defeated by a two-character edit, which is
   * not a sophisticated attack — it is the first thing anyone tries.
   */
  it('sees through hex-escaped names', () => {
    expect(findActivePdfFeatures(pdf('1 0 obj<</S/J#61vaScript>>endobj'))).toEqual(['JavaScript']);
  });

  it('still catches a script hidden behind an /OpenAction', () => {
    expect(findActivePdfFeatures(pdf('1 0 obj<</OpenAction<</S/JavaScript>>>>endobj'))).toEqual([
      'JavaScript',
    ]);
  });
});

describe('a legitimate document is NOT refused', () => {
  it('passes a plain scan', () => {
    expect(findActivePdfFeatures(pdf('1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj'))).toEqual([]);
  });

  /**
   * The case that decided the marker list.
   *
   * `/OpenAction [0 /Fit]` asks the reader to open at a particular zoom, and real
   * scanners and "Print to PDF" drivers emit it. Blocking the container rather
   * than the payload would refuse honest documents and catch nothing the
   * JavaScript markers do not already catch — see the test above.
   */
  it('passes /OpenAction used for the initial view, which real scanners emit', () => {
    expect(findActivePdfFeatures(pdf('1 0 obj<</Type/Catalog/OpenAction[0 /Fit]>>endobj'))).toEqual(
      [],
    );
  });

  it('passes /AA with no action behind it', () => {
    expect(findActivePdfFeatures(pdf('1 0 obj<</Type/Page/AA<<>>>>endobj'))).toEqual([]);
  });

  /**
   * A PDF name ends at whitespace or a delimiter, so a marker has to match the
   * WHOLE name. Without that, `/JS` matches `/JSName` and every document using a
   * font or key whose name merely starts with one of these is refused.
   */
  it('does not mistake a longer name that merely starts the same', () => {
    expect(findActivePdfFeatures(pdf('1 0 obj<</Name/JSFoo/Other/LaunchPad>>endobj'))).toEqual([]);
  });

  it('finds nothing in bytes that are not a PDF at all', () => {
    expect(findActivePdfFeatures(Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01]))).toEqual([]);
  });

  it('survives an empty buffer', () => {
    expect(findActivePdfFeatures(Buffer.alloc(0))).toEqual([]);
  });
});
