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

/** The sort column every list defaults to, and the only one most of them offer. */
export const DEFAULT_SORT_KEY = 'createdAt';

/**
 * The position a cursor encodes: the sort key of the last row returned.
 *
 * Always ends in a UNIQUE column (`id`), so the ordering is total. Without that
 * tiebreak, two rows sharing a sort value sit either side of a page boundary in
 * an order Postgres is free to change between queries — which reintroduces
 * exactly the skipping this replaces.
 *
 * `sort` names the column the cursor was minted for, and that is not
 * bookkeeping. A cursor is a POSITION IN AN ORDERING; replayed against a
 * different ordering it is meaningless, and the failure is silent — the seek
 * still runs, still returns `limit` rows, and they are the wrong ones. Carrying
 * the key lets `decodeCursor` refuse it with a sentence instead. (The admin UI
 * also resets paging when the sort changes; this is the half that does not
 * depend on a frontend remembering to.)
 */
export interface CursorPosition {
  sort: string;
  /** The sort column's value on the last row, as a string. */
  value: string;
  id: string;
}

/**
 * Cursors are OPAQUE to callers — base64 of a small JSON object.
 *
 * Opaque so the sort key can change without breaking a client that stored one.
 * Not encrypted and not signed: it carries a value and a row id the caller
 * already has, so there is nothing to protect. It IS validated on the way back
 * in, because it lands in a WHERE clause.
 */
/** What a cursor's `value` will be cast to by the seek that consumes it. */
export type CursorValueShape = 'timestamptz' | 'numeric' | 'text';

/**
 * The row id a seek casts the cursor's `id` to — `uuid` for every list except
 * the clients list, whose rows are keyed by the Portal ID (0159). Checked
 * here, so a cursor of the wrong shape is a 400 and never a failed cast.
 */
export type CursorIdShape = 'uuid' | 'integer';
const CURSOR_ID_SHAPES: Record<CursorIdShape, RegExp> = {
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  integer: /^[1-9][0-9]{0,9}$/,
};

/** A decimal a `::numeric` cast will accept, sign and fraction included. */
const NUMERIC_SHAPE = /^-?\d+(\.\d+)?$/;

export function encodeCursor(position: CursorPosition): string {
  return Buffer.from(JSON.stringify(position), 'utf8').toString('base64url');
}

/**
 * @param expectedSort the sort key the current request is using. A cursor
 *   minted under a different ordering is REFUSED rather than silently
 *   misinterpreted — see `CursorPosition.sort`.
 */
