import { button, fine, layout, p, type RenderedEmail } from './layout';

/**
 * "Set a new password" — the client-facing reset.
 *
 * The expiry is stated in the body on purpose: a link that dies silently reads
 * as a broken product rather than a deliberate limit, and this one is short.
 */
export function passwordReset(resetUrl: string): RenderedEmail {
  return {
    subject: 'Reset Password Request — OxShare',
    html: layout(
      'Password Reset Request',
      [
        p('You requested to reset your password. Click the link below to set a new password.'),
        button(resetUrl, 'Reset Password'),
        fine('This token will expire in 1 hour.'),
      ].join('\n'),
    ),
  };
}
