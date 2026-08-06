import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MoneyTestContext, startMoneyTestDb, stopMoneyTestDb } from './money-setup';
import { closeDb, resetDb } from '../src/database/db';
import { users } from '../src/database/schema';
import { UsersStore } from '../src/store/users.store';
import {
  MAX_PAGE_SIZE,
  buildCursorPage,
  decodeCursor,
  encodeCursor,
  pageSize,
  type CursorPosition,
} from '../src/common/pagination';
import { ValidationError } from '../src/common/errors/domain-errors';

/**
 * PLATFORM-CONVENTIONS R-2.4 — keyset pagination for the ~219K client list.
 *
 * The headline reason is usually stated as performance, and that is the lesser
 * one. Offset paging over a set that is being WRITTEN TO skips rows: a client
 * registers while an admin is on page 3, every later page shifts by one, and one
 * client is never seen. In a compliance review of a client base that is the
 * failure that matters, and it leaves no trace — the reviewer believes they
 * looked at everyone.
 *
 * Testcontainers, because the guarantee is an index-ordered seek in SQL.
 */

let ctx: MoneyTestContext;
let store: UsersStore;

beforeAll(async () => {
  resetDb();
  ctx = await startMoneyTestDb();
  store = new UsersStore(ctx.db);
}, 180_000);

afterAll(async () => {
  await closeDb();
  await stopMoneyTestDb(ctx);
});

/** Inserts n clients with strictly increasing createdAt, newest last. */
async function seedClients(prefix: string, n: number) {
  const base = Date.UTC(2026, 0, 1);
  const rows = Array.from({ length: n }, (_, i) => ({
    email: `${prefix}-${String(i).padStart(3, '0')}@test.local`,
    passwordHash: 'x',
    firstName: 'P',
    lastName: String(i),
    createdAt: new Date(base + i * 1000),
  }));
  await ctx.db.insert(users).values(rows);
}

/** Walks every page with the cursor and returns the emails, in order. */
async function walkWithCursor(limit: number, filter: Record<string, unknown> = {}) {
  const seen: string[] = [];
  let cursor: string | undefined;

  for (let guard = 0; guard < 50; guard++) {
    const { rows } = await store.findPage({
      page: 1,
      limit,
      cursor: cursor ? decodeCursor(cursor) : undefined,
      ...filter,
    });
    const page = buildCursorPage(rows, limit);
    seen.push(...page.items.map((r) => r.email));
    if (!page.nextCursor) return seen;
    cursor = page.nextCursor;
  }
  throw new Error('Pagination did not terminate — nextCursor never became null.');
}

describe('R-2.4 keyset pagination', () => {
  it('walks the whole set exactly once, with no gaps and no repeats', async () => {
    await seedClients('walk', 25);

    const seen = await walkWithCursor(7);
    const unique = new Set(seen);

    expect(unique.size).toBe(seen.length); // no row returned twice
    expect(seen.length).toBeGreaterThanOrEqual(25);
  });

  it('does NOT skip a row when one is inserted mid-walk — the offset bug', async () => {
    /*
     * THE test. With OFFSET, inserting a row that sorts onto an earlier page
     * shifts everything after it: page 2 re-reads a row page 1 already showed,
     * and one row at the boundary is never returned at all.
     *
     * A keyset seek asks "what comes after this row", so an insert elsewhere in
     * the set cannot move the boundary it is reading from.
     */
    await seedClients('midwalk', 12);
    const limit = 5;

    const first = buildCursorPage(await pageOf(limit), limit);
    expect(first.nextCursor).not.toBeNull();

    // A new client registers between page reads. Ordering is newest-first, so
    // this lands on page ONE — exactly the insert that shifts an offset walk.
    await ctx.db.insert(users).values({
      email: 'midwalk-newcomer@test.local',
      passwordHash: 'x',
      firstName: 'New',
      lastName: 'Comer',
      createdAt: new Date(Date.UTC(2030, 0, 1)),
    });

    const second = buildCursorPage(
      await pageOf(limit, decodeCursor(first.nextCursor as string)),
      limit,
    );

    // The boundary held: nothing from page one reappears on page two.
    const overlap = second.items.filter((row) =>
      first.items.some((seen) => seen.email === row.email),
    );
    expect(overlap).toEqual([]);

    // And the row that offset would have skipped — the one that was last on
    // page 1's boundary — is not lost either.
    const walked = await walkWithCursor(limit);
    expect(new Set(walked).size).toBe(walked.length);
  });

  it('orders by a UNIQUE tiebreak, so identical timestamps cannot straddle a page', async () => {
    // Two clients registered in the same millisecond. Without the `id` tiebreak
    // their relative order is undefined and Postgres may return it differently
    // between two queries — which reintroduces the skipping this replaces.
    const sameInstant = new Date(Date.UTC(2029, 5, 5));
    await ctx.db.insert(users).values([
      {
        email: 'tie-a@test.local',
        passwordHash: 'x',
        firstName: 'T',
        lastName: 'A',
        createdAt: sameInstant,
      },
      {
        email: 'tie-b@test.local',
        passwordHash: 'x',
        firstName: 'T',
        lastName: 'B',
        createdAt: sameInstant,
      },
      {
        email: 'tie-c@test.local',
        passwordHash: 'x',
        firstName: 'T',
        lastName: 'C',
        createdAt: sameInstant,
      },
    ]);

    const walked = await walkWithCursor(2);
    const ties = walked.filter((e) => e.startsWith('tie-'));
    expect(new Set(ties).size).toBe(3);
  });

  it('does not count unless asked — counting is the expensive half', async () => {
    const withoutTotal = await store.findPage({ page: 1, limit: 5 });
    expect(withoutTotal.total).toBeUndefined();

    const withTotal = await store.findPage({ page: 1, limit: 5, withTotal: true });
    expect(withTotal.total).toBeGreaterThan(0);
  });

  it('reports the last page by returning no cursor, not by returning nothing', async () => {
    const all = await store.findPage({ page: 1, limit: MAX_PAGE_SIZE, withTotal: true });
    const page = buildCursorPage(all.rows, MAX_PAGE_SIZE, all.total);
    // Fewer rows than the limit means there is nothing after them.
    if (all.rows.length <= MAX_PAGE_SIZE) expect(page.nextCursor).toBeNull();
  });

  async function pageOf(limit: number, cursor?: CursorPosition) {
    const { rows } = await store.findPage({ page: 1, limit, cursor });
    return rows;
  }
});