export function decodeCursor(
  cursor: string,
  expectedSort: string = DEFAULT_SORT_KEY,
  /**
   * The cast the caller's seek will apply to `value`, when it knows it.
   *
   * Omitted means "check what can be checked without it" — the id always, and
   * the value when the sort is the default timestamp one.
   */
  valueShape?: CursorValueShape,
  idShape: CursorIdShape = 'uuid',
): CursorPosition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new ValidationError('Malformed cursor. Omit it to start from the first page.');
  }

  // Shape-checked, not trusted: a cursor is caller-supplied input on its way
  // into a query. The parameterised query is what prevents injection; this is
  // what prevents a confusing 500 from a well-formed base64 string of nonsense.
  const position = parsed as Partial<CursorPosition> & { createdAt?: unknown };

  /*
   * LEGACY SHAPE, accepted for one release.
   *
   * Cursors used to be `{ createdAt, id }`, from before any list could be
   * sorted by anything else. An admin with a list page open across the deploy
   * holds one of those, and rejecting it would turn "click Next" into an error
   * for a reason nobody could act on. Normalising it costs three lines.
   *
   * Delete this branch once a release has passed — a shim that stays becomes a
   * second cursor format nobody remembers is still supported.
   */
  if (position.sort === undefined && typeof position.createdAt === 'string') {
    position.sort = DEFAULT_SORT_KEY;
    position.value = position.createdAt;
  }

  if (
    typeof position?.sort !== 'string' ||
    typeof position?.value !== 'string' ||
    typeof position?.id !== 'string'
  ) {
    throw new ValidationError('Malformed cursor. Omit it to start from the first page.');
  }

  if (position.sort !== expectedSort) {
    throw new ValidationError(
      `This cursor was created for a list sorted by "${position.sort}", but this request ` +
        `sorts by "${expectedSort}". Start from the first page when you change the sort.`,
    );
  }

  /*
   * The ROW ID, shape-checked for every sort — not only for the default one.
   *
   * ⚠️ The paragraph below used to open "Timestamps are the one value with a
   * shape worth checking", and that was the whole of it: `id` was never checked
   * at all, though every keyset seek emits `${cursor.id}::uuid`.
   *
   * ⚠️ AND THE OBVIOUS REASON TO FIX IT WAS WRONG. A tampered cursor was never a
   * 500: `AllExceptionsFilter` maps Postgres `22P02` to a 400, deliberately and
   * for this exact class. Verified by removing these two checks and watching the
   * route keep answering 400.
   *
   * What the cast error cannot do is SAY WHAT IS WRONG. "A value in the request
   * is not a valid identifier" gives a caller holding a stale cursor nothing to
   * act on, where "Malformed cursor. Omit it to start from the first page."
   * names the remedy. The check also keeps a caller-supplied value from
   * reaching the database at all, which is where it belonged anyway.
   *
   * It lives here rather than at the seeks because there are seven of those and
   * one of this. `transactions.service.ts` already validated both halves in its
   * own `cursorSeek`; the other six inherited nothing, which is the shape of gap
   * a shared decoder exists to close.
   */
  if (!CURSOR_ID_SHAPES[idShape].test(position.id)) {
    throw new ValidationError('Malformed cursor. Omit it to start from the first page.');
  }

  /*
   * And the VALUE, where the caller has told us what it should look like.
   *
   * `valueShape` is optional because the decoder cannot infer it: the same
   * function serves lists sorted by timestamp, by numeric balance and by text.
   * A caller that knows the cast its seek will apply passes it, and a tampered
   * cursor is then refused by a message about CURSORS rather than by a generic
   * one about identifiers. The `createdAt` default below is the case that was
   * already covered.
   */
  const shape = valueShape ?? (position.sort === DEFAULT_SORT_KEY ? 'timestamptz' : undefined);
  if (shape === 'timestamptz' && Number.isNaN(Date.parse(position.value))) {
    throw new ValidationError('Malformed cursor. Omit it to start from the first page.');
  }
  if (shape === 'numeric' && !NUMERIC_SHAPE.test(position.value)) {
    throw new ValidationError('Malformed cursor. Omit it to start from the first page.');
  }

  return { sort: position.sort, value: position.value, id: position.id };
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
 * How a row's sort value becomes the string a cursor carries.
 *
 * Dates go to ISO-8601 (R-2.7) rather than `String(date)`, which would produce
 * a locale-dependent, second-resolution string that no longer round-trips
 * through `timestamptz`. Null sorts last in Postgres' default DESC ordering and
 * has no seek value, so it becomes an empty string and the tiebreak on `id`
 * carries the page — correct, and the reason a nullable column may only be
 * sortable if the query pins its null ordering explicitly.
 */
function cursorValueOf(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  /*
   * Anything else is a programming error, and it must be LOUD.
   *
   * A bare `String(value)` here would turn an object into the literal
   * '[object Object]', mint a perfectly valid-looking cursor from it, and page
   * two of that list would seek to a position that matches nothing or matches
   * everything. Nothing would error; the admin would simply be shown the wrong
   * rows. Sort columns are scalars by construction — a jsonb column reaching
   * here means the SORTABLE_COLUMNS allowlist admitted something it should not.
   */
  throw new ValidationError(
    `Cannot paginate by a non-scalar sort value (received ${typeof value}). ` +
      'Sortable columns must be text, numeric, boolean or a timestamp.',
  );
}

/**
 * Builds the page from `limit + 1` rows.
 *
 * Fetching one extra row is how "is there a next page" is answered without a
 * second query and without a count: if the extra row came back, there is more.
 *
 * @param sort the column the query ordered by, stamped into the cursor so it
 *   cannot be replayed under a different ordering. Defaults to `createdAt`,
 *   which is what every list but the client index uses.
 */
/*
 * `createdAt` may be a Date OR the raw timestamptz literal. The raw string is
 * the more precise choice where the caller has it: a JS Date holds
 * milliseconds while the column stores microseconds, and a cursor minted from
 * the truncated value seeks past every row sharing the boundary row's
 * millisecond — rows silently skipped, the exact failure this module exists
 * to prevent. `cursorValueOf` passes a string through verbatim, and
 * `::timestamptz` restores full precision on the way back in.
 */
