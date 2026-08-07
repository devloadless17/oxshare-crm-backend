import { esc, fine, layout, p, type RenderedEmail } from './layout';

/**
 * The six digits that confirm one specific withdrawal.
 *
 * ## The amount is in the subject line, and that is the security control
 *
 * `WithdrawalOtpService` keys the code on an HMAC of the whole intent — user,
 * amount, currency, destination, provider — so a code issued for one withdrawal
 * cannot authorise another. That binding is invisible to the person reading
 * this email, and the attack it defends against is social: somebody with a live
 * session triggers a send for a small withdrawal to the victim's own account,
 * the victim reads a plausible message and relays the code.
 *
 * Naming the amount HERE, in the subject and again in the body, is what lets
 * the recipient notice that the number they are confirming is not the number
 * they expected. The cryptographic binding makes the relayed code useless; this
 * is what stops them relaying it in the first place.
 *
 * ## What it must not say
 *
 * Nothing about the destination. The address is already known to whoever
 * requested the withdrawal, and repeating it in an email adds a payout target
 * to a message that may sit in a compromised mailbox.
 */
export function withdrawalOtp(amount: string, currency: string, code: string): RenderedEmail {
  const money = `${esc(amount)} ${esc(currency)}`;

  return {
    // The amount, not just "a withdrawal": a recipient scanning an inbox should
    // be able to tell an unexpected request from an expected one without
    // opening it.
    subject: `Confirm your ${amount} ${currency} withdrawal — OxShare`,
    html: layout(
      'Confirm your withdrawal',
      `${p(`You asked to withdraw <strong style="color:#f8fafc;">${money}</strong>.`)}
${p('Enter this code to confirm it:')}
        <div style="margin: 24px 0; font-size: 32px; letter-spacing: 8px; font-weight: bold; color: #f8fafc;">
          ${esc(code)}
        </div>
${fine('This code expires in 5 minutes and can be used once.')}
        <p style="font-size: 12px; color: #fca5a5;">
          If you did not request this withdrawal, do not enter the code — change your password and
          contact support immediately.
        </p>`,
    ),
  };
}
