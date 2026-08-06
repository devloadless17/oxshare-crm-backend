import { button, fine, layout, p, type RenderedEmail } from './layout';

/**
 * "You already have an account" — the other half of a privacy decision.
 *
 * Registration answers identically whether or not an account exists, so it is
 * no longer a membership oracle. That would strand a person who forgot they had
 * signed up: a cheerful success message, no email, no way to discover why they
 * cannot sign in. The information still goes out — to the ONE mailbox entitled
 * to it. See `AuthService.register`.
 */
export function accountExists(loginUrl: string): RenderedEmail {
  return {
    subject: 'You already have an OxShare account',
    html: layout(
      'You already have an OxShare account',
      [
        p(
          'Someone just tried to create an account with this email address. You already have one, so we did not create a second.',
        ),
        p('If that was you, sign in instead — or reset your password if you have forgotten it.'),
        button(loginUrl, 'Sign in'),
        fine(
          'If it was not you, no action is needed — nothing about your account has changed and no new account was created.',
        ),
      ].join('\n'),
    ),
  };
}
