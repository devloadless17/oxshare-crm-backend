import { describe, expect, it } from 'vitest';
import 'reflect-metadata';
import { AuthController } from '../src/modules/identity/auth.controller';
import { AdminAuthController } from '../src/modules/admin/admin-auth.controller';

/**
 * Rate limiting on the routes that handle credentials — R-3.5.
 *
 * The rule was recorded as satisfied on the strength of "`@Throttle` appears on
 * nine routes", which counts decorators rather than checking WHICH routes carry
 * one. Both refresh endpoints were missing from that nine.
 *
 * They are the worst two to miss. Each is deliberately exempt from the CSRF
 * guard (@NoCsrf — a refresh has to keep working once the anti-forgery token
 * has expired alongside the access token), each hashes on every call to find
 * the token's family row, and neither had any limit but the global 120/min. The
 * most expensive route in the API with the least in front of it.
 *
 * So this asserts the property directly: every credential-handling route names
 * a limit. Counting decorators is what let the gap through, and a test that
 * counts them would let the next one through too.
 */

const TTL = (name = 'default') => `THROTTLER:TTL${name}`;
const LIMIT = (name = 'default') => `THROTTLER:LIMIT${name}`;

function throttleOf(controller: object, method: string): { ttl: number; limit: number } | null {
  const proto = controller as Record<string, unknown>;
  const handler = proto[method];
  if (typeof handler !== 'function') {
    throw new Error(`${method} is not a handler — the route was renamed or removed.`);
  }
  const ttl = Reflect.getMetadata(TTL(), handler) as number | undefined;
  const limit = Reflect.getMetadata(LIMIT(), handler) as number | undefined;
  return ttl === undefined || limit === undefined ? null : { ttl, limit };
}

/**
 * Every handler that accepts, rotates or resets a credential.
 *
 * Adding a route here is deliberate: if a new one appears on either controller
 * and is not listed, the completeness test below fails and the author has to
 * decide, rather than inherit the global limit by omission.
 */
const CREDENTIAL_ROUTES: { controller: object; name: string; method: string }[] = [
  { controller: AuthController.prototype, name: 'POST /auth/login', method: 'login' },
  { controller: AuthController.prototype, name: 'POST /auth/refresh', method: 'refresh' },
  { controller: AuthController.prototype, name: 'POST /auth/register', method: 'register' },
  {
    controller: AdminAuthController.prototype,
    name: 'POST /admin/auth/login',
    method: 'login',
  },
  {
    controller: AdminAuthController.prototype,
    name: 'POST /admin/auth/refresh',
    method: 'refresh',
  },
  /*
   * The seven the list had always omitted, plus the invite.
   *
   * Every one of these accepts, rotates or resets a credential, and all but the
   * invite were ALREADY throttled — so the list was not even a record of what
   * had been considered, which is what made "if a new one appears it is not
   * listed" impossible to act on. The completeness census at the end of this
   * file is what now forces the question.
   */
  {
    controller: AuthController.prototype,
    name: 'POST /auth/change-password',
    method: 'changePassword',
  },
  {
    controller: AuthController.prototype,
    name: 'POST /auth/forgot-password',
    method: 'forgotPassword',
  },
  {
    controller: AuthController.prototype,
    name: 'POST /auth/reset-password',
    method: 'resetPassword',
  },
  {
    controller: AuthController.prototype,
    name: 'POST /auth/resend-verification',
    method: 'resendVerification',
  },
  {
    controller: AdminAuthController.prototype,
    name: 'POST /admin/invite/accept',
    method: 'acceptInvite',
  },
  {
    controller: AdminAuthController.prototype,
    name: 'POST /admin/auth/change-password',
    method: 'changePassword',
  },
  {
    controller: AdminAuthController.prototype,
    name: 'POST /admin/password-reset/complete',
    method: 'completePasswordReset',
  },
  {
    controller: AdminAuthController.prototype,
    name: 'POST /admin/users/:id/password-reset',
    method: 'initiatePasswordReset',
  },
  /*
   * The one that was genuinely unthrottled: it emails a 48-hour token that
   * creates an administrator account. See the note on the route.
   */
  { controller: AdminAuthController.prototype, name: 'POST /admin/invite', method: 'invite' },
  /*
   * Both CONSUME a token, which is what makes them credential routes even
   * though neither sets a password.
   *
   * `verifyEmail` spends the single-use verification token. `validateInvite` is
   * UNAUTHENTICATED and answers with the invitee's name and address for a valid
   * token — so an unlimited one is an offline oracle for guessing invite tokens
   * that returns PII on a hit.
   */
  { controller: AuthController.prototype, name: 'POST /auth/verify-email', method: 'verifyEmail' },
  /*
   * Spends a 6-digit emailed code AND starts a session (0138). The per-code
   * budget (five attempts) is the real bound; the route limit stops one IP
   * spraying guesses across many addresses.
   */
  {
    controller: AuthController.prototype,
    name: 'POST /auth/verify-email-code',
    method: 'verifyEmailCode',
  },
  {
    controller: AdminAuthController.prototype,
    name: 'GET /admin/invite/validate',
    method: 'validateInvite',
  },
];

