import { button, esc, fine, layout, p, panel, type RenderedEmail } from './layout';

/**
 * "Confirm your email" — sent on registration, on resend, and when an
 * unconfirmed owner signs in.
 *
 * ## The code first, the link second
 *
 * The client asked for sign-up to end on a screen asking for a code from this
 * email, and to be signed straight in by the right one (25 Sep 2026). So the
 * code leads, large and spaced for reading off a phone, and the link follows as
 * the fallback for opening the email on another device.
 *
 * The code is in the SUBJECT too, on purpose: phones and mail apps offer a code
 * from a subject line for one-tap entry, and a notification preview then shows
 * it without opening anything. It is single-use and dies in 15 minutes, which is
 * what makes that acceptable.
 *
 * `code` is absent only for an address an ADMIN changed — nobody is in front of
 * a code screen then, so that mail carries the link alone.
 *
 * The URL carries a bearer token. It is composed by the caller from
 * `PORTAL_URL` and never logged (R-6.3), which is why this template receives a
 * finished URL rather than the token itself: a template that built the link
 * would be a second place that knows the token, and one of them would log it.
 */
export function verifyEmail(verificationUrl: string, code?: string): RenderedEmail {
  if (!code) {
    return {
      subject: 'Verify Your Email — OxShare Portal',
      html: layout(
        'Welcome to OxShare Portal',
        [
          p('Please verify your email address to complete your registration.'),
          button(verificationUrl, 'Verify Email Address'),
          fine('If you did not request this email, please ignore it.'),
        ].join('\n'),
      ),
    };
  }

  return {
    subject: `${code} is your OxShare verification code`,
    html: layout(
      'Confirm your email',
      [
        // True whichever screen asked: sign-up, or a sign-in to an account
        // whose address was never confirmed — both mail this same code.
        p(
          'Thank you for registering with OxShare. Enter this code on the confirmation ' +
            'screen to confirm your email and sign in:',
        ),
        panel(
          `<div style="font-size: 32px; font-weight: 700; letter-spacing: 10px; text-align: center; font-family: 'Courier New', Courier, monospace;">${esc(code)}</div>`,
        ),
        fine(
          'The code expires in 15 minutes and works once. Never share it — OxShare ' +
            'will never ask you for it.',
        ),
        p('Opening this on another device? Confirm with a link instead:'),
        button(verificationUrl, 'Confirm with a link'),
        fine(
          'If you did not create an OxShare account, you can ignore this email — ' +
            'nothing happens unless the code or the link is used.',
        ),
      ].join('\n'),
    ),
  };
}
