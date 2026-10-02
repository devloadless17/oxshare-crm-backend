import { button, layout, p, type RenderedEmail } from './layout';

/**
 * "We corrected details on your verified profile" — sent when a reviewer
 * corrects an APPROVED client's identity (`KycReviewService.correctIdentity`).
 *
 * A verified identity changed by somebody other than its owner must never be
 * silent: the client is the one person who can say "that is not my name". It
 * names WHICH details changed and not their values — the values are the
 * client's to read on their profile, behind their sign-in, not in a mailbox.
 *
 * Nothing to do when it was expected; a clear route when it was not.
 */
export function kycDetailsCorrected(
  firstName: string,
  details: readonly string[],
  portalUrl: string,
): RenderedEmail {
  return {
    subject: 'We corrected details on your verified profile — OxShare',
    html: layout(
      'Your verified details were corrected',
      [
        p(`Hello ${firstName || 'Valued Client'},`),
        p(
          'Our verification team corrected the following details on your verified profile: ' +
            `${details.join(', ')}. Your verification stays in place.`,
        ),
        p(
          'You can see your details on your profile. If a correction is not right, reply to this ' +
            'email or contact support.',
        ),
        button(`${portalUrl}/profile`, 'View your profile'),
      ].join('\n'),
    ),
  };
}