describe('R-3.5 credential routes declare a rate limit', () => {
  it.each(CREDENTIAL_ROUTES)('$name is throttled', ({ controller, method }) => {
    const throttle = throttleOf(controller, method);
    expect(throttle).not.toBeNull();
    expect(throttle!.limit).toBeGreaterThan(0);
    expect(throttle!.ttl).toBeGreaterThan(0);
  });

  it('throttles BOTH refresh routes — the two that were missed', () => {
    // Named separately because these are the regression. They are CSRF-exempt
    // and hash on every call, so the global limit was the only thing in front
    // of them.
    const portal = throttleOf(AuthController.prototype, 'refresh');
    const admin = throttleOf(AdminAuthController.prototype, 'refresh');

    expect(portal).not.toBeNull();
    expect(admin).not.toBeNull();
    // Well below the global 120/min, and far above any real client: the portal
    // refreshes proactively every ten minutes.
    expect(portal!.limit).toBeLessThan(120);
    expect(admin!.limit).toBeLessThan(120);
  });

  it('leaves a refresh generous enough for a user with several tabs open', () => {
    // A limit tight enough to bounce a legitimate returning user would be
    // removed the first time it did, so the ceiling has to be worth keeping.
    expect(throttleOf(AuthController.prototype, 'refresh')!.limit).toBeGreaterThanOrEqual(10);
    expect(throttleOf(AdminAuthController.prototype, 'refresh')!.limit).toBeGreaterThanOrEqual(10);
  });
});

describe('the completeness test this file has always claimed to have', () => {
  /*
   * ⚠️ THE HEADER ABOVE PROMISED THIS AND IT DID NOT EXIST.
   *
   * "Adding a route here is deliberate: if a new one appears on either
   * controller and is not listed, the completeness test below fails and the
   * author has to decide, rather than inherit the global limit by omission."
   *
   * There was no such test. `CREDENTIAL_ROUTES` was five hand-written entries,
   * and a new handler on either controller inherited the global 120/min in
   * silence — the exact failure the sentence describes, left open by the
   * sentence that describes it. Seven routes that ARE credential-handling and
   * ARE throttled were also missing from it, so the list was not even a record
   * of what had been considered.
   *
   * It enumerates the controllers' own route handlers rather than a list, so a
   * new one arrives here by existing.
   */
  const PATH_METADATA = 'path';

  function handlersOf(prototype: object): string[] {
    return Object.getOwnPropertyNames(prototype).filter((name) => {
      if (name === 'constructor') return false;
      const handler = (prototype as Record<string, unknown>)[name];
      if (typeof handler !== 'function') return false;
      return Reflect.getMetadata(PATH_METADATA, handler) !== undefined;
    });
  }

  /**
   * Handlers on these two controllers that do NOT accept, rotate or reset a
   * credential — so the global limit is the right answer for them.
   *
   * Each says why, because "not a credential route" is a judgement and the next
   * person deserves the one that was made rather than a silence.
   */
  const NOT_A_CREDENTIAL: Record<string, string> = {
    // Reads of the caller's own identity or session list. They present nothing
    // and grant nothing.
    'AuthController.me': 'reads the caller’s own identity',
    'AuthController.sessions': 'reads the caller’s own sessions',
    'AdminAuthController.me': 'reads the caller’s own identity',
    'AdminAuthController.sessions': 'reads the caller’s own sessions',
    // Ending a session is destructive and grants nothing: the worst a flood
    // achieves is signing the caller out of their own sessions.
    'AuthController.logout': 'ends the caller’s own session',
    'AuthController.revokeSession': 'ends one of the caller’s own sessions',
    'AdminAuthController.logout': 'ends the caller’s own session',
    'AdminAuthController.revokeSession': 'ends one of the caller’s own sessions',
    // Profile media. Throttled in their own right at 20/hour — a size and rate
    // concern rather than a credential one.
    'AuthController.uploadAvatar': 'profile media; carries its own 20/hour limit',
    'AuthController.removeAvatar': 'profile media',
    'AdminAuthController.uploadAvatar': 'profile media; carries its own 20/hour limit',
    'AdminAuthController.removeAvatar': 'profile media',
    // An admin may change their own NAME here and deliberately not their email
    // — the account-takeover primitive is not on this route.
    'AdminAuthController.updateProfile': 'changes the caller’s display name, never their email',
    // Administration OF invites rather than acceptance of one: permission-gated
    // reads and revocations that present no token.
    'AdminAuthController.listInvites': 'lists outstanding invites; presents no token',
    'AdminAuthController.revokeInvite': 'revokes one; presents no token',
  };

  it.each([
    ['AuthController', AuthController.prototype],
    ['AdminAuthController', AdminAuthController.prototype],
  ])('%s: every handler is classified', (label, prototype) => {
    const classified = new Set([
      ...CREDENTIAL_ROUTES.filter((r) => r.controller === prototype).map((r) => r.method),
      ...Object.keys(NOT_A_CREDENTIAL)
        .filter((key) => key.startsWith(`${label}.`))
        .map((key) => key.slice(label.length + 1)),
    ]);

    const unclassified = handlersOf(prototype)
      .filter((name) => !classified.has(name))
      .sort();

    expect(
      unclassified,
      'These handlers are neither listed as credential routes (and therefore asserted to ' +
        'carry a limit) nor explained as not being one. They currently inherit the global ' +
        '120/min by omission:\n' +
        unclassified.map((n) => `  ${n}`).join('\n'),
    ).toEqual([]);
  });
});
