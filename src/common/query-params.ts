import { BadRequestException, ParseUUIDPipe } from '@nestjs/common';

/**
 * Validation for path and query parameters — PLATFORM-CONVENTIONS R-2.1.
 *
 * ## Why bodies were covered and these were not
 *
 * The global `ValidationPipe` only validates where a DTO CLASS exists to reflect
 * on. `@Body() dto: CreateRoleDto` is validated; `@Query('state') state?: string`
 * is a bare string parameter with no metadata, so the pipe has nothing to work
 * with and the value passes through untouched. Every request DTO in this repo is
 * a class, which made the body side look complete and hid that the other half of
 * caller-supplied input had no gate at all.
 *
 * ## What was actually wrong
 *
 * Not injection. Drizzle parameterises, and the audit confirmed no string
 * interpolation into SQL anywhere. Two other things:
 *
 *  - **Enum columns.** `transactions.service.ts:175` did
 *    `eq(transactions.state, filter.state as 'pending')` — a cast, which erases
 *    at runtime. `?state=nonsense` reached Postgres as a comparison against a
 *    `transaction_state` enum column, which errors with `invalid input value for
 *    enum`. That surfaced as a 500. A 500 tells the caller nothing about what
 *    they got wrong, and it puts a database error in the log for what is
 *    ordinarily a typo — which is how a log stops being worth reading.
 *
 *  - **UUID columns.** `eq(users.id, 'abc')` against a `uuid` column is
 *    `invalid input syntax for type uuid`, also a 500. `GET /admin/clients/abc`
 *    should be a 400, and after that a 404 — never a stack trace.
 *
 * ## The allowlists are derived, not retyped
 *
 * `enumQuery` takes the allowed values rather than owning them, and every call
 * site passes `.enumValues` straight off the Drizzle enum in
 * `database/schema.ts`. So a value added to the schema is accepted here with no
 * second edit, and one removed stops being accepted. A hand-copied array would
 * be correct on the day it was written and quietly wrong afterwards — and
 * "quietly wrong afterwards" is the whole failure mode this file exists to
 * prevent.
 *
 * Taking them as a parameter also keeps this file out of `database/`, so the
 * layering rule that `common/` imports nothing from `modules/**` stays trivially
 * true here.
 */

/**
 * A `uuid` path parameter.
 *
 * `ParseUUIDPipe` is Nest's, but the default 400 body is a bare sentence. This
 * keeps the `code` field the rest of the API emits (R-2.2), so a client handles
 * one error shape rather than two.
 */
export const UuidParam = new ParseUUIDPipe({
  exceptionFactory: () =>
    new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: ['must be a UUID'],
      fields: { id: 'must be a UUID' },
    }),
});

/**
 * Validate an optional enum-valued query parameter against its schema enum.
 *
 * Returns `undefined` for an absent value — an omitted filter is not an invalid
 * one, and treating it as such would break every unfiltered list request.
 */
export function enumQuery<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  field: string,
): T | undefined {
  if (value === undefined || value === '') return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: [`${field} must be one of: ${allowed.join(', ')}`],
      fields: { [field]: `must be one of: ${allowed.join(', ')}` },
    });
  }
  return value as T;
}

/**
 * A free-text search term.
 *
 * Bounded because it reaches a `LIKE`/`pg_trgm` predicate: an unbounded term is
 * work the database does on the caller's behalf, and a very long one is cheap to
 * send and expensive to answer. 200 characters is far past any real name or
 * email and far short of a problem.
 */
export const MAX_SEARCH_LENGTH = 200;

export function searchQuery(value: string | undefined, field = 'q'): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (trimmed.length > MAX_SEARCH_LENGTH) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: [`${field} must be at most ${MAX_SEARCH_LENGTH} characters`],
      fields: { [field]: `must be at most ${MAX_SEARCH_LENGTH} characters` },
    });
  }
  return trimmed;
}
