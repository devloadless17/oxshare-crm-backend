/**
 * The plain-text twin of an email's HTML, sent beside it in every message.
 *
 * HTML-only mail is a spam signal: legitimate senders send `multipart/
 * alternative` (an HTML part AND a text part), and filters score a message
 * without the text part as more likely bulk or phishing. It is also what a
 * text-only client, a watch or a screen reader in plain mode shows.
 *
 * Every template renders through the helpers in `layout.ts`, so this converts
 * THAT markup — a handful of tags, every value already escaped by `esc()` —
 * not arbitrary HTML, which is why it needs no parser dependency. What the text
 * part carries, in order:
 *
 *  - each block (heading, paragraph, panel, button) as its own paragraph;
 *  - a link as `label: url`, or the URL alone when the label is the URL;
 *  - a left-to-right run inside Arabic (an amount, a code, a password) wrapped
 *    in Unicode isolates — the plain-text `dir="ltr"`, so the bidi algorithm
 *    cannot reorder "$1,234.56" or a password's punctuation;
 *  - no logo, no document head, no styling.
 */
export function toPlainText(html: string): string {
  const text = html
    // Never content: the doctype, comments, and the document head.
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(head|style|script)\b[\s\S]*?<\/\1>/gi, '')
    // HTML whitespace: every run is one space, as a browser renders it.
    .replace(/\s+/g, ' ')
    .replace(/<(span|code)\b[^>]*\bdir="ltr"[^>]*>([\s\S]*?)<\/\1>/gi, `${LRI}$2${PDI}`)
    .replace(
      /<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
      (_match, href: string, label: string) => {
        const shown = stripTags(label).trim();
        return shown === '' || shown === href ? href : `${shown}: ${href}`;
      },
    )
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|h[1-6]|table|tr|td|th|ul|ol|li|html|body|blockquote|hr)\b[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '');

  return decodeEntities(text)
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** LEFT-TO-RIGHT ISOLATE and POP DIRECTIONAL ISOLATE (Unicode 6.3). */
const LRI = '⁦';
const PDI = '⁩';

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/**
 * One pass, so `&amp;lt;` becomes the text `&lt;` — what `esc()` was given —
 * and never `<`.
 */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, name: string) => {
    if (name.startsWith('#')) {
      const hex = name[1] === 'x' || name[1] === 'X';
      const code = parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED[name.toLowerCase()] ?? match;
  });
}
