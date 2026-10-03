import { AuthenticationError } from '../../../common/errors/domain-errors';

/**
 * Why a Google sign-in did not produce a session — the fixed vocabulary the
 * callback redirects with (`?google_error=<code>`).
 *
 * A short code and nothing else on purpose: never Google's own text (it is
 * attacker-influenceable and unlocalised) and never the email address (a URL
 * lands in history, proxy logs and referrers). The console maps each code to
 * its own sentence.
 */
export const GOOGLE_ERROR_CODES = [
  'cancelled',
  'expired',
  'state',
  'exchange',
  'token',
  'unverified_email',
  'domain',
  'no_account',
  'suspended',
  'account_mismatch',
  'invite_invalid',
  'invite_email_mismatch',
  'disabled',
  /** Anything unexpected on our side (the database, a bug). Logged; never detailed. */
  'server',
] as const;

export type GoogleErrorCode = (typeof GOOGLE_ERROR_CODES)[number];

/**
 * A refused Google sign-in. Never reaches the exception filter: the callback
 * is a top-level browser navigation, so the controller turns every one of
 * these into a redirect back to the console carrying `reason`.
 */
export class GoogleSignInError extends AuthenticationError {
  override readonly code = 'GOOGLE_SIGN_IN_REFUSED';

  constructor(readonly reason: GoogleErrorCode) {
    super(`Google sign-in refused (${reason}).`);
  }
}
