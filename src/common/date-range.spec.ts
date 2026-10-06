import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { PgDialect } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { dateRangeQuery, isUtcDayAligned, rangeBound, withinRange } from './date-range';

/**
 * The period every list filters by. A wrong bound hides a money row without a
 * trace, so both accepted shapes and every refusal are pinned.
 */
describe('dateRangeQuery', () => {
  it('a date is a UTC day, `to` inclusive of that whole day', () => {
    expect(dateRangeQuery('2026-10-01', '2026-10-06')).toEqual({
      from: new Date('2026-10-01T00:00:00Z'),
      until: new Date('2026-10-07T00:00:00Z'),
    });
  });

  it('an instant keeps its offset, and `to` is EXCLUSIVE', () => {
    expect(dateRangeQuery('2026-10-06T00:00:00+03:00', '2026-10-07T00:00:00+03:00')).toEqual({
      from: new Date('2026-10-05T21:00:00Z'),
      until: new Date('2026-10-06T21:00:00Z'),
    });
  });

  it('either bound alone is a half-open period; neither is none', () => {
    expect(dateRangeQuery('2026-10-01', undefined).until).toBeUndefined();
    expect(dateRangeQuery(undefined, '2026-10-01').from).toBeUndefined();
    expect(dateRangeQuery(undefined, ' ')).toEqual({ from: undefined, until: undefined });
  });

  it.each([
    ['2026-02-31', 'an impossible day'],
    ['2026-10-06T08:00', 'an instant WITHOUT its offset — the server would guess the zone'],
    ['2026-02-31T08:00:00Z', 'an impossible day inside an instant (V8 rolls it over)'],
    ['yesterday', 'words'],
    ['2026-10-06; DROP TABLE users', 'anything else'],
  ])('refuses %s (%s) with a 400 naming the field', (value) => {
    expect(() => rangeBound(value, 'from', false)).toThrow(BadRequestException);
  });

  it('refuses a period that ends before it starts', () => {
    expect(() => dateRangeQuery('2026-10-06', '2026-10-05')).toThrow(BadRequestException);
    expect(() => dateRangeQuery('2026-10-06T10:00:00Z', '2026-10-06T10:00:00Z')).toThrow(
      BadRequestException,
    );
  });

  it('knows which periods the per-UTC-day totals can answer', () => {
    expect(isUtcDayAligned(dateRangeQuery('2026-10-01', '2026-10-06'))).toBe(true);
    expect(isUtcDayAligned(dateRangeQuery('2026-10-06T00:00:00+03:00', undefined))).toBe(false);
  });
});

describe('withinRange', () => {
  it('leaves the column BARE (sargable), half-open', () => {
    const query = new PgDialect().sqlToQuery(
      sql.join(
        withinRange(sql`t.created_at`, dateRangeQuery('2026-10-01', '2026-10-01')),
        sql` AND `,
      ),
    );
    expect(query.sql).toBe('t.created_at >= $1::timestamptz AND t.created_at < $2::timestamptz');
    expect(query.params).toEqual(['2026-10-01T00:00:00.000Z', '2026-10-02T00:00:00.000Z']);
  });
});
