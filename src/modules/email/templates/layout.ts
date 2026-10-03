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
 * ## No background, so the reader's theme wins
 *
 * The card sets NO background and NO text colour. It used to force a dark card
 * (`#0f172a`) with near-white text, on the theory that a dark card survives a
 * mail client's dark-mode inversion better than a light one. That reasoning
 * only ever considered dark mode: on the phone of somebody using a LIGHT theme
 * it planted a heavy dark slab in the middle of an otherwise white inbox, which
 * is nothing like the product the message came from.
 *
 * Inheriting works in both. The client paints its own background and its own
 * default text colour, so the mail looks native either way and there is no
 * combination where the card and the client disagree. Everything that DOES
 * carry a colour below holds its contrast against white and near-black alike.
 *
 * The one rule this imposes on templates: never set a background without also
 * setting a foreground, and never assume the surface behind you is light.
 */

/**
 * The product's own colours — the same tokens the portal and admin use, taken
 * from their `globals.css`.
 *
 * These were generic blues (#3b82f6 / #2563eb) that appear nowhere else in
 * OxShare, so a verification mail did not look like the site that sent it.
 *
 * ── Why two ambers ─────────────────────────────────────────────────────────
 *
 * `--ox-amber` (#ffa800) on white is about 1.9:1 — fine as a FILL, unreadable
 * as text. The frontends already solve this with a second token, and the same
 * split applies here: bright amber fills the button, deep amber (#b45309,
 * `--ox-amber-deep`) writes headings and links. Text on an amber fill is
 * near-black ink (`--ox-ink`), not white, for the same contrast reason.
 */
