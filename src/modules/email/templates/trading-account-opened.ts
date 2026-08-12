import { button, card, esc, p, pRich, panel, type RenderedEmail } from './layout';

/**
 * The credentials for a trading account that has just been opened.
 *
 * ## This mail is the ONLY delivery
 *
 * MT5 returns the master and investor passwords once, at creation, and nothing
 * stores them. They are deliberately absent from the API response on both the
 * admin and the portal path, so if this mail does not arrive there is no second
 * copy anywhere — the account has to be given a new password by an operator.
 *
 * That is the point rather than a limitation. The account's owner is the only
 * person who should ever hold its trading password, and an API response is read
 * by whoever pressed the button — which on the admin path is a member of staff,
 * and on the portal path is a browser that may not be the client's.
 *
 * ## Two passwords, and the difference matters
 *
 * The MASTER password trades. The INVESTOR password is read-only: it shows
 * positions and history and cannot place an order. Clients hand the second one
 * to signal providers, account managers and analysts, and hand over the first
 * one by mistake when nobody explains the difference — so this explains it,
 * rather than listing two similar-looking strings and leaving them to guess.
 */
export function tradingAccountOpened(
  firstName: string,
  login: string,
  environment: 'live' | 'demo',
  currency: string,
  leverage: number,
  masterPassword: string,
  investorPassword: string,
  portalUrl: string,
  /** The label the client chose, when they chose one. */
  accountName?: string,
  /** What the account actually holds — a funded demo, or nothing. */
  balance?: string,
): RenderedEmail {
  const kind = environment === 'live' ? 'live' : 'demo';

  return {
    subject: `Your ${kind} trading account ${esc(login)} is ready — OxShare`,
    html: card(`        <h2 style="color: #047857; margin-top: 0;">
          Your ${esc(kind)} trading account is ready
        </h2>
${p(`Hello ${esc(firstName) || 'Valued Client'},`)}
${p(
  environment === 'live'
    ? 'Your live trading account has been opened. It holds real money once you fund it.'
    : 'Your demo trading account has been opened. It holds practice money, so you can trade it without risk.',
)}
${panel(
  // The client's own label first when they gave one: it is how they will refer
  // to this account, and a mail that opens with a number they have never seen
  // is harder to place than one that opens with the name they typed.
  (accountName ? `<strong>Name:</strong> ${esc(accountName)}<br>` : '') +
    `<strong>Login:</strong> ${esc(login)}<br>` +
    `<strong>Currency:</strong> ${esc(currency)}<br>` +
    `<strong>Leverage:</strong> 1:${esc(String(leverage))}` +
    // Only when there IS one. "Balance: 0.00" on a live account the client is
    // about to fund reads as a problem rather than a fact.
    (balance && Number.parseFloat(balance) > 0
      ? `<br><strong>Starting balance:</strong> ${esc(balance)} ${esc(currency)}`
      : ''),
)}
${pRich('<strong>Your passwords</strong>')}
${panel(
  `<strong>Master password:</strong> <code>${esc(masterPassword)}</code><br>` +
    '<span style="color:#6b7280;">Full access — places trades and manages the account.</span>' +
    '<br><br>' +
    `<strong>Investor password:</strong> <code>${esc(investorPassword)}</code><br>` +
    '<span style="color:#6b7280;">Read-only — shows positions and history but cannot trade. ' +
    'This is the one to share if somebody needs to watch your account.</span>',
)}
${pRich(
  'Please save these somewhere safe and delete this email. <strong>We do not keep a copy</strong> — ' +
    'if you lose them, an administrator has to set a new password for you.',
)}
${p('Never share your master password. Nobody at OxShare will ever ask you for it.')}
${button(portalUrl, 'Go to Portal')}`),
  };
}