describe('R-2.4 cursor encoding', () => {
  it('round-trips a position', () => {
    const position: CursorPosition = {
      sort: 'createdAt',
      value: '2026-08-04T10:00:00.000Z',
      id: 'a3f1c2d4-0000-4000-8000-000000000001',
    };
    expect(decodeCursor(encodeCursor(position))).toEqual(position);
  });

  it('refuses a malformed cursor with a usable message rather than a 500', () => {
    // A cursor is caller-supplied input on its way into a WHERE clause. The
    // parameterised query prevents injection; this prevents a confusing 500 from
    // a well-formed base64 string of nonsense.
    for (const bad of [
      'not-base64!!',
      Buffer.from('{}').toString('base64url'),
      Buffer.from('{"createdAt":"nope","id":"x"}').toString('base64url'),
      Buffer.from('{"sort":"createdAt","value":"nope","id":"x"}').toString('base64url'),
    ]) {
      expect(() => decodeCursor(bad)).toThrow(ValidationError);
    }
  });

  /**
   * A cursor is a POSITION IN AN ORDERING, so replaying one under a different
   * ordering is meaningless — and the failure is silent, which is what makes it
   * worth a hard refusal. The seek still runs, still returns `limit` rows, and
   * they are simply the wrong ones. On a client index used for compliance
   * review, "the wrong rows, confidently" is the failure mode that matters.
   *
   * R-2.5 makes the same point about sorting one page and calling it sorted:
   * a silently wrong answer is worse than an error.
   */
  it('refuses a cursor minted for a DIFFERENT sort, naming both', () => {
    const cursor = encodeCursor({ sort: 'createdAt', value: '2026-08-04T10:00:00.000Z', id: 'x' });

    expect(() => decodeCursor(cursor, 'email')).toThrow(ValidationError);
    expect(() => decodeCursor(cursor, 'email')).toThrow(/createdAt/);
    expect(() => decodeCursor(cursor, 'email')).toThrow(/email/);
  });

  it('accepts a cursor for the sort it was minted for', () => {
    const cursor = encodeCursor({ sort: 'email', value: 'zulu@example.com', id: 'x' });
    expect(decodeCursor(cursor, 'email').value).toBe('zulu@example.com');
  });

  it('accepts the LEGACY { createdAt, id } shape, so an open page survives deploy', () => {
    // An admin holding a pre-deploy cursor clicks Next. Rejecting it would be an
    // error they cannot act on, caused by a release they did not see.
    // Delete this, and the branch it covers, after one release.
    const legacy = Buffer.from(
      JSON.stringify({ createdAt: '2026-08-04T10:00:00.000Z', id: 'abc' }),
    ).toString('base64url');

    expect(decodeCursor(legacy)).toEqual({
      sort: 'createdAt',
      value: '2026-08-04T10:00:00.000Z',
      id: 'abc',
    });
  });

  it('stamps the sort key into the cursor it builds', () => {
    // Otherwise the refusal above can never fire: a cursor that does not say
    // which ordering it belongs to cannot be checked against one.
    const rows = [
      { id: 'a', createdAt: new Date('2026-01-01'), email: 'alpha@example.com' },
      { id: 'b', createdAt: new Date('2026-01-02'), email: 'bravo@example.com' },
    ];
    const page = buildCursorPage(rows, 1, undefined, 'email');

    expect(page.nextCursor).not.toBeNull();
    const decoded = decodeCursor(page.nextCursor as string, 'email');
    expect(decoded).toEqual({ sort: 'email', value: 'alpha@example.com', id: 'a' });
  });

  it('encodes a Date sort value as ISO-8601, not as a locale string', () => {
    // `String(date)` is second-resolution and locale-dependent, so it does not
    // round-trip through `timestamptz` — the seek would land on the wrong row
    // whenever two rows share a second (R-2.7).
    const rows = [
      { id: 'a', createdAt: new Date('2026-01-01T10:00:00.123Z') },
      { id: 'b', createdAt: new Date('2026-01-02T10:00:00.000Z') },
    ];
    const page = buildCursorPage(rows, 1);

    expect(decodeCursor(page.nextCursor as string).value).toBe('2026-01-01T10:00:00.123Z');
  });

  it('clamps the page size so one caller cannot ask for the whole table', () => {
    expect(pageSize('10000')).toBe(MAX_PAGE_SIZE);
    expect(pageSize('0')).toBeGreaterThan(0);
    expect(pageSize(undefined)).toBeGreaterThan(0);
    expect(pageSize('not-a-number')).toBeGreaterThan(0);
  });
});
