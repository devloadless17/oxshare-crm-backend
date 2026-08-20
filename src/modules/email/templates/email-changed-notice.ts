import { fine, layout, p, type RenderedEmail } from './layout';

/**
 * "Your sign-in address was changed" — sent to the OLD address, always.
 *
 * ## This message is the security control, not a courtesy
 *
 * An administrator changing a client's email is the one operation on the admin
 * surface that can take an account over: point it at your own inbox, run a
 * password reset, and the balance follows. Permissions and the audit log both
 * guard it, but they guard it INWARDS — they tell the broker what happened,
 * after someone thinks to look.
 *
 * This tells the one person with an interest in noticing immediately, at the
 * one address the attacker no longer controls. It is deliberately sent even
 * though the change has already taken effect: the point is not to authorise the
 * change, it is to make a silent takeover impossible.
 *
 * ## It names the new address, and that is a considered choice
 *
 * The alternative — "your email was changed" with no detail — leaves the reader
 * unable to tell a legitimate support fix from an attack, so the safe reading
 * becomes "ignore it", which is the same as not sending it. Whoever holds the
 * old mailbox was, until a moment ago, the account owner; showing them where
 * their account went is information they are entitled to.
 *
 * No button and no link. Every action worth taking here starts with the client
 * contacting support through a channel they already trust — and a "this wasn't
 * me" link in a mail sent to an address that may itself be compromised is a
 * phishing lure wearing our brand.
 */
export function emailChangedNotice(newEmail: string, supportEmail: string): RenderedEmail {
  return {
    subject: 'The sign-in address on your OxShare account was changed',
    html: layout(
      'Your sign-in address was changed',
      [
        p(
          'An administrator changed the email address used to sign in to your OxShare account. ' +
            'It is now:',
        ),
        p(newEmail),
        p(
          'You will no longer be able to sign in with this address, and password reset links will ' +
            'go to the new one.',
        ),
        p(
          `If you asked for this, nothing further is needed. If you did NOT ask for this, contact ${supportEmail} immediately — ` +
            'your account may have been taken over.',
        ),
        fine(
          'This notice was sent to your previous address on purpose, so that a change you did not ' +
            'request cannot go unnoticed.',
        ),
      ].join('\n'),
    ),
  };
}
