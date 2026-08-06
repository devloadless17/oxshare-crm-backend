import { button, fine, layout, p, type RenderedEmail } from './layout';

/**
 * "You're invited to the back-office."
 *
 * The link in this mail is the most dangerous credential the system sends:
 * POST /admin/invite/accept turns it into a live admin account carrying the
 * inviter's granted permissions. It is never logged, in any environment. See
 * the note at the top of `email.service.ts`.
 */
export function adminInvite(name: string, inviteUrl: string): RenderedEmail {
  return {
    subject: 'Admin Invitation — OxShare',
    html: layout(
      "You're invited to OxShare Admin",
      [
        p(`Hello ${name},`),
        p(
          "You've been invited to join the OxShare back-office. Set your password to activate your account. The link expires in 48 hours.",
        ),
        button(inviteUrl, 'Activate Account'),
        fine("If you weren't expecting this invitation, please ignore this email."),
      ].join('\n'),
    ),
  };
}
