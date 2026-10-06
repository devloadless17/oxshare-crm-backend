import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import {
  AuthenticationError,
  AuthorizationError,
  EmailNotVerifiedError,
  KycNotVerifiedError,
  AccountNameTakenError,
  ConflictError,
  KycCorrectionRefusedError,
  TagChangeLeavesScopeError,
  BulkLeavesScopeError,
  BulkTargetChangedError,
  KycConfigStaleError,
  KycBuilderOutdatedError,
  ReferralCodeUnknownError,
  ReferralPartnerInactiveError,
  ReferralSelfError,
  ReferrerAlreadySetError,
  ExternalServiceError,
  DomainError,
  FieldValidationError,
  ProfileLockedError,
  EmailAlreadyRegisteredError,
  PhoneAlreadyRegisteredError,
  MailNotConfiguredError,
  AssistantBusyError,
  AssistantCapacityError,
  AssistantConversationFullError,
  AssistantDuplicateError,
  AssistantDailyLimitError,
  AssistantRateLimitError,
  AssistantUnavailableError,
  MoneyRuleError,
  QuotaExceededError,
  ClientNotFoundError,
  NotFoundError,
  PaymentIndeterminateError,
  ValidationError,
} from '../errors/domain-errors';
import { safeLogPath } from '../logging/redact';
import { requestContext } from '../logging/request-context';
import { localizeFields, localizeMessage } from '../i18n/localize-message';
import { LOCALE_HEADER, parseLocale, type Locale } from '../i18n/locale';

/**
 * The single place transport concerns meet domain errors.
 *
 * There was no exception filter at all, so any non-HttpException — a Postgres
 * unique violation, a TypeError, a Drizzle failure — reached the default
 * handler as an opaque 500 with an unstructured stack on stdout and no
 * correlation id for the caller to quote.
 *
 * Two rules here:
 *  1. Domain errors map to status codes; services never import HTTP types.
 *  2. Unexpected errors are logged in full and answered with a generic
 *     message plus a request id. Internal detail never reaches the client.
 */
