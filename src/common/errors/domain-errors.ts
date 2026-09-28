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

/**
 * The request was structurally fine but semantically invalid. → 400
 *
 * `code` is annotated `: string` rather than left to infer the literal, for the
 * reason spelled out on `AuthenticationError` below: the subclass beneath
 * refines it, and without the annotation TypeScript narrows this to
 * `'VALIDATION_FAILED'` and every subclass becomes a type error.
 */
export class ValidationError extends DomainError {
  readonly code: string = 'VALIDATION_FAILED';
}

/**
 * A form's values refused FIELD BY FIELD → 400 `VALIDATION_FAILED`, with a
 * `fields` map shaped exactly like the one the request validator emits
 * (`common/validation.config.ts`).
 *
 * Service-layer rules — a profile's date of birth, a phone number that cannot
 * be dialled — find problems the DTO decorators cannot, and until this existed
 * they could only answer with one sentence. A screen then had to guess which
 * box to mark. Same code, same `fields` key, whichever layer found the problem:
 * a form reads field errors one way.
 */
export class FieldValidationError extends ValidationError {
  constructor(
    message: string,
    readonly fields: Record<string, string>,
  ) {
    super(message, { fields });
  }
}

/**
 * A profile field the verification has LOCKED. → 409 `PROFILE_LOCKED`, with
 * `fields` naming each one and where it can be changed instead.
 *
 * A 409 rather than a 400: nothing about the values is wrong — the record's
 * state refuses them. Once a KYC submission leaves the client's hands the
 * identity it carries is what a reviewer is checking, or has checked, against
 * documents; `adminEditRule` (`common/profile/client-profile.ts`) holds the rule.
 */
export class ProfileLockedError extends DomainError {
  readonly code = 'PROFILE_LOCKED';

  constructor(
    message: string,
    readonly fields: Record<string, string>,
  ) {
    super(message, { fields });
  }
}

/**
 * Sign-up with an address that already has an account. → 409
 * `EMAIL_ALREADY_REGISTERED`, with the sentence under `email`.
 *
 * ⚠️ The owner's ruling (28 Sep 2026) REVERSES the enumeration-safe design: the
 * sign-up form now says plainly that an address is taken. Registration used to
 * answer a taken address exactly as a new one and email the holder instead, so
 * the form told nobody who holds an account. The client who already had one
 * then stood on a code screen waiting for a code that never came, while their
 * inbox said the opposite (reported). The accepted cost: anyone can test
 * whether an address has an account, bounded by the sign-up rate limits.
 */
export class EmailAlreadyRegisteredError extends DomainError {
  readonly code = 'EMAIL_ALREADY_REGISTERED';

  constructor(
    message: string,
    readonly fields: Record<string, string>,
  ) {
    super(message, { fields });
  }
}

/**
 * The verification link's 24 hours are up. → 400 `VERIFICATION_TOKEN_EXPIRED`
 *
 * A distinct subclass ONLY so it carries a distinct `code`, exactly as
 * `EmailNotVerifiedError` is one. The portal's verification screen has three
 * outcomes to tell apart — redeemed, expired, never valid — and until now all
 * three arrived as `400 / VALIDATION_FAILED` with different English in
 * `message`. It rendered one red "Verification Failed" for all of them, which
 * is how a client whose link had merely aged out was told to do nothing in
 * particular instead of "request a new one".
 *
 * A client should never have to read prose to make a decision.
 */
export class VerificationTokenExpiredError extends ValidationError {
  override readonly code = 'VERIFICATION_TOKEN_EXPIRED';
}

/**
 * The emailed 6-digit code did not confirm anything. → 400 `EMAIL_CODE_INVALID`
 *
 * ONE code for every way a code fails — wrong, expired, used up, superseded, or
 * an address with no code at all — and deliberately so. Telling those apart
 * would let anyone learn which addresses are registered and unconfirmed, the
 * oracle `register` is built not to be. The client's next step is the same in
 * every case anyway: check the latest email, or send a new code.
 */
