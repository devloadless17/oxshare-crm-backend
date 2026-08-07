/**
 * Typed domain errors.
 *
 * The working agreement is explicit: "Typed domain errors thrown by services,
 * mapped to HTTP status at the controller edge only. Services never throw HTTP
 * exceptions." The codebase had 80 HTTP exceptions thrown from service and
 * store layers, which coupled the money core to `@nestjs/common` and made it
 * unusable from a queue worker or a CLI.
 *
 * These carry no transport concern. `DomainExceptionFilter` maps them to HTTP
 * at the edge; a worker can catch them directly.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(
    message: string,
    /** Safe to surface to the caller. Never put secrets or SQL in here. */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
    Error.captureStackTrace?.(this, new.target);
  }
}

/** The caller asked for something that does not exist. → 404 */
export class NotFoundError extends DomainError {
  readonly code = 'NOT_FOUND';
}

/**
 * A client that does not exist, OR one outside the caller's client scope —
 * deliberately indistinguishable.
 *
 * Its own class purely so the response carries a DISTINCT MACHINE CODE. The
 * admin app has to tell "this client is not available to you" apart from "this
 * endpoint is not built yet", and both arrive as a 404: `useResource` maps
 * every 404 to `unavailable`, which everywhere else in that app means the API
 * owner has not written the endpoint. Branching on the status alone rendered a
 * missing FEATURE as a missing CLIENT and sent people looking for a client that
 * was never the problem.
 *
 * The MESSAGE stays identical to a plain not-found, and that is the security
 * half: a caller must not be able to tell "no such client" from "not in your
 * territory", or the difference becomes an oracle for enumerating the client
 * base they were specifically denied.
 */
export class ClientNotFoundError extends DomainError {
  readonly code = 'CLIENT_NOT_FOUND';

  constructor(message = 'Client not found.') {
    super(message);
  }
}

/** The request was structurally fine but semantically invalid. → 400 */
export class ValidationError extends DomainError {
  readonly code = 'VALIDATION_FAILED';
}

/**
 * The caller is not authenticated. → 401
 *
 * `code` is annotated `: string` rather than left to infer the literal, because
 * the subclasses below refine it. Without the annotation TypeScript narrows this
 * to `'UNAUTHENTICATED'` and every subclass is a type error — which is a real
 * constraint worth stating rather than working around: 401 is the one status
 * that means several different things here, and the code is how they are told
 * apart.
 */
export class AuthenticationError extends DomainError {
  readonly code: string = 'UNAUTHENTICATED';
}

/*
 * ── Why 401 is not one answer ────────────────────────────────────────────────
 *
 * Every authentication failure used to arrive as `401 / UNAUTHENTICATED`: an
 * access token fifteen minutes old, a refresh token revoked an hour ago, a
 * replayed token, and a request that merely lost a rotation race. A frontend
 * has to respond differently to those — renew and retry, or sign the user out —
 * and had nothing to branch on but the status.
 *
 * Both frontends therefore guessed, and both guesses were wrong somewhere. The
 * admin console froze on a spinner; the portal left a signed-out tab rendering a
 * client's balance. The heuristics they grew to paper over it (reading the CSRF
 * cookie to infer whether a session had ever existed) are the direct cause of
 * three user-visible defects.
 *
 * These subclasses exist ONLY to carry a distinct `code`. The status is 401 in
 * every case — they inherit it through `AuthenticationError`, so the filter's
 * map needs no new entries — and the messages are unchanged. Adding a code is
 * additive: a client that ignores it behaves exactly as before.
 *
 * The security property that matters is preserved: none of these codes tells an
 * UNAUTHENTICATED caller anything. You cannot reach `SESSION_REVOKED` without
 * presenting a token that was genuinely issued to you, so no code here
 * distinguishes "this account exists" from "it does not".
 */

/**
 * The credential was valid and is simply past its expiry. → 401 `TOKEN_EXPIRED`
 *
 * The client should renew and retry. This is the ordinary state of any tab
 * older than fifteen minutes and must never be rendered as "you were signed
 * out".
 */
export class SessionExpiredError extends AuthenticationError {
  override readonly code = 'TOKEN_EXPIRED';
}

/**
 * The session is over and cannot be renewed. → 401 `SESSION_REVOKED`
 *
 * Logged out elsewhere, suspended, password changed, or the refresh token's row
 * is gone. The client should stop retrying and send the user to sign in.
 */
export class SessionRevokedError extends AuthenticationError {
  override readonly code = 'SESSION_REVOKED';
}

/**
 * An already-rotated token was replayed. → 401 `SESSION_REPLAYED`
 *
 * Distinct from `SESSION_REVOKED` because the whole family has just been
 * destroyed as a security response (R-3.3), so this is the one case where the
 * user should be told their session was ended deliberately rather than
 * expiring.
 */
export class SessionReplayedError extends AuthenticationError {
  override readonly code = 'SESSION_REPLAYED';
}

/**
 * This refresh lost a race with a concurrent one. → 401 `SESSION_SUPERSEDED`
 *
 * **The session is alive.** Another request rotated the same token first, and
 * the winner's cookies are already in this browser's jar — so the correct client
 * response is to retry, not to sign out.
 *
 * It used to answer "Session has been revoked", which is how two tabs waking
 * together ejected one of them from a perfectly good thirty-day session.
 */
export class SessionSupersededError extends AuthenticationError {
  override readonly code = 'SESSION_SUPERSEDED';
}

/** The caller is authenticated but not allowed. → 403 */
export class AuthorizationError extends DomainError {
  readonly code = 'FORBIDDEN';
}

/**
 * Authenticated, but the email address is unverified. → 403
 *
 * A distinct subclass ONLY so it carries a distinct `code`. It is not a
 * different kind of refusal — `FORBIDDEN` would be an accurate status — but the
 * portal has to tell this one apart from every other 403 in order to offer the
 * "resend verification" affordance, and the only thing it had to go on was the
 * ENGLISH TEXT of the message (`login/page.tsx`: `.includes('verify your
 * email')`). That breaks when the wording changes and again on the day Arabic
 * ships, which FSD §10 / D-16 require.
 *
 * A client should never have to read prose to make a decision.
 */
export class EmailNotVerifiedError extends DomainError {
  readonly code = 'EMAIL_NOT_VERIFIED';
}

/**
 * Authenticated and email-verified, but identity is not verified. → 403
 *
 * A distinct subclass for exactly the reason `EmailNotVerifiedError` above is
 * one: the portal has to tell this refusal apart from every other 403 in order
 * to offer the way OUT of it — a link to the KYC flow — and the only
 * alternative is matching the English text of the message, which breaks on a
 * copy edit and again on the day Arabic ships.
 *
 * The distinction matters more here than there. A client refused a deposit sees
 * a screen about money; "you cannot do this" without "and here is how to become
 * able to" is the version of this refusal that generates a support ticket.
 */
export class KycNotVerifiedError extends DomainError {
  readonly code = 'KYC_NOT_VERIFIED';
}

/** The operation conflicts with existing state. → 409 */
export class ConflictError extends DomainError {
  readonly code = 'CONFLICT';
}

/** A money rule was violated — insufficient funds, bad state transition. → 422 */
export class MoneyRuleError extends DomainError {
  readonly code = 'MONEY_RULE_VIOLATION';
}
