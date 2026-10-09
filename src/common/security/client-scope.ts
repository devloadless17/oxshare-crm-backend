import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { clientTagAssignments } from '../../database/schema';

/**
 * Row-level client visibility: which clients an administrator may see at all.
 *
 * FSD §7 and §8 and ARCHITECTURE §8.8 all place record-level client visibility
 * out of scope for Phase 1. This was built anyway, on an explicit decision —
 * see DECISIONS. It is recorded here rather than left to be rediscovered,
 * because the next person to read §8.8 will otherwise assume this file is a
 * mistake and delete it.
 *
 * ── The one rule that must not be softened ──────────────────────────────────
 *
 * The predicate goes in the WHERE CLAUSE. Never fetch-then-filter.
 *
 * A filter applied after the rows are loaded is one a later code path can
 * forget — a new export endpoint, a count, a join, a `findById` reached from
 * somewhere unexpected — and forgetting it shows a scoped administrator client
 * data they are not entitled to, silently and with no error anywhere. A
 * predicate in the query cannot be forgotten by code that does not exist yet,
 * because that code has to go through the same store method to get any rows at
 * all. PLATFORM-CONVENTIONS R-4.4 says the same thing about IB ownership.
 *
 * It also gives the right STATUS CODE for free. Because out-of-scope rows never
 * come back, `findClientForAdmin` returns undefined and the existing
 * `NotFoundError` fires: a scoped admin gets 404, not 403. A 403 would be an
 * oracle — try uuids, and the difference between "no such client" and "not
 * yours" enumerates the client base you were specifically denied.
 */

export interface ClientScope {
  /** True when this actor sees every client — the explicit grant (0154). */
  unrestricted: boolean;
  /**
   * The territory: a client carrying ANY of these tags is visible. A tag is an
   * owner's book ("O_F") or a desk — whoever is responsible for the client.
   */
  tagIds: readonly string[];
}

/**
 * Every client. What an administrator holding the explicit `sees_all_clients`
 * grant resolves to — never, since 0154, what an empty territory resolves to.
 */
export const UNRESTRICTED: ClientScope = Object.freeze({ unrestricted: true, tagIds: [] });

/**
 * The one resolution of an administrator's (or invite's, or key's) sight.
 *
 * TAGS RESTRICT, ONLY THE FLAG GRANTS (migration 0154):
 *
 *   territory tags present         → only clients carrying one of those tags
 *   no tags,  seesAllClients       → every client
 *   no tags, !seesAllClients       → no client
 *
 * An empty territory used to mean UNRESTRICTED (D-10), which made the widest
 * sight in the system the result of an absence. A row carrying tags is
 * restricted whatever the flag says, so nothing can widen by accident.
 *
 * D-60's intake grant ("also sees clients with no tag") is gone since 0193. A
 * client nobody's book holds yet is seen by the administrators who see every
 * client, who give them an owner (bulk "Add tags").
 *
 * Both arguments are REQUIRED: the caller holds the row, so the caller passes
 * the flag. A default right for one caller and wrong for another is how a grant
 * was once lost in two paths.
 */
export function scopeOf(tagIds: readonly string[], seesAllClients: boolean): ClientScope {
  if (tagIds.length > 0) return { unrestricted: false, tagIds };
  return seesAllClients ? UNRESTRICTED : { unrestricted: false, tagIds: [] };
}

/**
 * A SQL fragment true for exactly the clients this actor may see, or
 * `undefined` when they may see everything.
 *
 * Takes the COLUMN holding the client's id, so one helper serves `users.id`,
 * `kyc_submissions.user_id`, `transactions.user_id` and `wallets.user_id`.
 * That is what makes "apply the scope" a single call at each surface rather
 * than hand-written predicates that drift apart.
 *
 * Returning `undefined` rather than `sql\`true\`` is what lets every call site
 * read `and(...conditions, clientScopePredicate(scope, users.id))` with no
 * branch — Drizzle's `and` drops undefined.
 *
 * `EXISTS`, not a join: a join multiplies rows the moment a client carries two
 * scoped tags, which would silently duplicate them in a paginated list and
 * corrupt the keyset seek.
 *
 * It reads `client_tag_assignments` through its primary key (user, tag): one
 * index probe per row. (Country tags, which 0193 derived through a view, were
 * removed in 0213.)
 *
 * Fully parameterised. Never string interpolation.
 */