const DOMAIN_STATUS = new Map<new (...args: never[]) => DomainError, HttpStatus>([
  [NotFoundError, HttpStatus.NOT_FOUND],
  // Same status as NotFoundError; the point is the distinct `code` it carries.
  [ClientNotFoundError, HttpStatus.NOT_FOUND],
  [ValidationError, HttpStatus.BAD_REQUEST],
  /*
   * Same 400 as a validation failure, and the point is the distinct `code`.
   *
   * The provider was asked to start a payment and did not say whether it did.
   * The client's next step differs from every other 400 here — check the payment
   * history before retrying, because a link may exist — and a frontend must be
   * able to tell that apart without matching on English.
   */
  [PaymentIndeterminateError, HttpStatus.BAD_REQUEST],
  [AuthenticationError, HttpStatus.UNAUTHORIZED],
  [AuthorizationError, HttpStatus.FORBIDDEN],
  [EmailNotVerifiedError, HttpStatus.FORBIDDEN],
  [KycNotVerifiedError, HttpStatus.FORBIDDEN],
  [ConflictError, HttpStatus.CONFLICT],
  // A tag change that would hide the client from the admin making it: the
  // console asks "hand them over?" and resends confirmed. See the class.
  [TagChangeLeavesScopeError, HttpStatus.CONFLICT],
  [BulkTargetChangedError, HttpStatus.CONFLICT],
  // Its own code (KYC_CORRECTION_REFUSED) but the same status: the caller
  // branches on the code, and 409 is still what happened.
  [KycCorrectionRefusedError, HttpStatus.CONFLICT],
  // The KYC form changed under the operator's edit — reload, not a field to fix.
  [KycConfigStaleError, HttpStatus.CONFLICT],
  [KycBuilderOutdatedError, HttpStatus.CONFLICT],
  // A field the verification has locked — nothing wrong with the value, the
  // record's state refuses it. Carries `fields`, like a validation error.
  [ProfileLockedError, HttpStatus.CONFLICT],
  // Sign-up with a taken address — the portal puts it under the email FIELD and
  // offers sign-in and a password reset. See the class.
  [EmailAlreadyRegisteredError, HttpStatus.CONFLICT],
  // A number another client holds — on the phone FIELD, wherever it was typed.
  [PhoneAlreadyRegisteredError, HttpStatus.CONFLICT],
  [ReferralCodeUnknownError, HttpStatus.BAD_REQUEST],
  [ReferralSelfError, HttpStatus.BAD_REQUEST],
  [ReferralPartnerInactiveError, HttpStatus.BAD_REQUEST],
  [ReferrerAlreadySetError, HttpStatus.CONFLICT],
  // Same 409, and the point is the distinct `code` — the portal puts this one on
  // the name FIELD rather than at the top of the dialog. See the class.
  [AccountNameTakenError, HttpStatus.CONFLICT],
  [MoneyRuleError, HttpStatus.UNPROCESSABLE_ENTITY],
  // Beside the other size refusal on the upload path, so anyone debugging a failed
  // upload finds both in the same place. See QuotaExceededError.
  [QuotaExceededError, HttpStatus.PAYLOAD_TOO_LARGE],
  // 502: this service is fine, something it calls is not — see the class.
  [ExternalServiceError, HttpStatus.BAD_GATEWAY],
  // 503: nothing is broken and there is no upstream to have failed — mail has
  // simply not been configured yet. See MailNotConfiguredError.
  [MailNotConfiguredError, HttpStatus.SERVICE_UNAVAILABLE],
  // The portal assistant (0187): each code drives a different state in the widget.
  [AssistantUnavailableError, HttpStatus.SERVICE_UNAVAILABLE],
  [AssistantCapacityError, HttpStatus.SERVICE_UNAVAILABLE],
  [AssistantDailyLimitError, HttpStatus.TOO_MANY_REQUESTS],
  [AssistantRateLimitError, HttpStatus.TOO_MANY_REQUESTS],
  [AssistantBusyError, HttpStatus.CONFLICT],
  [AssistantConversationFullError, HttpStatus.CONFLICT],
  [AssistantDuplicateError, HttpStatus.CONFLICT],
]);

/**
 * A code for an HttpException that declared none.
 *
 * Deliberately coarse: these exist so a frontend never has to branch on prose,
 * not to enumerate every status. Anything that wants a specific code should
 * throw a DomainError, which carries one.
 */
function httpCodeFor(status: number): string {
  if (status === 400) return 'BAD_REQUEST';
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 413) return 'PAYLOAD_TOO_LARGE';
  if (status === 429) return 'RATE_LIMITED';
  return 'HTTP_ERROR';
}

/** Postgres error codes worth translating rather than leaking as a 500. */
const PG_CONFLICT = '23505'; // unique_violation
const PG_FK_VIOLATION = '23503'; // foreign_key_violation
const PG_INVALID_TEXT = '22P02'; // invalid_text_representation — e.g. a non-UUID id

/**
 * body-parser's "too large", by its own marker rather than by message text.
 *
 * `type: 'entity.too.large'` is the stable identifier body-parser sets; the
 * human message is not, and matching on prose is how this breaks on an upgrade
 * nobody connects to it. `statusCode` is checked as a fallback for any other
 * middleware that raises the same condition the same way.
 */
function isPayloadTooLarge(exception: unknown): boolean {
  if (typeof exception !== 'object' || exception === null) return false;
  const e = exception as { type?: unknown; status?: unknown; statusCode?: unknown };
  return (
    e.type === 'entity.too.large' ||
    e.status === HttpStatus.PAYLOAD_TOO_LARGE ||
    e.statusCode === HttpStatus.PAYLOAD_TOO_LARGE
  );
}

/**
 * Finds the Postgres error code, wherever the driver stack has buried it.
 *
 * This USED to read `exception.code` directly, and that stopped working the day
 * drizzle-orm 0.45 landed: it wraps driver errors in its own
 * `Failed query: …` Error and moves the original to `cause`. Nothing failed
 * loudly — the wrapper simply has no `code`, so every unique violation and every
 * foreign-key violation silently became a 500 instead of a 409 or a 400. The
 * same wrapping broke a message assertion in money.spec, which is the only
 * reason it was noticed at all.
 *
 * Walking the chain is version-proof: it finds the code whether the driver error
 * is thrown bare or wrapped any number of times.
 */
