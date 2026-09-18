import { describe, expect, it } from 'vitest';
import {
  CLIENT_TRANSACTION_SORT_COLUMNS,
  type ClientTransactionSortKey,
} from '../src/modules/payments/transactions.service';
import { TRANSACTION_SORT_FIELDS } from '../src/modules/payments/dto/transaction-query.dto';
import { sortKey, sortOrder } from '../src/common/sorting';
import { ValidationError } from '../src/common/errors/domain-errors';

/**
 * `GET /payments/transactions` resolves its sort through the SHARED guard.
 *
 * ## What this is defending
 *
 * The client's own money history was the last surface resolving a sort by hand:
 *
 *   const column = sortable[query.sort ?? 'createdAt'] ?? sortable.createdAt;
 *
 * Two faults in one line. A bracket lookup with no `hasOwnProperty` walks the
 * PROTOTYPE, so `constructor` resolves to `Object` — truthy, so the `??` never
 * fires and a function reaches a SQL fragment. That is the identical shape of
 * the bug `sorting.ts` and `users.store.ts` were written about after
 * `?sort=constructor` 500'd the client list and its CSV export. And the `??`
 * fallback is itself forbidden: R-2.5 requires an unrecognised sort to be a 400
 * naming the allowlist, because "a sort the server ignored is a lie the UI
 * tells".
 *
 * ## Why these are UNIT tests and not HTTP ones
 *
 * Because over HTTP nothing changed, and that is the point. `@IsIn` on the DTO
 * refuses `constructor` before the service is reached, so the route answered 400
 * before this fix and answers 400 after it. The DTO was the only thing holding
 * the door — a second guard standing in for the one that was missing — and a
 * test through the route would pass either way and prove nothing about the
 * lookup itself.
 *
 * So these call the resolution directly, which is where the hole was.
 */

describe('the client transaction sort cannot be walked off its allowlist', () => {
  it('REFUSES a prototype property, rather than resolving one', () => {
    /*
     * The exact input that broke the client list. Without `hasOwnProperty` this
     * returns `Object` and the caller interpolates a function into SQL.
     */
    expect(() =>
      sortKey('constructor', CLIENT_TRANSACTION_SORT_COLUMNS, 'createdAt', 'transactions'),
    ).toThrow(ValidationError);

    for (const inherited of ['toString', 'valueOf', '__proto__', 'hasOwnProperty']) {
      expect(() =>
        sortKey(inherited, CLIENT_TRANSACTION_SORT_COLUMNS, 'createdAt', 'transactions'),
      ).toThrow(ValidationError);
    }
  });

  it('REFUSES an unknown key instead of silently sorting by createdAt', () => {
    // The `??` fallback this replaces. A caller who asked for `?sort=amont` got
    // a list ordered by date and no indication their filter was discarded.
    expect(() =>
      sortKey('amont', CLIENT_TRANSACTION_SORT_COLUMNS, 'createdAt', 'transactions'),
    ).toThrow(/amont/);
  });

  it('REFUSES an unknown order instead of silently meaning DESC', () => {
    // `query.order === 'asc' ? ASC : DESC` accepted anything and meant DESC.
    expect(() => sortOrder('sideways')).toThrow(ValidationError);
    expect(sortOrder(undefined)).toBe('desc');
    expect(sortOrder('asc')).toBe('asc');
  });

  it('accepts every key it advertises, so the guard is not simply closed', () => {
    // The other direction: a guard that refused everything would pass all three
    // assertions above while breaking every sort the portal offers.
    for (const key of TRANSACTION_SORT_FIELDS) {
      expect(sortKey(key, CLIENT_TRANSACTION_SORT_COLUMNS, 'createdAt', 'transactions')).toBe(key);
    }
  });

  it('keeps the DTO enum and the column map in step', () => {
    /*
     * The remaining way these can disagree, and the reason the map is exported
     * rather than inline. `TRANSACTION_SORT_FIELDS` is what the DTO validates
     * and what OpenAPI publishes to both frontends; the map is what the query
     * resolves. A key in one and not the other is either a sort the API
     * advertises and refuses, or one it accepts and never documents.
     */
    expect([...TRANSACTION_SORT_FIELDS].sort()).toEqual(
      Object.keys(CLIENT_TRANSACTION_SORT_COLUMNS).sort(),
    );
  });

  it('types the key from the map, so a stray field cannot compile', () => {
    // A compile-time assertion written as a runtime one: if the union ever stops
    // covering the advertised fields, this stops type-checking.
    const key: ClientTransactionSortKey = 'amount';
    expect(CLIENT_TRANSACTION_SORT_COLUMNS[key]).toBeDefined();
  });
});
