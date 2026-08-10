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
export { esc, layout, card, button, link, p, fine, panel, type RenderedEmail } from './layout';

export { verifyEmail } from './verify-email';
export { passwordReset } from './password-reset';
export { accountExists } from './account-exists';
export { kycDecision } from './kyc-decision';
export { partnerDecision } from './partner-decision';
export { walletCredit } from './wallet-credit';
export { depositOutcome } from './deposit-outcome';
export { withdrawalDecision } from './withdrawal-decision';
export { withdrawalOtp } from './withdrawal-otp';
export { adminInvite } from './admin-invite';
export { adminPasswordReset } from './admin-password-reset';
export { smtpTest } from './smtp-test';
