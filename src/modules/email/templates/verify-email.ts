import { button, fine, layout, p, type RenderedEmail } from './layout';

/**
 * "Confirm your address" — sent on registration and on resend.
 *
 * The URL carries a bearer token. It is composed by the caller from
 * `PORTAL_URL` and never logged (R-6.3), which is why this template receives a
 * finished URL rather than the token itself: a template that built the link
 * would be a second place that knows the token, and one of them would log it.
 */
export function verifyEmail(verificationUrl: string): RenderedEmail {
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
