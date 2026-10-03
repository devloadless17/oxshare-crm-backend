import { DOCUMENT_CATALOGUE } from '../kyc/document-catalogue';
import { IDENTITY_FIELDS, SELFIE_FIELD } from '../kyc/identity-core';
import { requestContext } from '../logging/request-context';
import type { Locale } from './locale';
import { SERVER_MESSAGES_AR } from './server-messages.ar';

/**
 * A server sentence in the request's language (2 Oct 2026).
 *
 * The English stays the canonical text everywhere it is written; this is the
 * one place it is turned into Arabic, on the way OUT — `AllExceptionsFilter`
 * for every error, and the few client-facing response sentences the portal
 * prints verbatim. Unknown text comes back unchanged: an untranslated sentence
 * in English beats an empty box.
 *
 * The catalogue (`server-messages.ar.ts`) is keyed by the exact English. A key
 * holding `{1}`, `{2}`… is a PATTERN for a sentence built from a template
 * literal: each number captures what the English interpolated, and the Arabic
 * places the captures wherever it reads naturally. A captured value is itself
 * looked up, so a field label or a nested sentence inside a sentence is
 * translated too.
 */

interface Pattern {
  regex: RegExp;
  arabic: string;
  /** Literal characters — the more a pattern spells out, the more specific it is. */
  weight: number;
}

const PLACEHOLDER = /\{(\d+)\}/g;

let exact: Map<string, string> | undefined;
let patterns: Pattern[] | undefined;

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Labels whose Arabic lives beside the English in the platform's own KYC
 * definitions — the identity fields and the document catalogue. Read here so a
 * sentence like "Date of Birth is required." translates its label from the one
 * place that label is defined, rather than from a second copy in the catalogue.
 * Read defensively: an entry without Arabic simply contributes nothing.
 */
function labelTwins(): Map<string, string> {
  const twins = new Map<string, string>();
  const add = (en: unknown, ar: unknown): void => {
    if (typeof en === 'string' && typeof ar === 'string' && ar.trim() !== '') twins.set(en, ar);
  };
  for (const field of [...IDENTITY_FIELDS, SELFIE_FIELD]) {
    add(field.label, (field as { labelAr?: unknown }).labelAr);
  }
  for (const doc of DOCUMENT_CATALOGUE) {
    const docAr = (doc as { labelAr?: unknown }).labelAr;
    add(doc.label, docAr);
    for (const part of doc.parts) {
      const partAr = (part as { labelAr?: unknown }).labelAr;
      add(part.label, partAr);
      // The two ways a page is named in a sentence (`kyc-document-rules.ts`).
      if (typeof docAr === 'string' && typeof partAr === 'string') {
        add(`${doc.label}: ${part.label}`, `${docAr}: ${partAr}`);
        add(`${doc.label} (${part.label})`, `${docAr} (${partAr})`);
      }
    }
  }
  return twins;
}

function compile(): void {
  exact = labelTwins();
  patterns = [];
  for (const [english, arabic] of Object.entries(SERVER_MESSAGES_AR)) {
    if (!/\{\d+\}/.test(english)) {
      exact.set(english, arabic);
      continue;
    }
    const order: number[] = [];
    let source = '';
    let last = 0;
    for (const match of english.matchAll(PLACEHOLDER)) {
      source += escapeRegex(english.slice(last, match.index)) + '([\\s\\S]*?)';
      order.push(Number(match[1]));
      last = match.index + match[0].length;
    }
    source += escapeRegex(english.slice(last));
    // Named by the number the English gave it, so the Arabic may reorder freely.
    let index = 0;
    const named = source.replace(/\(\[\\s\\S\]\*\?\)/g, () => `(?<p${order[index++]}>[\\s\\S]*?)`);
    patterns.push({
      regex: new RegExp(`^${named}$`),
      arabic,
      weight: english.replace(PLACEHOLDER, '').length,
    });
  }
  patterns.sort((a, b) => b.weight - a.weight);
}

/**
 * Operator-authored labels for the request in flight (3 Oct 2026): a broker's KYC
 * question, a payment method's proof field — text the catalogue cannot know.
 * Whoever READS such a label registers its Arabic here, and a sentence that names
 * it ("Favourite colour is required.") then names it in Arabic when the request
 * is Arabic. The English sentence is unchanged; this only feeds the lookup.
 * A no-op outside a request, and for a label without Arabic.
 */
export function registerLabelTwins(
  pairs: Iterable<readonly [string | null | undefined, string | null | undefined]>,
): void {
  const store = requestContext.getStore();
  if (!store) return;
  for (const [en, ar] of pairs) {
    if (typeof en !== 'string' || en === '' || typeof ar !== 'string' || ar.trim() === '') {
      continue;
    }
    (store.labelTwins ??= new Map()).set(en, ar.trim());
  }
}

/** A label's Arabic: the request's own registered twin first, then the catalogue's. */
function lookup(value: string, table: Map<string, string>): string | undefined {
  return requestContext.getStore()?.labelTwins?.get(value) ?? table.get(value);
}

/** A captured value in Arabic: exactly, else piece by piece for a list of labels. */
function localizeCapture(value: string, table: Map<string, string>): string {
  const whole = lookup(value, table);
  if (whole !== undefined) return whole;
  if (value.includes(', ')) {
    const pieces = value.split(', ');
    const translated = pieces.map((piece) => lookup(piece, table) ?? piece);
    if (translated.some((piece, i) => piece !== pieces[i])) return translated.join('، ');
  }
  return value;
}

export function localizeMessage(text: string, locale: Locale): string {
  if (locale !== 'ar' || typeof text !== 'string' || text === '') return text;
  if (!exact || !patterns) compile();
  const table = exact!;

  const direct = table.get(text);
  if (direct !== undefined) return direct;

  for (const pattern of patterns!) {
    const match = pattern.regex.exec(text);
    if (!match) continue;
    const groups = match.groups ?? {};
    return pattern.arabic.replace(PLACEHOLDER, (_, n: string) => {
      const captured = groups[`p${n}`];
      return captured === undefined ? '' : localizeCapture(captured, table);
    });
  }
  return text;
}

/** `localizeMessage` over a field map — each sentence, keys untouched. */
export function localizeFields(
  fields: Readonly<Record<string, string>>,
  locale: Locale,
): Record<string, string> {
  if (locale !== 'ar') return { ...fields };
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      typeof value === 'string' ? localizeMessage(value, locale) : value,
    ]),
  );
}