/*
 * The DATABASE is unreachable, not the request wrong: a restart, a failover, a
 * full pool. Postgres class 08 (connection exception) and 57P0x (shutting down /
 * cannot connect now), the socket errors underneath, and node-postgres's pool
 * timeout, which carries no code. Answered 503 so clients and the proxy retry,
 * and so a log reader is not sent hunting a bug. Found live, 3 Oct 2026: a
 * Postgres restart answered every request 500 "An unexpected error occurred".
 */
const DB_UNAVAILABLE_CODES = new Set([
  '57P01',
  '57P02',
  '57P03',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
]);

function isDatabaseUnavailable(exception: unknown): boolean {
  for (let error: unknown = exception, depth = 0; error && depth < 5; depth++) {
    const { code, message } = error as { code?: unknown; message?: unknown };
    if (typeof code === 'string' && (DB_UNAVAILABLE_CODES.has(code) || code.startsWith('08'))) {
      return true;
    }
    if (
      typeof message === 'string' &&
      /timeout exceeded when trying to connect|Connection terminated/i.test(message)
    ) {
      return true;
    }
    error = (error as { cause?: unknown }).cause;
  }
  return false;
}

function pgErrorCode(exception: unknown): string | undefined {
  for (let error: unknown = exception, depth = 0; error && depth < 5; depth++) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    error = (error as { cause?: unknown }).cause;
  }
  return undefined;
}

/**
 * "Too many attempts, try again in N" — in the units a person thinks in.
 *
 * Falls back to a wait-free sentence when the header is missing or unparseable,
 * rather than printing "try again in NaN seconds". A throttle response with no
 * Retry-After is still a throttle response, and the user can still act on it.
 */
