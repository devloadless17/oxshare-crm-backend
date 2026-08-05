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

/** The request was structurally fine but semantically invalid. → 400 */
export class ValidationError extends DomainError {
  readonly code = 'VALIDATION_FAILED';
}

/** The caller is not authenticated. → 401 */
export class AuthenticationError extends DomainError {
  readonly code = 'UNAUTHENTICATED';
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

/** The operation conflicts with existing state. → 409 */
export class ConflictError extends DomainError {
  readonly code = 'CONFLICT';
}

/** A money rule was violated — insufficient funds, bad state transition. → 422 */
export class MoneyRuleError extends DomainError {
  readonly code = 'MONEY_RULE_VIOLATION';
}
