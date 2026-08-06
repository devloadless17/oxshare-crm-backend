/**
 * The shell every email in this product shares, and the helpers templates need.
 *
 * ## Why the markup is inline styles and a table-free div
 *
 * Not a stylistic choice. Mail clients strip `<style>` blocks (Gmail does,
 * Outlook does), so a class-based stylesheet renders as unstyled text for a
 * large share of recipients. Inline `style=""` is the only thing that survives
 * everywhere, which is why this looks nothing like the rest of the codebase.
 *
 * It was copied verbatim into eight `send*` methods before this file existed —
 * same wrapper, same heading colour, same button — so a change to the brand
 * meant eight edits and a diff nobody could read. One copy now.
 *
 * ## Dark card, deliberately
 *
 * The card is dark (`#0f172a`) with light text, and that is the ONE piece of
 * styling here that ignores the recipient's preference: a mail client's dark
 * mode may invert an email's colours, and a card that is already dark inverts
 * to something legible rather than to black-on-black. The alternative — a white
 * card — is the one that breaks, and it breaks for exactly the people who set
 * dark mode deliberately.
 */

/** Brand colours, in one place rather than repeated per template. */
const CARD_BG = '#0f172a';
const TEXT = '#f8fafc';
const HEADING = '#3b82f6';
const BUTTON_BG = '#2563eb';
const MUTED = '#94a3b8';

/**
 * Escape a value before it goes into an email template.
 *
 * `firstName` comes from registration and `reason` from an admin, and both were
 * once interpolated raw. Mail clients block script, so this is not stored XSS —
 * but a crafted name can forge the visual content of a "your withdrawal has
 * been sent" message, and on a money system that is the part that matters.
 *
 * EXPORTED because every template needs it. A template that interpolates a
 * caller-supplied value without it is the bug this guards against, and
 * `email-never-logs-credentials.spec.ts` is the pin.
 */
export function esc(value: string | undefined | null): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** What every template returns: a subject line and a rendered HTML body. */
export interface RenderedEmail {
  subject: string;
  html: string;
}

/**
 * The masthead logo.
 *
 * An absolute https URL, not an attachment and not a data: URI. All three work;
 * this one is chosen because a `cid:` attachment makes every message heavier and
 * a data: URI is stripped outright by Outlook and Gmail. The cost is that a
 * client blocking remote images shows the ALT TEXT instead — which is why the
 * alt is the brand name rather than "logo", and why no email in this product
 * puts information in the image alone.
 *
 * `max-width` plus `height: auto` because the source is 1920px wide: without
 * them a mail client renders it at full width and blows the 600px card apart.
 * `display: block` kills the descender gap under the image in Gmail.
 */
const LOGO_URL = 'https://oxshare.com/wp-content/uploads/2026/03/main-logo1920.png';

function masthead(): string {
  return `        <div style="text-align: center; padding: 8px 0 24px;">
          <img src="${LOGO_URL}" alt="OxShare" width="180" style="max-width: 180px; height: auto; display: block; margin: 0 auto; border: 0;" />
        </div>`;
}

/**
 * The footer every message carries.
 *
 * Says who sent it and that it is automated. A transactional email with no
 * sender identity reads as phishing — which is the exact reflex this product
 * wants clients to have about mails that AREN'T from us.
 */
function footer(): string {
  return `        <div style="margin-top: 32px; padding-top: 16px; border-top: 1px solid rgba(148,163,184,0.2);">
          <p style="font-size: 11px; color: ${MUTED}; margin: 0;">
            This is an automated message from OxShare. Please do not reply to it.
          </p>
        </div>`;
}

/**
 * Wrap body content in the shared card — logo, heading, body, footer.
 *
 * EVERY message goes through here, which is the point: the logo, the card, the
 * colours and the footer are defined once, so "make the emails consistent" is
 * one edit rather than eight. A template that builds its own wrapper has opted
 * out of that, and `kyc-decision.ts` is the only one which does — it colours its
 * heading by outcome, and it calls `masthead()` and `footer()` itself so it
 * stays in the family.
 *
 * `heading` is escaped here so a template cannot forget; `bodyHtml` is NOT,
 * because it is markup the template composed on purpose. That asymmetry is the
 * contract: pass text to `heading`, pass already-escaped HTML to `bodyHtml`.
 */
export function layout(heading: string, bodyHtml: string): string {
  return card(`        <h2 style="color: ${HEADING}; margin-top: 0;">${esc(heading)}</h2>
${bodyHtml}`);
}

/**
 * The card itself, for a template that needs to compose its own heading.
 *
 * Exported so `kyc-decision.ts` can colour its heading green or red without
 * duplicating the wrapper, the logo or the footer — the three things that must
 * not drift between messages.
 */
export function card(innerHtml: string): string {
  return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; background: ${CARD_BG}; color: ${TEXT}; border-radius: 12px;">
${masthead()}
${innerHtml}
${footer()}
      </div>
    `;
}

/**
 * The call-to-action button.
 *
 * `href` is NOT escaped through `esc()` — it is a URL this application built,
 * never a caller-supplied string, and escaping it would break the query string
 * that carries the token. No template may pass user input here.
 */
export function button(href: string, label: string): string {
  return `
        <div style="margin: 30px 0;">
          <a href="${href}" style="background: ${BUTTON_BG}; color: #ffffff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; display: inline-block;">
            ${esc(label)}
          </a>
        </div>`;
}

/** A paragraph of ordinary body text. Escaped. */
export function p(text: string): string {
  return `        <p>${esc(text)}</p>`;
}

/** Small print — expiry notices, "ignore this if it wasn't you". Escaped. */
export function fine(text: string): string {
  return `        <p style="font-size: 12px; color: ${MUTED};">${esc(text)}</p>`;
}

/**
 * A boxed detail block — a reason, a code, an amount.
 *
 * Takes ALREADY-ESCAPED html, because callers compose several escaped values
 * into one block. Every current caller runs its values through `esc` first.
 */
export function panel(innerHtml: string): string {
  return `        <div style="background: rgba(148,163,184,0.12); border-radius: 8px; padding: 12px 16px; margin: 20px 0;">${innerHtml}</div>`;
}