const HEADING = '#b45309'; // --ox-amber-deep: the accent, legible as text
const LINK = '#b45309'; // same token: a link is accent-coloured text
const BUTTON_BG = '#ffa800'; // --ox-amber: the accent as a fill
const BUTTON_TEXT = '#1a0f05'; // --ox-ink: what goes on an amber fill
const MUTED = '#6b7280'; // readable on white AND on dark
const BORDER = 'rgba(128,128,128,0.28)'; // neutral in both themes

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
 * The masthead logo — OUR file, opaque, and made for a light surface.
 *
 * It was the broker's marketing-site asset (`oxshare.com/wp-content/…`), and it
 * was wrong three ways at once (reported as "the logo looks corrupted"):
 *
 *  - it was the DARK-BACKGROUND variant: an orange mark and a WHITE wordmark,
 *    so on a white card "Share" vanished and the logo read as "Ox" and a gap;
 *  - it was TRANSPARENT, and a transparent PNG is what mail clients' dark-mode
 *    filters tint — one rendered it as a blue tile with a navy mark;
 *  - it lived on somebody else's WordPress site, where a media-library edit
 *    changes every email already in every inbox.
 *
 * Now: `public/email/oxshare-logo-v1.png` in the client portal — built from
 * `LOGOS/Logo High Res Oxshare-02.png` (the dark wordmark, the one the apps'
 * light header shows), on an OPAQUE white tile with no alpha at all, 400×177
 * so it is sharp at 2×. A dark-mode client shows it as a white badge, which
 * reads as intended; nothing in it can be tinted into another colour.
 *
 * Served from the PORTAL of whatever environment sent the mail (`PORTAL_URL`,
 * set once by `EmailService`; production refuses to boot on a non-https one),
 * so a development mail loads the development portal's copy and production's
 * loads production's. A hosted https image is what serious senders use: a
 * `cid:` attachment makes every message heavier and shows as an attachment in
 * some clients, and a data: URI is stripped outright by Outlook and Gmail.
 *
 * ⚠️ THE URL IS A CONTRACT WITH MAIL ALREADY DELIVERED. A message loads it for
 * as long as it sits in an inbox, so the file is VERSIONED and never edited or
 * deleted: a new logo is `oxshare-logo-v2.png` beside this one, and this
 * constant moves to it. That is what makes it safe for the portal to serve
 * `public/email/` with a year's `immutable` cache and an explicit
 * `Cross-Origin-Resource-Policy: cross-origin` (its `next.config.ts`); its
 * `src/test/email-assets.test.ts` pins the file and both headers. Deploy the
 * PORTAL first whenever this moves to a new file — a mail sent before the
 * file exists shows a broken image for as long as it is kept.
 *
 * A client blocking remote images (Outlook's default) shows the ALT TEXT, which
 * is why the alt is the brand name, styled as a wordmark, and why no email puts
 * information in the image alone. `display: block` kills the descender gap
 * under the image in Gmail.
 */
const LOGO_PATH = '/email/oxshare-logo-v1.png';
let logoUrl = new URL(LOGO_PATH, 'http://localhost:3000').toString();

/** Serve the masthead logo from this environment's portal. `EmailService` calls it once. */
export function setEmailLogoOrigin(portalUrl: string): void {
  logoUrl = new URL(LOGO_PATH, portalUrl).toString();
}

function masthead(): string {
  return `        <div style="text-align: center; padding: 8px 0 24px;">
          <img src="${logoUrl}" alt="OxShare" width="200" height="89" style="width: 200px; max-width: 200px; height: auto; display: block; margin: 0 auto; border: 0; border-radius: 10px; font-family: Arial, sans-serif; font-size: 26px; font-weight: bold; line-height: 32px; color: ${HEADING};" />
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
  return `        <div style="margin-top: 32px; padding-top: 16px; border-top: 1px solid ${BORDER};">
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
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; border-radius: 12px;">
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
          <a href="${href}" style="background: ${BUTTON_BG}; color: ${BUTTON_TEXT}; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; display: inline-block;">
            ${esc(label)}
          </a>
        </div>`;
}

/**
 * A paragraph of ordinary body text. **Escaped — do not pre-escape.**
 *
 * `p(esc(name))` escapes twice, and the second pass turns the first pass's own
 * output into literal text: a client called `O'Brien` was greeted as
 * `O&#39;Brien` in five money emails (wallet credit, deposit outcome,
 * withdrawal decision, and both trading-account mails) until 15 Sep 2026.
 *
 * It survived because it reads like the careful option. `esc()` at a call site
 * is the right instinct everywhere the value lands in raw markup — `pRich`,
 * `panel`, a hand-written `<strong>` — and those uses in the very same files
 * are correct. The distinction is the helper, not the value: `p()` and `fine()`
 * escape their argument, `pRich()` and `panel()` do not.
 */
export function p(text: string): string {
  return `        <p>${esc(text)}</p>`;
}

/**
 * A paragraph that may contain MARKUP — the caller escapes its own values.
 *
 * `p()` escapes everything it is given, which is the right default and was
 * quietly wrong for four templates: they passed `<strong>…</strong>` to it and
 * clients received emails with the tags spelled out in the text. Nothing
 * failed, nothing logged, and the mails had been going out that way for a
 * while.
 *
 * The escaping default stays. This is the opt-out, named so the difference is
 * visible at the call site, and it takes `innerHtml` for the same reason
 * `panel()` does: a parameter called that is a parameter people escape into.
 *
 * ⚠️ Every interpolated value must go through `esc()`. Nothing here does it
 * for you.
 */
export function pRich(innerHtml: string): string {
  return `        <p>${innerHtml}</p>`;
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
  // A neutral grey wash plus a border, rather than a light fill: it reads as a
  // panel on a white background and on a dark one, and it deliberately sets no
  // text colour so the client's own default stays readable inside it.
  return `        <div style="background: rgba(128,128,128,0.12); border: 1px solid ${BORDER}; border-radius: 8px; padding: 12px 16px; margin: 20px 0;">${innerHtml}</div>`;
}

/**
 * An inline text link, in the product's accent.
 *
 * Exported so a template never hand-writes an `<a>` and inherits the mail
 * client's default blue — which is what made the links in these messages look
 * like nothing else in OxShare. Deep amber, because a link is TEXT: the bright
 * accent is a fill colour and fails contrast at this size.
 *
 * `href` is not escaped, matching `button()`: it is a URL this application
 * built, and escaping it would break the query string carrying a token.
 */
export function link(href: string, label: string): string {
  return `<a href="${href}" style="color: ${LINK}; font-weight: 600; text-decoration: underline;">${esc(label)}</a>`;
}

/* ─────────────────────────────────────────────────────────────────────────
 * ARABIC (RTL) — the same card, mirrored (2 Oct 2026).
 *
 * A client reading the portal in Arabic gets their mail in Arabic. The English
 * helpers above are deliberately UNTOUCHED — every English message stays
 * byte-identical — and the Arabic ones below are separate functions rather than
 * a `locale` flag threaded through them.
 *
 * Mail clients ignore most CSS, so direction is stated three ways at once: a
 * full `<html lang="ar" dir="rtl">` document, a presentation table whose cell
 * carries `dir`/`align` (Outlook's Word engine reads those and little else), and
 * `dir="rtl"` + inline `direction: rtl; text-align: right` on every block.
 *
 * Anything that must read left to right inside Arabic text — an amount, a code,
 * a login, an email address, a password — goes through `ltr()`, so the bidi
 * algorithm cannot reorder "$1,234.56" or move a trailing punctuation mark into
 * the middle of a code. Tahoma and Arial carry Arabic glyphs on every desktop.
 * ───────────────────────────────────────────────────────────────────────── */

const AR_FONT = "'Segoe UI', Tahoma, Arial, sans-serif";
const RTL = 'direction: rtl; text-align: right;';

/** A left-to-right run inside Arabic text. ESCAPED — pass plain text. */
export function ltr(text: string): string {
  return `<span dir="ltr" style="unicode-bidi: isolate;">${esc(text)}</span>`;
}

/** `ltr()` for a value that is ALREADY escaped (e.g. a formatted amount). */
export function ltrHtml(innerHtml: string): string {
  return `<span dir="ltr" style="unicode-bidi: isolate;">${innerHtml}</span>`;
}

function footerAr(): string {
  return `        <div dir="rtl" style="margin-top: 32px; padding-top: 16px; border-top: 1px solid ${BORDER}; ${RTL}">
          <p dir="rtl" style="font-size: 11px; color: ${MUTED}; margin: 0; ${RTL}">
            هذه رسالة آلية من OXShare، يُرجى عدم الرد عليها.
          </p>
        </div>`;
}

/** An Arabic heading, in the accent or in an outcome colour. Escaped. */
export function headingAr(text: string, color: string = HEADING): string {
  return `        <h2 dir="rtl" style="color: ${color}; margin-top: 0; ${RTL}">${esc(text)}</h2>`;
}

/**
 * The Arabic card: a whole RTL document, so `lang`/`dir` sit on `<html>` where
 * screen readers and mail clients look for them.
 */
export function cardAr(innerHtml: string): string {
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body dir="rtl" style="margin: 0; padding: 0; ${RTL}">
  <table role="presentation" dir="rtl" width="100%" cellpadding="0" cellspacing="0" border="0" style="direction: rtl;">
    <tr>
      <td dir="rtl" align="right" style="${RTL} font-family: ${AR_FONT};">
      <div dir="rtl" lang="ar" style="font-family: ${AR_FONT}; max-width: 600px; margin: 0 auto; padding: 24px; border-radius: 12px; ${RTL}">
${masthead()}
${innerHtml}
${footerAr()}
      </div>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/** `layout()` in Arabic: accent heading (escaped) plus composed body html. */
export function layoutAr(heading: string, bodyHtml: string): string {
  return cardAr(`${headingAr(heading)}
${bodyHtml}`);
}

/** An Arabic paragraph. Escaped — do not pre-escape (see `p`). */
export function pAr(text: string): string {
  return `        <p dir="rtl" style="${RTL}">${esc(text)}</p>`;
}

/** An Arabic paragraph that may contain markup — the caller escapes its values. */
export function pRichAr(innerHtml: string): string {
  return `        <p dir="rtl" style="${RTL}">${innerHtml}</p>`;
}

/** Arabic small print. Escaped. */
export function fineAr(text: string): string {
  return `        <p dir="rtl" style="font-size: 12px; color: ${MUTED}; ${RTL}">${esc(text)}</p>`;
}

/** The boxed detail block, right-aligned. Takes ALREADY-ESCAPED html. */
export function panelAr(innerHtml: string): string {
  return `        <div dir="rtl" style="background: rgba(128,128,128,0.12); border: 1px solid ${BORDER}; border-radius: 8px; padding: 12px 16px; margin: 20px 0; ${RTL}">${innerHtml}</div>`;
}

/** The call-to-action button, right-aligned. `href` is built by us — see `button`. */
export function buttonAr(href: string, label: string): string {
  return `
        <div dir="rtl" style="margin: 30px 0; ${RTL}">
          <a href="${href}" dir="rtl" style="background: ${BUTTON_BG}; color: ${BUTTON_TEXT}; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; display: inline-block; font-family: ${AR_FONT};">
            ${esc(label)}
          </a>
        </div>`;
}

/** "Hello {name}," in Arabic, with the same fallback the English uses. */
export function greetingAr(firstName: string): string {
  return pAr(`مرحباً ${firstName || 'عميلنا العزيز'}،`);
}
