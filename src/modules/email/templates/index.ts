/**
 * Every message this product sends, in one folder.
 *
 * The bodies used to be eight HTML template literals inlined across a 499-line
 * `email.service.ts`, each repeating the same card markup. Finding "what do we
 * actually say to a client when their KYC is rejected" meant reading a delivery
 * class; changing the brand meant eight edits.
 *
 * Now: `email.service.ts` owns DELIVERY — the transporter, the SMTP config, the
 * NODE_ENV guard, the swallow-and-log contract — and knows nothing about copy.
 * These files own COPY and know nothing about sending. Each exports a function
 * returning `{ subject, html }`.
 *
 * ## Adding one
 *
 * Write `templates/<name>.ts`, export it here, add a thin `send*` method to the
 * service. Three rules, each load-bearing:
 *
 *   1. Escape every interpolated value with `esc` from `./layout` — or use the
 *      `p`/`fine` helpers, which escape for you. A crafted first name can
 *      otherwise forge the visual content of a decision email.
 *   2. Take a FINISHED url, never a token. A template that builds a link is a
 *      second place that knows the credential, and one of the two will log it
 *      (R-6.3).
 *   3. Say what the recipient should do next. A decision email with no reason
 *      and no action is one the reader cannot act on.
 */
export {
  esc,
  layout,
  card,
  button,
  link,
  p,
  pRich,
  fine,
  panel,
  ltr,
  ltrHtml,
  setEmailLogoOrigin,
  type RenderedEmail,
} from './layout';

export { verifyEmail } from './verify-email';
export { passwordReset } from './password-reset';
export { clientWelcome, WELCOME_LINK_DAYS } from './client-welcome';
export { emailChangedNotice } from './email-changed-notice';
export { kycDecision } from './kyc-decision';
export { kycDetailsCorrected } from './kyc-details-corrected';
export { kycReverification } from './kyc-reverification';
export { partnerDecision } from './partner-decision';
export { walletCredit, commissionSummaryReason } from './wallet-credit';
export { tradingAccountOpened } from './trading-account-opened';
export { tradingAccountPasswordReset } from './trading-account-password-reset';
export { depositOutcome } from './deposit-outcome';
export { withdrawalDecision } from './withdrawal-decision';
export { adminInvite } from './admin-invite';
export { adminPasswordReset } from './admin-password-reset';
export { smtpTest } from './smtp-test';
