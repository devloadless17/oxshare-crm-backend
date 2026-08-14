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
  ConflictError,
  ExternalServiceError,
  DomainError,
  MoneyRuleError,
  QuotaExceededError,
  ClientNotFoundError,
  NotFoundError,
  PaymentIndeterminateError,
  ValidationError,
} from '../errors/domain-errors';
import { safeLogPath } from '../logging/redact';

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
  [MoneyRuleError, HttpStatus.UNPROCESSABLE_ENTITY],
  // Beside the other size refusal on the upload path, so anyone debugging a failed
  // upload finds both in the same place. See QuotaExceededError.
  [QuotaExceededError, HttpStatus.PAYLOAD_TOO_LARGE],
  // 502: this service is fine, something it calls is not — see the class.
  [ExternalServiceError, HttpStatus.BAD_GATEWAY],
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
function pgErrorCode(exception: unknown): string | undefined {
  for (let error: unknown = exception, depth = 0; error && depth < 5; depth++) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    error = (error as { cause?: unknown }).cause;
  }
  return undefined;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request & { id?: string }>();
    const requestId = request.id ?? 'unknown';

    const { status, message, code, fields } = this.classify(exception);
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

    response.status(status).json({
      statusCode: status,
      code,
      message,
      // Omitted entirely rather than sent as `null`: a consumer checking
      // `if (body.fields)` should not have to also check for an empty object.
      ...(fields && Object.keys(fields).length > 0 ? { fields } : {}),
      requestId,
      timestamp: new Date().toISOString(),
      path,
    });
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
      for (const [type, status] of DOMAIN_STATUS) {
        if (exception instanceof type) {
          return { status, message: exception.message, code: exception.code };
        }
      }
      return {
        status: HttpStatus.BAD_REQUEST,
        message: exception.message,
        code: exception.code,
      };
    }

    // 2. Nest's own exceptions, including ValidationPipe's array messages.
    if (exception instanceof HttpException) {
      const body = exception.getResponse();
      if (typeof body === 'string') {
        return { status: exception.getStatus(), message: body, code: 'HTTP_ERROR' };
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
