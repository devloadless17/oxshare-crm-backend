import { button, esc, fine, layout, p, type RenderedEmail } from './layout';

/**
 * "A colleague reset your password" — D-44.
 *
 * Names WHO did it, deliberately, and does so twice. This is the only signal
 * the recipient gets that somebody with high privilege acted on their account,
 * and an admin who did NOT ask for it needs to be able to tell instantly — an
 * unrequested reset is either a mistake or somebody working towards their
 * session. A generic "your password was reset" hides the one fact worth
 * raising.
 *
 * The expiry is stated because a link that dies silently reads as a broken
 * product rather than a deliberate limit.
 */
export function adminPasswordReset(
  name: string,
  resetUrl: string,
  initiatedBy: string,
  expiresInMinutes: number,
): RenderedEmail {
  return {
    subject: 'Set a new admin password — OxShare',
    html: layout(
      'Set a new OxShare Admin password',
      [
        p(`Hello ${name},`),
        // `initiatedBy` is bolded, so it is composed rather than passed to p().
        `        <p><strong>${esc(initiatedBy)}</strong> started a password reset for your back-office account. Choose a new password using the link below. It expires in ${expiresInMinutes} minutes and can only be used once.</p>`,
        button(resetUrl, 'Set a new password'),
        fine(
          `Setting a new password signs you out everywhere else. If you did NOT ask for this, contact ${initiatedBy} immediately — someone with administrator access started it.`,
        ),
      ].join('\n'),
    ),
  };
}
