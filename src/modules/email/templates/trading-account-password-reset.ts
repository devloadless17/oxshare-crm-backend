import { button, card, esc, p, pRich, panel, type RenderedEmail } from './layout';

/**
 * NEW credentials for a trading account whose owner asked for a reset.
 *
 * ## Same delivery contract as `trading-account-opened`
 *
 * MT5 hands the new passwords back once. Nothing stores them, and they are
 * deliberately absent from the API response on every path — so this mail is the
 * only copy that ever exists. The reasoning is unchanged: an API response is
 * read by whoever pressed the button, and the account's owner is the only person
 * who should hold its trading password.
 *
 * ## Both passwords, every time
 *
 * The reset rotates the master AND the investor password together, because a
 * client who has lost the one they trade with cannot tell us which of the two
 * leaked. That means an investor password already shared with a signal provider
 * or an analyst STOPS WORKING at this moment, and somebody who is not told that
 * reads it as the platform breaking. So the mail says it plainly rather than
 * listing two strings and leaving them to discover it.
 *
 * ## Why it names the account rather than just the login
 *
 * A client with three accounts who asked to reset one needs to know which of
 * them just changed — and if they did NOT ask for this, the login is what tells
 * them whose credentials to worry about.
 */
export function tradingAccountPasswordReset(
  firstName: string,
  login: string,
  environment: 'live' | 'demo',
  masterPassword: string,
  investorPassword: string,
  portalUrl: string,
  /** The support address, so "this was not me" has somewhere to go. */
  supportEmail?: string,
): RenderedEmail {
  const kind = environment === 'live' ? 'live' : 'demo';

  return {
    subject: `New passwords for trading account ${esc(login)} — OxShare`,
    html: card(`        <h2 style="color: #047857; margin-top: 0;">
          Your trading account passwords have been reset
        </h2>
${p(`Hello ${esc(firstName) || 'Valued Client'},`)}
${p(
  `The passwords for your ${esc(kind)} trading account have been reset at your request. ` +
    'Your previous passwords no longer work.',
)}
${panel(`<strong>Login:</strong> ${esc(login)}<br><strong>Type:</strong> ${esc(kind)}`)}
${pRich('<strong>Your new passwords</strong>')}
${panel(
  `<strong>Master password:</strong> <code>${esc(masterPassword)}</code><br>` +
    '<span style="color:#6b7280;">Full access — places trades and manages the account.</span>' +
    '<br><br>' +
    `<strong>Investor password:</strong> <code>${esc(investorPassword)}</code><br>` +
    '<span style="color:#6b7280;">Read-only — shows positions and history but cannot trade. ' +
    'This is the one to share if somebody needs to watch your account.</span>',
)}
${pRich(
  '<strong>Both</strong> passwords changed, not just the one you lost. If you had shared your ' +
    'investor password with anyone — a signal provider or an analyst — it has stopped working ' +
    'and they will need the new one.',
)}
${p(
  'Any terminal still signed in with the old password will be disconnected the next time it ' +
    'reconnects. Your open positions and your balance are untouched.',
)}
${pRich(
  'Please save these somewhere safe and delete this email. <strong>We do not keep a copy</strong> — ' +
    'if you lose them, you can reset them again from the portal.',
)}
${pRich(
  '<strong>If you did not ask for this</strong>, your portal account may be compromised. ' +
    'Change your portal password immediately' +
    (supportEmail ? ` and contact us at ${esc(supportEmail)}.` : ' and contact support.'),
)}
${button(portalUrl, 'Go to Portal')}`),
  };
}