export class EmailCodeInvalidError extends ValidationError {
  override readonly code = 'EMAIL_CODE_INVALID';
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

/**
 * A tag change that would take the client out of the ACTING administrator's
 * own view, sent without the confirmation that says they meant it. → 409
 *
 * Its own code because the console answers it with a question, not an error:
 * "after this you will no longer see this client — continue?", and the resend
 * carries `confirmLeavesScope=true`. Handing a client to another desk is a
 * legitimate act (owner, 28 Sep 2026); doing it by accident, with the client
 * vanishing from the screen mid-task, is what the confirmation stops.
 */
export class TagChangeLeavesScopeError extends DomainError {
  readonly code = 'TAG_CHANGE_LEAVES_SCOPE';
}

/**
 * A correction to an APPROVED KYC submission was refused by the same rules that
 * govern submission — the value is impossible, in the future, or under 18. → 409
 *
 * Its OWN code rather than a bare `ConflictError`, for the reason
 * `TradingAccountNameTakenError` below has one: the caller has to branch on it.
 * A 400 means "you typed it wrong" and belongs in a form error. THIS means the
 * RECORD is wrong — an operator has just discovered that an approved client is
 * underage or carries an impossible date of birth, which is a compliance event
 * needing a different screen and a different follow-up. Collapsing the two hides
 * the second inside the first.
 *
 * The rule that refused is in the MESSAGE rather than a details payload,
 * because `AllExceptionsFilter` does not surface `DomainError.details` — only
 * `code`, `message` and the pipe's own `fields`. Putting a machine-readable kind
 * somewhere the filter drops it would be a contract that silently does not
 * exist, which is the defect this codebase spent a day finding.
 */
export class KycCorrectionRefusedError extends DomainError {
  readonly code = 'KYC_CORRECTION_REFUSED';
}

/**
 * A save of the KYC form made from a version somebody else has since changed.
 * → 409 `KYC_CONFIG_STALE`
 *
 * Its own code because the builder answers it differently from every other
 * refusal: nothing the operator typed is wrong — they are editing a form that
 * no longer exists, and the remedy is to reload and see the other change, not
 * to fix a field. Before this, the later save silently replaced the earlier
 * one, and whoever pressed Save first lost their work without being told.
 */
export class KycConfigStaleError extends DomainError {
  readonly code = 'KYC_CONFIG_STALE';
}

/**
 * Repairing a client's referral attribution, refused. THREE CODES, NOT ONE. → 400
 *
 * They need three different sentences and one status makes the screen guess:
 *
 *   UNKNOWN   the code matches no partner — a typo the operator can fix
 *   SELF      it is this client's own code — a mistake they should see named
 *   INACTIVE  the code was RIGHT and that partner is suspended, which is a
 *             decision somebody else made and a different conversation
 *
 * The third is the one that earns the split. "Check the spelling" and "the
 * client was telling the truth, the partner is suspended" send an operator to
 * different places, and a single 400 sends them to the first.
 */
export class ReferralCodeUnknownError extends DomainError {
  readonly code = 'REFERRAL_CODE_UNKNOWN';
}

/** The code names the client themselves — `resolveChain` would walk a self-edge. */
export class ReferralSelfError extends DomainError {
  readonly code = 'REFERRAL_SELF';
}

/** The code resolves, and that partner is suspended. The code was not the problem. */
export class ReferralPartnerInactiveError extends DomainError {
  readonly code = 'REFERRAL_PARTNER_INACTIVE';
}

/**
 * The client ALREADY has a referrer. → 409
 *
 * ⚠️ THIS IS THE A→B REFUSAL AND IT IS THE POINT OF THE ROUTE.
 *
 * `docs/` forbids a "change my IB" flow and is right: re-pointing attribution
 * moves a partner's client, and their future commissions, to somebody else.
 * Filling NULL→A takes nothing from anybody — the client WAS referred and the
 * attribution was lost by our own defect. The refusal lives in the service
 * rather than in a screen so the route cannot become a change-my-IB flow by
 * somebody relaxing a rendering condition six months from now.
 */
export class ReferrerAlreadySetError extends DomainError {
  readonly code = 'REFERRER_ALREADY_SET';
}

/**
 * This client already has a trading account by that name. → 409
 *
 * Its OWN code rather than a bare `ConflictError`, because the portal has to be
 * able to put the message on the name FIELD instead of at the top of the dialog
 * as a general failure. A client who has typed a duplicate has one specific
 * thing to change, and a form that says "something conflicted" leaves them
 * guessing which of four fields it was.
 *
 * A 409 rather than a 422: the request is well-formed and would have been
 * accepted a moment ago. What refuses it is existing state.
 */
export class AccountNameTakenError extends DomainError {
  readonly code = 'ACCOUNT_NAME_TAKEN';
}

/** A money rule was violated — insufficient funds, bad state transition. → 422 */
export class MoneyRuleError extends DomainError {
  readonly code = 'MONEY_RULE_VIOLATION';
}

/**
 * A per-account allowance was exhausted — today, the document storage quota. → 413
 *
 * Its own class rather than a `ValidationError` because the caller can act on it and
 * the two need different words: a validation failure means "this file is wrong", and
 * this means "this file is fine and there is no room for it". Collapsing them would
 * tell a client their passport scan was invalid.
 *
 * 413 rather than 409 so it lands beside the other size refusal on the upload path
 * (`UploadSizeFilter`), which is where anyone debugging a failed upload will look.
 */
export class QuotaExceededError extends DomainError {
  readonly code = 'QUOTA_EXCEEDED';
}

/**
 * A payment provider was asked to start a payment and did not say whether it
 * did. → 400, like the `ValidationError` it extends.
 *
 * ## This is not a failure, and that distinction is the whole point
 *
 * A gateway can refuse three different ways: it can be unreachable, it can
 * refuse outright, or it can answer "I do not know" — Whish signals the last
 * with code `500`. The first two mean no payment exists. The third means one
 * MIGHT, and might still be payable by the client.
 *
 * The caller uses the type to decide what happens to the deposit row it already
 * wrote. A definite refusal marks it `failure`, because leaving it `pending`
 * shows the client "processing" for a payment that never started. An
 * indeterminate answer must stay `pending` and be reconciled against
 * `getStatus`, because marking it failed would tell a client who DID pay that
 * their money did not arrive — the more expensive of the two mistakes by a wide
 * margin.
 *
 * It is a sibling of `ValidationError` rather than a subclass — `code` there is
 * a literal type and cannot be narrowed — and is registered in
 * `all-exceptions.filter.ts` for the same 400, so the wire contract is unchanged
 * apart from the distinct `code` a frontend can branch on.
 */
export class PaymentIndeterminateError extends DomainError {
  readonly code = 'PAYMENT_INDETERMINATE';
}

/**
 * A service this one depends on failed or was unreachable. → 502.
 *
 * For the MT5 bridge and anything else outside this process that is not a
 * payment provider — those have `PaymentIndeterminateError` for the specific
 * "did it happen?" case.
 *
 * 502 rather than 500 because the distinction matters to whoever is paged: 500
 * means this codebase is broken, 502 means it is fine and something it calls is
 * not. On a CRM whose MT5 bridge lives on a different machine on a different
 * network, that is the first question asked.
 *
 * NOT for an indeterminate WRITE. If a call may or may not have moved money,
 * `PaymentIndeterminateError` is the one that carries "reconcile, do not retry";
 * this one means the operation did not happen.
 */
export class ExternalServiceError extends DomainError {
  readonly code = 'EXTERNAL_SERVICE_ERROR';
}

/**
 * No mail relay is configured, so nothing can be sent. → 503
 *
 * ## Why this refuses instead of trying anyway
 *
 * SMTP is admin-configured, on Settings → Email. Before the first save there is
 * no `smtp_settings` row, and `SmtpConfigService.resolve()` used to answer with
 * `smtp.example.com:587` — a syntactically valid configuration pointing at a
 * host reserved by RFC 2606 to never exist. Every send then failed inside
 * `EmailService.send`, which catches and logs rather than throwing, so a
 * verification link, a KYC decision or a withdrawal notification simply never
 * arrived and nothing above the logger knew.
 *
 * This is the same "refuse, do not degrade" principle that used to be enforced
 * by making SMTP_* required at boot. That could not stay: the process has to
 * start in order to serve the screen where mail gets configured. So the refusal
 * moved from boot time to send time, which is also where it is actionable.
 *
 * 503 rather than 500 because nothing is broken — a step of setup has not been
 * done — and rather than 502 because there is no upstream to have failed. It is
 * the one status that means "ask again once someone has finished configuring
 * this", and the message names the screen that does it.
 */
export class MailNotConfiguredError extends DomainError {
  readonly code = 'MAIL_NOT_CONFIGURED';

  constructor(
    message = 'No mail server is configured. An administrator must set one up in Settings → Email.',
  ) {
    super(message);
  }
}