export function rateLimitMessage(retryAfter: number | string | string[] | undefined): string {
  const seconds = Number(Array.isArray(retryAfter) ? retryAfter[0] : retryAfter);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return 'Too many attempts. Please wait a moment and try again.';
  }
  if (seconds < 60) {
    return `Too many attempts. Please try again in ${Math.ceil(seconds)} seconds.`;
  }
  const minutes = Math.ceil(seconds / 60);
  return `Too many attempts. Please try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}

/** English with no Arabic in it — a sentence the catalogue could not translate. */
function isUntranslatedEnglish(original: string, localized: string): boolean {
  return localized === original && /[A-Za-z]/.test(original) && !/[\u0600-\u06FF]/.test(original);
}

/**
 * The headline an Arabic reader is shown for a sentence the catalogue could not
 * translate — chosen by the STATUS, since that is all that is known about it.
 * Text from outside the platform (a payment provider, the MT5 bridge, the mail
 * server) is English and cannot be catalogued in advance; this keeps it from
 * being an Arabic reader's headline, and `detail` keeps the original.
 */
export function arabicFallbackFor(status: number): string {
  if (status === 400) return 'تعذّر قبول الطلب.';
  if (status === 401) return 'يلزم تسجيل الدخول للمتابعة.';
  if (status === 403) return 'لا تملك صلاحية تنفيذ هذا الإجراء.';
  if (status === 404) return 'العنصر المطلوب غير موجود.';
  if (status === 409)
    return 'تعذّر إتمام الطلب لأن البيانات تغيّرت. أعد تحميل الصفحة وحاول مجدداً.';
  if (status === 413) return 'حجم الطلب كبير جداً.';
  if (status === 422) return 'تعذّر تنفيذ هذه العملية.';
  if (status === 429) return 'محاولات كثيرة جداً. يُرجى الانتظار قليلاً ثم المحاولة مجدداً.';
  if (status === 502 || status === 503 || status === 504) {
    return 'الخدمة غير متاحة مؤقتاً. يُرجى المحاولة لاحقاً.';
  }
  if (status >= 500) return 'حدث خطأ غير متوقع. يُرجى المحاولة لاحقاً.';
  return 'تعذّر إتمام الطلب.';
}

/** What one field's untranslatable message becomes for an Arabic reader. */
const ARABIC_FIELD_FALLBACK = 'هذه القيمة غير مقبولة.';

/**
 * The envelope's sentences in the request's language (2–3 Oct 2026).
 *
 * Every sentence goes through the catalogue (`localizeMessage`). For an ARABIC
 * request, a sentence it could not translate — English with no Arabic in it — is
 * replaced by a generic Arabic sentence for the status (a field's by a generic
 * field sentence), and the original English goes into `detail`, so nothing is
 * lost and nothing English is the headline. English requests are untouched.
 */
export function arabicEnvelope(
  message: string | string[],
  fields: Record<string, string> | undefined,
  status: number,
  locale: Locale,
): { message: string | string[]; fields?: Record<string, string>; detail?: string } {
  if (locale !== 'ar') return { message, fields };
  const untranslated: string[] = [];
  const headline = (line: string): string => {
    const localized = localizeMessage(line, locale);
    if (!isUntranslatedEnglish(line, localized)) return localized;
    untranslated.push(line);
    return arabicFallbackFor(status);
  };
  const localizedMessage = Array.isArray(message)
    ? [...new Set(message.map(headline))]
    : headline(message);

  let localizedFields: Record<string, string> | undefined;
  if (fields) {
    localizedFields = {};
    for (const [key, value] of Object.entries(localizeFields(fields, locale))) {
      const original = fields[key];
      if (typeof original === 'string' && isUntranslatedEnglish(original, value)) {
        localizedFields[key] = ARABIC_FIELD_FALLBACK;
        untranslated.push(`${key}: ${original}`);
      } else {
        localizedFields[key] = value;
      }
    }
  }
  return {
    message: localizedMessage,
    fields: localizedFields,
    ...(untranslated.length > 0 ? { detail: untranslated.join('\n') } : {}),
  };
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request & { id?: string }>();
    const requestId = request.id ?? 'unknown';

    const classified = this.classify(exception);
    const { status, fields } = classified;
    /*
     * A 404 from NO ROUTE is a different fact from a 404 from a route: "this
     * endpoint does not exist" (a frontend ahead of its API) versus "this
     * record does not exist — or is not yours to see". The consoles rendered
     * both as "endpoint not built yet", so a scoped admin following a link to
     * a client outside their territory was told the feature was missing.
     * Express sets `req.route` only when a route matched.
     */
    const code =
      status === HttpStatus.NOT_FOUND && (request as { route?: unknown }).route === undefined
        ? 'ROUTE_NOT_FOUND'
        : classified.code;
    /*
     * ── A RATE LIMIT IS THE ONE ERROR ORDINARY USERS ACTUALLY SEE ───────────
     *
     * `ThrottlerException: Too Many Requests` is what @nestjs/throttler puts in
     * `exception.message`, and it went straight to the screen — a client trying
     * to sign in read a Java-ish class name in a red box on the login form. It is
     * not a leak (it names no internals) but it is the most-seen error in the
     * product wearing the least human words in it, and "world class" is mostly
     * this: the ordinary path being written for the person on it.
     *
     * The wait is not invented. ThrottlerGuard has already set `Retry-After` on
     * this very response before throwing, so the number is authoritative rather
     * than a guess — which matters, because a wrong number is worse than none:
     * somebody told "try in 30 seconds" who is refused again at 31 concludes the
     * product is broken, not busy.
     *
     * Told in SECONDS under a minute and in minutes above it. "Wait 900 seconds"
     * is a number a person has to do arithmetic on while annoyed.
     *
     * The THROTTLER's 429 only. A domain refusal that is also a 429 (the
     * assistant's daily allowance, its per-minute limit) already carries its
     * own sentence and sets no `Retry-After`; replacing it told a client "wait a
     * moment" about a limit that renews at midnight.
     */
    const message =
      status === HttpStatus.TOO_MANY_REQUESTS && !(exception instanceof DomainError)
        ? rateLimitMessage(response.getHeader('Retry-After'))
        : classified.message;
    /*
     * Sensitive query VALUES redacted, parameter names kept — R-6.3. The
     * verify-email and password-reset links both carry a single-use token in the
     * query string, and a log file is a weaker boundary than the database: it is
     * shipped to aggregators, read by more people, retained longer and rarely
     * encrypted at rest.
     *
     * `?page=3&status=pending` survives, because that is what makes a 500
     * diagnosable — dropping the query string wholesale just gets the raw URL
     * added back by the next person who needs to debug something.
     */
    const path = safeLogPath(request.url);

    // The correlation id is attached by JsonLogger from the async-local
    // request context, so it does not need repeating in every message.
    // 5xx means we did not anticipate it — log everything we have.
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${request.method} ${path} → ${status}: ${
          exception instanceof Error ? exception.message : String(exception)
        }`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(`${request.method} ${path} → ${status} ${code}`);
    }

    /*
     * THE CLIENT'S LANGUAGE (2 Oct 2026). The portal sends `X-OxShare-Locale`;
     * for Arabic every sentence — `message` and each `fields` entry — is
     * translated here, the one place errors leave the process, from the
     * catalogue in `common/i18n/server-messages.ar.ts`. `code` never changes:
     * it is what a screen branches on. The admin console never sends the
     * header, so it stays English. The header is read directly as a fallback
     * because a body-parser refusal is raised before the middleware that sets
     * the request context has run.
     */
    const locale = this.localeOf(request);
    const translated = arabicEnvelope(message, fields, status, locale);

    response.status(status).json({
      statusCode: status,
      code,
      message: translated.message,
      // Omitted entirely rather than sent as `null`: a consumer checking
      // `if (body.fields)` should not have to also check for an empty object.
      ...(translated.fields && Object.keys(translated.fields).length > 0
        ? { fields: translated.fields }
        : {}),
      // The English an Arabic reader was NOT shown (3 Oct 2026) — see `arabicEnvelope`.
      ...(translated.detail ? { detail: translated.detail } : {}),
      requestId,
      timestamp: new Date().toISOString(),
      path,
    });
  }

  private localeOf(request: Request): Locale {
    return (
      requestContext.getStore()?.locale ??
      parseLocale((request.headers as Record<string, unknown> | undefined)?.[LOCALE_HEADER])
    );
  }

  private classify(exception: unknown): {
    status: HttpStatus;
    message: string | string[];
    code: string;
    /** Present only on validation failures: field path -> what is wrong with it. */
    fields?: Record<string, string>;
  } {
    // 1. Domain errors — the layer services are supposed to throw from.
    if (exception instanceof DomainError) {
      // Per-field messages from a service rule, in the request validator's shape.
      const fields =
        exception instanceof FieldValidationError ||
        exception instanceof ProfileLockedError ||
        exception instanceof EmailAlreadyRegisteredError ||
        exception instanceof PhoneAlreadyRegisteredError ||
        exception instanceof BulkLeavesScopeError ||
        exception instanceof BulkTargetChangedError
          ? exception.fields
          : undefined;
      for (const [type, status] of DOMAIN_STATUS) {
        if (exception instanceof type) {
          return { status, message: exception.message, code: exception.code, fields };
        }
      }
      return {
        status: HttpStatus.BAD_REQUEST,
        message: exception.message,
        code: exception.code,
      };
    }

    /*
     * 1b. An oversized request body — body-parser, before any route ran.
     *
     * ## Why this needs its own branch
     *
     * The LIMIT itself was always there (Express's 100kb default), so memory was
     * never at risk. What was wrong was the answer: body-parser throws a plain
     * `Error` carrying `type: 'entity.too.large'` and `status: 413`, not an
     * `HttpException` — so it fell through to the "anything else" branch and
     * came back as a 500.
     *
     * Two things follow from that, and the second is the reason this is a
     * security fix and not a tidy-up:
     *
     *   1. A 500 tells the caller "our fault, try again", when it is the
     *      caller's fault and retrying makes it worse.
     *   2. Every 5xx logs a FULL STACK TRACE (see `catch` above). So anyone
     *      could write unbounded stack traces into the log by POSTing large
     *      bodies in a loop — on a host with no documented log rotation, that
     *      fills a disk, and long before it does it buries every real alert in
     *      noise. An attacker does not need to get IN to hurt a system; making
     *      its operators unable to see is enough.
     *
     * Answered as 413 with no stack, which is both true and quiet.
     */
    if (isPayloadTooLarge(exception)) {
      return {
        status: HttpStatus.PAYLOAD_TOO_LARGE,
        message: 'That request body is too large.',
        code: 'PAYLOAD_TOO_LARGE',
      };
    }

    // 2. Nest's own exceptions, including ValidationPipe's array messages.
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      if (typeof body === 'string') {
        /*
         * `httpCodeFor`, not the literal `HTTP_ERROR` it used to return.
         *
         * Whether a Nest exception carries a string or an object body is an
         * implementation detail of whoever threw it — but it decided the CODE,
         * so the same status arrived as `RATE_LIMITED` from one thrower and
         * `HTTP_ERROR` from another. `ThrottlerException` is the one that
         * matters: it throws a string body, so every 429 in the system reached
         * the frontends codeless.
         *
         * The portal's verification screen is where that showed. With no code
         * to branch on, a rate-limited click fell through to the generic red
         * box and read "Verification Failed" — telling a client their link was
         * broken when the only thing that happened is that we asked them to
         * wait. Same class of defect as UX-01, one layer down.
         */
        return {
          status: exception.getStatus(),
          message: body,
          code: httpCodeFor(exception.getStatus()),
        };
      }

      const shaped = body as {
        message?: string | string[];
        code?: string;
        error?: string;
        fields?: Record<string, string>;
      };

      /*
       * The machine code comes from a CLOSED SET — R-2.2.
       *
       * This used to fall back to `body.error`, which for a validation failure
       * is the literal string "Bad Request": a humanized status name, not a code.
       * A frontend branching on it is branching on prose that changes when Nest
       * changes, and cannot express two different 400s differently.
       *
       * Anything that has not declared a code gets HTTP_ERROR, which is at least
       * honestly non-specific rather than falsely specific.
       */
      return {
        status: exception.getStatus(),
        message: shaped.message ?? exception.message,
        code: shaped.code ?? httpCodeFor(exception.getStatus()),
        fields: shaped.fields,
      };
    }

    // 3. Database constraint violations — meaningful, not internal errors.
    if (isDatabaseUnavailable(exception)) {
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        message: 'The service is briefly unavailable. Please try again in a moment.',
        code: 'SERVICE_UNAVAILABLE',
      };
    }

    const pgCode = pgErrorCode(exception);
    if (pgCode === PG_CONFLICT) {
      return {
        status: HttpStatus.CONFLICT,
        message: 'That record already exists.',
        code: 'CONFLICT',
      };
    }
    if (pgCode === PG_FK_VIOLATION) {
      return {
        status: HttpStatus.BAD_REQUEST,
        message: 'A referenced record does not exist.',
        code: 'INVALID_REFERENCE',
      };
    }
    /*
     * A malformed identifier is the CALLER's mistake, not ours.
     *
     * `PATCH /admin/withdrawals/does-not-exist/approve` reached the SQL layer,
     * Postgres rejected "does-not-exist" as a uuid, and the result was a 500 —
     * so bad input from a typo'd URL was logged with a full stack as an
     * unexpected server error, competing for attention with real incidents.
     * Mapping it here covers every route at once, including ones written later.
     */
    if (pgCode === PG_INVALID_TEXT) {
      return {
        status: HttpStatus.BAD_REQUEST,
        message: 'A value in the request is not a valid identifier.',
        code: 'INVALID_IDENTIFIER',
      };
    }

    // 4. Anything else: log it fully (above), tell the client nothing.
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'An unexpected error occurred. Quote the request id when reporting this.',
      code: 'INTERNAL_ERROR',
    };
  }
}
