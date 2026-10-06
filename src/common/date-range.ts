import { BadRequestException, applyDecorators } from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';

/**
 * THE ONE DATE-RANGE FILTER every list shares — `?from=&to=`.
 *
 * The buyer's demo (6 Oct 2026): every screen of movements must filter by a
 * period, open on TODAY, and offer from/to to the minute. "Today" is the
 * VIEWER's today, which only their browser knows, so the console resolves a
 * preset to exact instants and sends those. This turns either form into one
 * half-open interval `[from, until)`:
 *
 *  - an ISO-8601 INSTANT with its offset (`2026-10-06T00:00:00+03:00`, `…Z`):
 *    `from` is inclusive, `to` is EXCLUSIVE — the start of the next minute or
 *    day, so nothing in the last second of a range ever falls through a crack
 *    between `23:59:59.999` and microsecond timestamps;
 *  - a calendar DATE (`2026-10-06`), the form every caller sent before: a UTC
 *    day, inclusive at both ends — so `to` becomes the next UTC midnight.
 *
 * An instant without an offset is refused: its meaning would be the SERVER's
 * time zone, the exact ambiguity this replaces. `from` after `to` is a 400,
 * never a silently empty page.
 *
 * Applied with `withinRange`, which leaves the column BARE (`col >= $1 AND
 * col < $2`) so its `created_at` index range-scans; `col::date` casts every row
 * and no b-tree can serve it.
 */
export interface DateRange {
  /** Inclusive lower bound. */
  from?: Date;
  /** EXCLUSIVE upper bound. */
  until?: Date;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const DAY_MS = 86_400_000;

/** Either accepted shape, for a DTO's `@Matches` — the calendar is checked by `rangeBound`. */
export const DATE_OR_INSTANT =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

function refuse(field: string, sentence: string): never {
  throw new BadRequestException({
    code: 'VALIDATION_FAILED',
    message: [`${field} ${sentence}`],
    fields: { [field]: sentence },
  });
}

/** A UTC midnight from `YYYY-MM-DD`, or undefined when the day does not exist (`2026-02-31`). */
function utcDay(value: string): Date | undefined {
  const match = DATE_ONLY.exec(value);
  if (!match) return undefined;
  const [year, month, day] = [match[1], match[2], match[3]].map((part) =>
    Number.parseInt(part, 10),
  );
  const parsed = new Date(0);
  // setUTCFullYear, not Date.UTC: the latter maps years 0–99 onto 1900–1999.
  parsed.setUTCFullYear(year, month - 1, day);
  const real =
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day;
  return real ? parsed : undefined;
}

const SHAPE =
  'must be a date (YYYY-MM-DD) or a date-time with its offset (2026-10-06T08:30:00+03:00)';

/** One bound — `end` turns a calendar date into the start of the NEXT day. */
export function rangeBound(
  value: string | undefined,
  field: string,
  end: boolean,
): Date | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  const day = utcDay(raw);
  if (day) return end ? new Date(day.getTime() + DAY_MS) : day;
  if (DATE_ONLY.test(raw)) refuse(field, 'is not a real calendar date');
  if (!INSTANT.test(raw)) refuse(field, SHAPE);
  const instant = new Date(raw);
  // The calendar part must exist too — V8 rolls `2026-02-31T…` over to March.
  if (Number.isNaN(instant.getTime()) || !utcDay(raw.slice(0, 10))) {
    refuse(field, 'is not a real date-time');
  }
  return instant;
}

/** `?from=&to=` → `[from, until)`, or a 400 naming the field. */
export function dateRangeQuery(
  from: string | undefined,
  to: string | undefined,
  fields: { from: string; to: string } = { from: 'from', to: 'to' },
): DateRange {
  const range: DateRange = {
    from: rangeBound(from, fields.from, false),
    until: rangeBound(to, fields.to, true),
  };
  if (range.from && range.until && range.from.getTime() >= range.until.getTime()) {
    refuse(fields.to, `must be after ${fields.from}`);
  }
  return range;
}

/** The range as SQL conditions on a timestamptz column — sargable, half-open. */
export function withinRange(column: SQLWrapper, range: DateRange | undefined): SQL[] {
  const conditions: SQL[] = [];
  if (range?.from) conditions.push(sql`${column} >= ${range.from.toISOString()}::timestamptz`);
  if (range?.until) conditions.push(sql`${column} < ${range.until.toISOString()}::timestamptz`);
  return conditions;
}

/** True when both bounds (if any) sit on UTC midnights — what per-UTC-day totals can answer. */
export function isUtcDayAligned(range: DateRange): boolean {
  return [range.from, range.until].every((bound) => !bound || bound.getTime() % DAY_MS === 0);
}

/** A bound as the UTC calendar day it starts (`YYYY-MM-DD`). */
export function utcDate(bound: Date): string {
  return bound.toISOString().slice(0, 10);
}

/** Swagger for `?from=&to=` — one description on every list that takes a range. */
export function ApiDateRangeQueries(column = 'created'): MethodDecorator & ClassDecorator {
  return applyDecorators(
    ApiQuery({
      name: 'from',
      required: false,
      description: `Earliest ${column} time, inclusive: a date-time with offset (2026-10-06T00:00:00+03:00) or a date (YYYY-MM-DD, a UTC day).`,
    }),
    ApiQuery({
      name: 'to',
      required: false,
      description: `End of the period: a date-time with offset is EXCLUSIVE; a date (YYYY-MM-DD) includes that whole UTC day.`,
    }),
  );
}
