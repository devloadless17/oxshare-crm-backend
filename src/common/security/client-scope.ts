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
  /**
   * True when this actor sees every client: a master admin, or an admin with no
   * scope rows at all.
   */
  unrestricted: boolean;
  tagIds: readonly string[];
}

/**
 * The default, and it is DELIBERATELY PERMISSIVE.
 *
 * An empty scope means unrestricted, following RBAC-08's empty allowlist and
 * DECISIONS D-10 for the same reason: the deploy that introduces this feature
 * must not blind every existing sub-admin before anyone has had a chance to
 * assign a territory. Enforcement begins when somebody says who belongs where.
 *
 * The cost of that choice is a real window at invite time, which is why
 * `admin_invites.scoped_tag_ids` exists — see the schema comment.
 */
export const UNRESTRICTED: ClientScope = Object.freeze({ unrestricted: true, tagIds: [] });

export function scopeOf(tagIds: readonly string[]): ClientScope {
  return tagIds.length === 0 ? UNRESTRICTED : { unrestricted: false, tagIds };
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
   * Unreachable: `scopeOf` maps an empty list to UNRESTRICTED, so a restricted
   * scope always has at least one tag. It is here because if that ever stops
   * being true, this must FAIL CLOSED. An empty `IN ()` is a SQL syntax error
   * and an omitted predicate would show every client — of the two ways to be
   * wrong, showing nothing is the recoverable one.
   */
  if (scope.tagIds.length === 0) return sql`false`;

  return sql`EXISTS (
    SELECT 1 FROM ${clientTagAssignments} scope_a
    WHERE scope_a.user_id = ${clientIdColumn}
      AND scope_a.tag_id IN (${sql.join(
        scope.tagIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
  )`;
}