export function buildCursorPage<T extends { id: string | number; createdAt: Date | string }>(
  rows: T[],
  limit: number,
  total?: number,
  sort: string = DEFAULT_SORT_KEY,
): CursorPage<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];

  return {
    // `cursorValue` is a SEEK artefact, never part of the response shape —
    // `response-completeness.spec.ts` refuses a key the DTO does not declare,
    // and it would be right to.
    items: items.map((row) => stripCursorValue(row)),
    nextCursor:
      hasMore && last
        ? encodeCursor({
            sort,
            value: fullPrecisionValue(
              /*
               * ⚠️ THE RAW STRING FIRST, and the paragraph above is why it has
               * to exist at all.
               *
               * `node-postgres` hands back a `timestamptz` as a JS Date, which
               * holds MILLISECONDS while the column holds MICROSECONDS. A cursor
               * minted from `Date.toISOString()` is therefore truncated DOWN, and
               * the row comparison `(created_at, id) < (value, id)` then excludes
               * the boundary row AND every row sharing its millisecond.
               *
               * Measured before this fix: a page of 200 rows written by one bulk
               * INSERT — so all sharing a microsecond — paged to the SECOND page
               * and got back ZERO rows and `nextCursor: null`. The reader is told
               * the list has ended. On the audit log, which writes many rows a
               * second under load and whose whole value is completeness, that is
               * a gap in a record people believe.
               *
               * So each paging query now selects the sort value AS TEXT beside
               * the row, and `cursorValueOf` passes a string through verbatim.
               * `::timestamptz` on the way back in restores it exactly. The
               * fallback keeps a caller that has not been updated working at
               * millisecond precision rather than not at all.
               */
              (last as Record<string, unknown>)['cursorValue'],
              (last as Record<string, unknown>)[sort],
              sort,
            ),
            id: String(last.id),
          })
        : null,
    ...(total === undefined ? {} : { total }),
  };
}

/**
 * The sort value, REFUSING a truncated one rather than minting it.
 *
 * ## Why this throws instead of coping
 *
 * `node-postgres` returns a `timestamptz` as a JS `Date`, which holds
 * milliseconds; the column holds microseconds. A cursor minted from the Date is
 * therefore truncated DOWN, and the next page's `< boundary` seek excludes the
 * boundary row and every row sharing its millisecond. Nothing errors. The
 * reader is simply shown fewer rows, or none at all, and told the list ended.
 *
 * That defect sat in SEVEN of the eight call sites, under a module header that
 * described it exactly — and fixing four of them looked precisely like fixing
 * all of them. A source-text census could not tell them apart either: the
 * clients list supplies its raw value from `users.store.ts`, two files away
 * from the call.
 *
 * So the check lives where the information is. If the row carries no
 * `cursorValue` and the sort value is a Date, the cursor CANNOT be correct, and
 * this says so at the call site instead of shipping a page that quietly skips
 * rows. A silent no-op is worse than a failure — the rule this repo already
 * applies to invalidation keys, to unrecognised sorts and to the ledger's
 * append-only trigger.
 *
 * The fix at a call site is one line: select the sort column as text beside the
 * row, named `cursorValue`. `buildCursorPage` strips it before the row becomes
 * a response.
 */
function fullPrecisionValue(raw: unknown, sortValue: unknown, sort: string): string {
  if (raw !== undefined && raw !== null) return cursorValueOf(raw);

  if (sortValue instanceof Date) {
    throw new Error(
      `Cannot mint a keyset cursor for '${sort}' from a Date: it holds milliseconds and the ` +
        'column holds microseconds, so the next page would skip every row sharing the ' +
        "boundary row's millisecond. Select the sort column as text beside the row " +
        '(`cursorValue: sql<string>`${sortColumn}::text``) — see pagination.ts.',
    );
  }
  return cursorValueOf(sortValue);
}

/** Drop the seek artefact before the row becomes a response. */
function stripCursorValue<T>(row: T): T {
  if (!row || typeof row !== 'object' || !('cursorValue' in row)) return row;
  const { cursorValue: _cursorValue, ...rest } = row as Record<string, unknown>;
  return rest as T;
}