export function clientScopePredicate(
  scope: ClientScope,
  clientIdColumn: SQLWrapper,
): SQL | undefined {
  if (scope.unrestricted) return undefined;
  // No territory and no grant: sees no client. (An empty `IN ()` would also
  // be a SQL syntax error.)
  if (scope.tagIds.length === 0) return sql`false`;

  const tagList = sql.join(
    scope.tagIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  return sql`EXISTS (
    SELECT 1 FROM ${clientTagAssignments} scope_m
    WHERE scope_m.user_id = ${clientIdColumn}
      AND scope_m.tag_id IN (${tagList})
  )`;
}

/**
 * Would this actor see a client carrying exactly `tagIds`? The in-memory twin
 * of `clientScopePredicate`.
 *
 * `tagIds` are the client's tags (`ClientTagsStore.tagIdsForClient`).
 *
 * It exists for the one question the SQL predicate cannot answer: a tag set
 * that is not stored yet ("if this tag is removed, does the client stay in the
 * actor's view?"). `test/client-scope-twin.spec.ts` pins it to the SQL.
 */
export function seesClientWithTags(scope: ClientScope, tagIds: readonly string[]): boolean {
  if (scope.unrestricted) return true;
  return tagIds.some((tagId) => scope.tagIds.includes(tagId));
}

/**
 * A set that may cross the reader's territory, counted in ONE aggregate: how
 * many of its clients the reader may see, and how many they may not — a count,
 * never who (D-81 R2, "a count, no identity").
 *
 * For the configuration screens that count people per setting — clients per
 * tag, partners per IB level, accounts per MT5 group. A total alone either
 * describes rows the reader cannot see or, narrowed, reads as the whole story:
 * "12 partners on this level" to a desk that cannot see the other 30 is how a
 * disable gets refused with no visible reason. Both halves come from the same
 * predicate the lists use, so the split can never disagree with them.
 *
 * `clientId` is the column (or expression) naming the client a row belongs to;
 * `count()` skips NULLs, so a LEFT JOIN row with no client counts in neither.
 * An unrestricted reader has nothing outside: `outside` is a constant 0.
 */
export function territoryCounts(
  scope: ClientScope,
  clientId: SQLWrapper,
): { inScope: SQL<number>; outside: SQL<number> } {
  const visible = clientScopePredicate(scope, clientId);
  if (!visible) {
    return { inScope: sql<number>`count(${clientId})::int`, outside: sql<number>`0` };
  }
  return {
    inScope: sql<number>`(count(${clientId}) FILTER (WHERE ${visible}))::int`,
    outside: sql<number>`(count(${clientId}) FILTER (WHERE NOT (${visible})))::int`,
  };
}

/**
 * A count said in a sentence, split when it crosses the reader's territory:
 * `3 partners`, or `3 partners (1 in your territory, 2 outside it)`.
 *
 * The refusals on the configuration screens quote it, so a scoped desk told
 * "partners stand on this level" learns why it cannot finish alone — never who.
 */
export function describeAcrossTerritory(
  count: { inScope: number; outside: number },
  one: string,
  many: string,
): string {
  const total = count.inScope + count.outside;
  const noun = total === 1 ? one : many;
  return count.outside === 0
    ? `${total} ${noun}`
    : `${total} ${noun} (${count.inScope} in your territory, ${count.outside} outside it)`;
}

/**
 * What a refusal adds when part of the set is outside the reader's territory:
 * they cannot finish it alone, and saying so is the difference between a
 * refusal and a dead end. Empty when nothing is outside.
 */
export function outsideTerritoryRemedy(outside: number): string {
  if (outside === 0) return '';
  return outside === 1
    ? ' The one outside your territory needs an administrator who can see it.'
    : ` The ${outside} outside your territory need an administrator who can see them.`;
}
