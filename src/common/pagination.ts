import { ValidationError } from './errors/domain-errors';

/**
 * Keyset ("cursor") pagination — PLATFORM-CONVENTIONS R-2.4.
 *
 * ADM-01 targets ~219,000 client records. Offset pagination fails there in two
 * ways, one slow and one WRONG, and the wrong one is the reason this exists:
 *
 *  - **Correctness.** Offset paging over a set that is being written to skips
 *    and duplicates rows. A client registers while an admin is on page 3; every
 *    later page shifts by one and one client is never seen. In a compliance
 *    review of a client base, "never seen" is the failure that matters, and it
 *    leaves no trace — the reviewer believes they looked at everyone.
 *
 *  - **Cost.** `OFFSET 200000` makes Postgres walk and discard 200,000 rows, and
 *    the `count(*)` alongside it scans the whole filtered set on EVERY page
 *    request. ARCHITECTURE §5 is right that 219K rows are trivial for Postgres —
 *    that is true of an indexed keyset seek, not of deep offset plus a full count.
 *
 * A keyset seek reads exactly `limit` rows regardless of depth, and cannot skip
 * or duplicate, because it asks "what comes after this row" rather than "how
 * many should I throw away".
 */

/** Rows per page. Capped so one caller cannot ask for the whole table. */
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

/**
 * The position a cursor encodes: the sort key of the last row returned.
 *
 * Always ends in a UNIQUE column (`id`), so the ordering is total. Without that
 * tiebreak, two rows sharing a `created_at` sit either side of a page boundary
 * in an order Postgres is free to change between queries — which reintroduces
 * exactly the skipping this replaces.
 */
export interface CursorPosition {
  createdAt: string;
  id: string;
}

/**
 * Cursors are OPAQUE to callers — base64 of a JSON pair.
 *
 * Opaque so the sort key can change without breaking a client that stored one.
 * Not encrypted and not signed: it carries a timestamp and a row id the caller
 * already has, so there is nothing to protect. It IS validated on the way back
 * in, because it lands in a WHERE clause.
 */
export function encodeCursor(position: CursorPosition): string {
  return Buffer.from(JSON.stringify(position), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): CursorPosition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new ValidationError('Malformed cursor. Omit it to start from the first page.');
  }

  const position = parsed as Partial<CursorPosition>;
  // Shape-checked, not trusted: a cursor is caller-supplied input on its way
  // into a query. The parameterised query is what prevents injection; this is
  // what prevents a confusing 500 from a well-formed base64 string of nonsense.
  if (typeof position?.createdAt !== 'string' || typeof position?.id !== 'string') {
    throw new ValidationError('Malformed cursor. Omit it to start from the first page.');
  }
  if (Number.isNaN(Date.parse(position.createdAt))) {
    throw new ValidationError('Malformed cursor. Omit it to start from the first page.');
  }

  return { createdAt: position.createdAt, id: position.id };
}

/** Clamps a caller-supplied limit into something the database can serve. */
export function pageSize(limit?: string | number): number {
  const raw = typeof limit === 'string' ? Number.parseInt(limit, 10) : limit;
  if (!raw || Number.isNaN(raw) || raw < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(raw, MAX_PAGE_SIZE);
}

export interface CursorPage<T> {
  items: T[];
  /** Pass back as `?cursor=` for the next page. `null` means this is the last. */
  nextCursor: string | null;
  /**
   * Present only when the caller asked for it (`?withTotal=true`).
   *
   * Counting is the expensive half — a full scan of the filtered set, on every
   * request, purely to render "of 219,000". Most screens need "is there more",
   * which `nextCursor !== null` answers for free.
   */
  total?: number;
}

/**
 * Builds the page from `limit + 1` rows.
 *
 * Fetching one extra row is how "is there a next page" is answered without a
 * second query and without a count: if the extra row came back, there is more.
 */
export function buildCursorPage<T extends { id: string; createdAt: Date }>(
  rows: T[],
  limit: number,
  total?: number,
): CursorPage<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];

  return {
    items,
    nextCursor:
      hasMore && last
        ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
        : null,
    ...(total === undefined ? {} : { total }),
  };
}
