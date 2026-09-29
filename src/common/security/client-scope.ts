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
  tagIds: readonly string[];
  /**
   * D-60 — this scoped actor also sees the INTAKE pool: clients with no tag
   * assignments at all. "Untriaged" is the derived state of carrying no tags
   * (deliberately not a tag — see the schema note on `admins.sees_untriaged`),
   * so the grant is a flag beside the territory list, not another tagId.
   * Meaningless when `unrestricted` is true. Optional so hand-built fixtures
   * stay valid; absent reads as false.
   */
  includesUntriaged?: boolean;
}

/**
 * Every client. What an administrator holding the explicit `sees_all_clients`
 * grant resolves to — never, since 0154, what an empty territory resolves to.
 */
export const UNRESTRICTED: ClientScope = Object.freeze({
  unrestricted: true,
  tagIds: [],
  includesUntriaged: false,
});

/**
 * The one resolution of an administrator's (or invite's, or key's) sight.
 *
 * TAGS RESTRICT, ONLY THE FLAG GRANTS (migration 0154):
 *
 *   territory tags present         → only those tags (+ new clients if granted)
 *   no tags,  seesAllClients       → every client
 *   no tags, !seesAllClients       → new clients only if granted, otherwise none
 *
 * An empty territory used to mean UNRESTRICTED (D-10), which made the widest
 * sight in the system the result of an absence: clearing an admin's last tag
 * silently promoted them to every client, and "new clients only" could not be
 * expressed. A row carrying tags is restricted whatever the flag says, so
 * nothing can widen by accident.
 *
 * Every argument is REQUIRED. A default that is right for one caller and wrong
 * for another is how the intake grant was once lost in two paths; the caller
 * holds the row, so the caller passes the flags.
 */
export function scopeOf(
  tagIds: readonly string[],
  includesUntriaged: boolean,
  seesAllClients: boolean,
): ClientScope {
  if (tagIds.length > 0) return { unrestricted: false, tagIds, includesUntriaged };
  return seesAllClients ? UNRESTRICTED : { unrestricted: false, tagIds: [], includesUntriaged };
}

/**
 * A SQL fragment true for exactly the clients this actor may see, or
 * `undefined` when they may see everything.
 *
 * Takes the COLUMN holding the client's id, so one helper serves `users.id`,
 * `kyc_submissions.user_id`, `transactions.user_id` and `wallets.user_id`.
 * That is what makes "apply the scope" a single call at each of the nine
 * surfaces rather than nine hand-written predicates that drift apart.
 *
 * Returning `undefined` rather than `sql\`true\`` is what lets every call site
 * read `and(...conditions, clientScopePredicate(scope, users.id))` with no
 * branch — Drizzle's `and` drops undefined. A branch at each call site is a
 * branch each call site can get backwards.
 *
 * `EXISTS`, not a join: a join multiplies rows the moment a client carries two
 * scoped tags, which would silently duplicate them in a paginated list and
 * corrupt the keyset seek. `EXISTS` short-circuits on the first match and reads
 * `client_tag_assignments_pkey` directly.
 *
 * Fully parameterised. Never string interpolation — the tag ids come from the
 * database rather than from a request, but a predicate that would be injectable
 * if its inputs ever changed source is a trap left for someone else.
 */
export function clientScopePredicate(
  scope: ClientScope,
  clientIdColumn: SQLWrapper,
): SQL | undefined {
  if (scope.unrestricted) return undefined;

  /*
   * D-60 — the intake branch: a client with NO tag assignments at all is in
   * the intake pool, and this actor has been granted sight of it. Derived, not
   * stored: "untriaged" cannot drift, cannot be deleted, and a client whose
   * last tag is removed RETURNS here rather than becoming invisible to every
   * scoped admin — the orphan class the materialised-tag design allowed.
   */
  const untriaged = scope.includesUntriaged
    ? sql`NOT EXISTS (
        SELECT 1 FROM ${clientTagAssignments} intake_a
        WHERE intake_a.user_id = ${clientIdColumn}
      )`
    : undefined;

  /*
   * No territory tags: the "new clients only" admin (intake granted) or the
   * admin who sees no clients at all — both real configurations since 0154.
   * (An empty `IN ()` would also be a SQL syntax error.)
   */
  if (scope.tagIds.length === 0) return untriaged ?? sql`false`;

  const territory = sql`EXISTS (
    SELECT 1 FROM ${clientTagAssignments} scope_a
    WHERE scope_a.user_id = ${clientIdColumn}
      AND scope_a.tag_id IN (${sql.join(
        scope.tagIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
  )`;

  return untriaged ? sql`(${territory} OR ${untriaged})` : territory;
}

/**
 * Would this actor see a client carrying exactly `tagIds`? The in-memory twin
 * of `clientScopePredicate`.
 *
 * It exists for the one question the SQL predicate cannot answer: a tag set
 * that is not stored yet. "If this tag is added or removed, does the client
 * stay in the actor's view?" has to be decided BEFORE the write, which is why
 * `AdminTagsService` asks it here rather than re-reading afterwards.
 *
 * Two definitions of visibility are a drift waiting to happen, so this one is
 * pinned to the other: `test/client-scope-twin.spec.ts` evaluates both over a
 * matrix of scopes and tag sets against real Postgres and fails on any
 * disagreement. Change one and that spec makes you change the other.
 */
export function seesClientWithTags(scope: ClientScope, tagIds: readonly string[]): boolean {
  if (scope.unrestricted) return true;
  // The intake branch: no assignments at all, and the grant to see them.
  if (tagIds.length === 0) return scope.includesUntriaged === true;
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
