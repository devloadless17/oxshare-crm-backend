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
  ConflictError,
  DomainError,
  MoneyRuleError,
  NotFoundError,
  ValidationError,
} from '../errors/domain-errors';

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
  [ValidationError, HttpStatus.BAD_REQUEST],
  [AuthenticationError, HttpStatus.UNAUTHORIZED],
  [AuthorizationError, HttpStatus.FORBIDDEN],
  [ConflictError, HttpStatus.CONFLICT],
  [MoneyRuleError, HttpStatus.UNPROCESSABLE_ENTITY],
]);

/** Postgres error codes worth translating rather than leaking as a 500. */
const PG_CONFLICT = '23505'; // unique_violation
const PG_FK_VIOLATION = '23503'; // foreign_key_violation

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request & { id?: string }>();
    const requestId = request.id ?? 'unknown';

    const { status, message, code } = this.classify(exception);

    // The correlation id is attached by JsonLogger from the async-local
    // request context, so it does not need repeating in every message.
    // 5xx means we did not anticipate it — log everything we have.
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `${request.method} ${request.url} → ${status}: ${
          exception instanceof Error ? exception.message : String(exception)
        }`,
        exception instanceof Error ? exception.stack : undefined,
      );
    } else {
      this.logger.warn(`${request.method} ${request.url} → ${status} ${code}`);
    }

    response.status(status).json({
      statusCode: status,
      code,
      message,
      requestId,
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }

  private classify(exception: unknown): {
    status: HttpStatus;
    message: string | string[];
    code: string;
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
      const message =
        typeof body === 'string'
          ? body
          : ((body as { message?: string | string[] }).message ?? exception.message);
      return {
        status: exception.getStatus(),
        message,
        code: (body as { error?: string }).error ?? 'HTTP_ERROR',
      };
    }

    // 3. Database constraint violations — meaningful, not internal errors.
    const pgCode = (exception as { code?: string })?.code;
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

    // 4. Anything else: log it fully (above), tell the client nothing.
    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'An unexpected error occurred. Quote the request id when reporting this.',
      code: 'INTERNAL_ERROR',
    };
  }
}
