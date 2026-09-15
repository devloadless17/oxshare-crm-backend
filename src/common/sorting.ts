import { asc, desc, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { ValidationError } from './errors/domain-errors';

/**
 * Server-side sort keys for the admin lists — R-2.5, generalised.
 *
 * `users.store.ts` established this shape for the client index: a CLOSED map
 * from a caller's string to a column object, and a validator that throws rather
 * than falling back. Six more lists then needed exactly the same two functions,
 * and six hand-written copies of "if the value is not in the allowlist, throw a
 * sentence naming the allowlist" is six chances for one of them to be written as
 * a silent fallback instead.
 *
 * So the pattern lives here once and each store declares only its own map,
 * `CLIENT_SORT_COLUMNS` included.
 *
 * ⚠️ This paragraph used to say the opposite — that `CLIENT_SORT_COLUMNS`
 * "deliberately keeps its own bespoke validator" because it "already had this
 * right", and that rewriting it would be churn. That was wrong, and the cost of
 * being wrong in a comment is that nobody re-reads the code it vouches for. The
 * copy gated on `value in allowed`, which walks the prototype chain, so
 * `?sort=constructor` passed a closed allowlist and 500'd the client list and
 * the CSV export. `hasOwnProperty` below is the difference, and the copy is now
 * a two-line delegation (`users.store.ts`). The lesson is the general one: a
 * duplicated guard is not "the same check twice", it is one check and one
 * unreviewed imitation of it.
 *
 * ── WHY AN ALLOWLIST AND NOT A COLUMN NAME FROM THE QUERY STRING ────────────
 *
 * A sort parameter interpolated into SQL is an injection point, and drizzle
 * 0.45's advisory (GHSA-gpj5-g38j-94v9) is specifically about improperly escaped
 * identifiers. This repo was only ever safe from that class because no dynamic
 * column name existed anywhere; adding sorting is the change that makes it
 * reachable. Every mapping below is therefore total and closed — a caller's
 * string either names a key that was compiled in, or it is refused.
 *
 * ── WHY IT MAY NOT EXCEED THE INDEXES ───────────────────────────────────────
 *
 * Every key needs a `(col, id)` composite or the ORDER BY degrades to a sort
 * over the whole filtered set on every page. Migration 0035 creates them and
 * `test/admin-sort-indexes.spec.ts` asserts the query PLANS, so adding a key
 * without an index fails a spec rather than making a screen quietly slow.
 */

export type SortOrder = 'asc' | 'desc';

/**
 * A caller's `?sort=` string, or a 400 naming what is allowed.
 *
 * NEVER a silent fallback to the default when the value is unrecognised. R-2.5:
 * "an unrecognised value is a 400, never a silent fallback — a silently ignored
 * sort is a lie the UI tells." The admin clicks a header, the rows come back in
 * the order they were already in, and there is nothing anywhere to explain why.
 *
 * An ABSENT value is a different thing entirely and takes the default: not
 * asking for a sort is not the same as asking for a bad one.
 *
 * @param subject what the list is OF, so the message reads as a sentence about
 *   the screen the admin is looking at rather than about a parameter.
 */
export function sortKey<T extends string>(
  value: string | undefined,
  allowed: Readonly<Record<T, unknown>>,
  fallback: T,
  subject: string,
): T {
  if (value === undefined || value === '') return fallback;
  if (Object.prototype.hasOwnProperty.call(allowed, value)) return value as T;
  throw new ValidationError(
    `Cannot sort ${subject} by "${value}". Allowed: ${Object.keys(allowed).join(', ')}.`,
  );
}

/**
 * `?order=`, defaulting to the direction the list already used.
 *
 * The default is a PARAMETER rather than always `desc`, because these lists do
 * not agree on one: a withdrawal queue and an audit trail read newest-first,
 * while an administrator directory and a role list read alphabetically. Pinning
 * `desc` here would silently reverse whichever lists default to ascending the
 * moment somebody omitted the argument.
 */
export function sortOrder(value: string | undefined, fallback: SortOrder = 'desc'): SortOrder {
  if (value === undefined || value === '') return fallback;
  if (value === 'asc' || value === 'desc') return value;
  throw new ValidationError(`Cannot order by "${value}". Allowed: asc, desc.`);
}

/**
 * The `ORDER BY` terms for an offset-paginated list: the sort key, then a unique
 * tiebreak, both in the same direction.
 *
 * ## The tiebreak is load-bearing, not decoration
 *
 * Every sortable column on these lists has ties by construction — a status has a
 * handful of values, two clients submit in the same second, two administrators
 * share a role. Rows sharing a sort value sit either side of an OFFSET boundary
 * in an order Postgres is explicitly free to change between queries, so page 2
 * can repeat a row from page 1 and omit another entirely. On a compliance queue
 * that is a submission nobody reviews, and the reviewer has no way to notice.
 *
 * ## Both keys in the SAME direction
 *
 * A b-tree can be read backwards only when EVERY column of the ORDER BY agrees,
 * so `(col DESC, key DESC)` serves DESC forwards and ASC backwards with no sort
 * node either way — which is the shape migration 0035 creates. A mixed
 * `col DESC, key ASC` would serve neither.
 *
 * ## `nullsLast` pins what Postgres otherwise decides by direction
 *
 * Postgres defaults to `NULLS LAST` for ASC and `NULLS FIRST` for DESC, so a
 * nullable sort column silently moves its empty rows from one end to the other
 * when the direction flips. For a column like `submitted_at` — null for every
 * application still being filled in — that means "oldest first" leads with rows
 * that were never submitted at all. Passing `nullsLast` puts them at the far end
 * in BOTH directions, so the two are mirrors and the top of the list is always
 * the rows a reviewer wants.
 */
export function orderTerms(
  column: SQLWrapper,
  tiebreak: SQLWrapper,
  direction: SortOrder,
  options: { nullsLast?: boolean } = {},
): SQL[] {
  const by = direction === 'asc' ? asc : desc;
  const primary = options.nullsLast ? sql`${by(column)} NULLS LAST` : by(column);
  return [primary, by(tiebreak)];
}
