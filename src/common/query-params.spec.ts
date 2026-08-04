import { describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { MAX_SEARCH_LENGTH, enumQuery, searchQuery } from './query-params';
import {
  kycStatusEnum,
  transactionStateEnum,
  userStatusEnum,
  userTypeEnum,
} from '../database/schema';

/**
 * The global ValidationPipe covers `@Body()` because a DTO class exists for it
 * to reflect on. A bare `@Query('state') state?: string` has no metadata, so the
 * pipe passes it through untouched — which is why every request DTO in the repo
 * being a class made the body side look complete and hid that the other half of
 * caller-supplied input had no gate at all.
 */

describe('enum query parameters', () => {
  it('accepts every value the schema enum declares', () => {
    for (const value of transactionStateEnum.enumValues) {
      expect(enumQuery(value, transactionStateEnum.enumValues, 'state')).toBe(value);
    }
  });

  /**
   * The regression. `transactions.service.ts:175` did
   * `eq(transactions.state, filter.state as 'pending')` — a cast, which erases
   * at runtime — so `?state=nonsense` reached Postgres as a comparison against
   * a `transaction_state` enum column and came back as `invalid input value for
   * enum`. The caller saw a 500 and learned nothing; the log gained a database
   * error for what is ordinarily a typo.
   */
  it('rejects a value the enum does not declare, at the edge rather than in the database', () => {
    expect(() => enumQuery('nonsense', transactionStateEnum.enumValues, 'state')).toThrow(
      BadRequestException,
    );
  });

  it('names the field and lists the accepted values', () => {
    try {
      enumQuery('nonsense', userTypeEnum.enumValues, 'type');
      expect.unreachable('should have thrown');
    } catch (error) {
      const body = (error as BadRequestException).getResponse() as {
        code: string;
        fields: Record<string, string>;
      };
      // Same shape the rest of the API emits (R-2.2), so a client handles one
      // error contract rather than two.
      expect(body.code).toBe('VALIDATION_FAILED');
      expect(body.fields.type).toContain('individual');
    }
  });

  it('treats an absent or empty filter as no filter, not as invalid', () => {
    // Rejecting these would break every unfiltered list request.
    expect(enumQuery(undefined, userStatusEnum.enumValues, 'status')).toBeUndefined();
    expect(enumQuery('', userStatusEnum.enumValues, 'status')).toBeUndefined();
  });

  it('is case- and whitespace-exact', () => {
    // Postgres enum labels are exact. Accepting 'Pending' here would only move
    // the same failure one layer down.
    for (const candidate of ['Approved', ' approved', 'approved ']) {
      expect(() => enumQuery(candidate, kycStatusEnum.enumValues, 'status'), candidate).toThrow(
        BadRequestException,
      );
    }
  });

  /**
   * The allowlists are read off the Drizzle enums rather than retyped, so a
   * value added to the schema is accepted with no second edit. This asserts the
   * wiring, not the contents: hard-coding the expected members here would
   * recreate exactly the hand-copied list the design avoids.
   */
  it('derives its allowlist from the schema, so the two cannot drift', () => {
    expect(userTypeEnum.enumValues.length).toBeGreaterThan(0);
    for (const value of userTypeEnum.enumValues) {
      expect(enumQuery(value, userTypeEnum.enumValues, 'type')).toBe(value);
    }
  });
});

describe('search query parameters', () => {
  it('trims, and treats a blank term as absent', () => {
    expect(searchQuery('  ali  ')).toBe('ali');
    expect(searchQuery('   ')).toBeUndefined();
    expect(searchQuery(undefined)).toBeUndefined();
  });

  it('bounds the term, because it reaches a trigram predicate', () => {
    // Cheap to send, expensive for Postgres to answer.
    expect(searchQuery('a'.repeat(MAX_SEARCH_LENGTH))).toHaveLength(MAX_SEARCH_LENGTH);
    expect(() => searchQuery('a'.repeat(MAX_SEARCH_LENGTH + 1))).toThrow(BadRequestException);
  });
});
