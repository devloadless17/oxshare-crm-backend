import permissionsCatalog from '../../config/permissions.json';
import { AuthorizationError } from '../errors/domain-errors';

/**
 * Who is performing an action, as the SERVICE layer sees it.
 *
 * PLATFORM-CONVENTIONS R-4.3. Authorization currently lives entirely in guards,
 * and guards only run on HTTP requests. BullMQ is coming (ARCHITECTURE §9): the
 * confirm job, the deal sweep, mail. The moment an admin action is queued
 * instead of executed inline, every guard-only check silently stops running —
 * and nothing fails, which is what makes it dangerous.
 *
 * So the check moves to where the decision is made. The guard stays as a fast
 * reject at the edge; the service asserts because the service is what a job
 * calls.
 *
 * Doing this now is nearly free — every money-moving method already receives an
 * `actor`, because it needed one for the audit log. Doing it after the queues
 * land means auditing every service method with no way to prove completeness.
 */
export interface Actor {
  id: string;
  email: string;
  permissions: string[];
}

/**
 * Every key the catalog defines, read from the file the API itself serves.
 *
 * Not a hand-written list: a permission added to `permissions.json` has to
 * reach the system identity below without anybody remembering a second place,
 * or the next background job to need it fails authorization in production with
 * a message about a permission nobody knew it required.
 */
export const CATALOG_KEYS: string[] = Object.values(
  permissionsCatalog as Record<string, { permissions: { key: string }[] }>,
).flatMap((module) => module.permissions.map((entry) => entry.key));

/**
 * The identity a background job acts under.
 *
 * Explicit and auditable, never an implicit "trusted because internal". A job
 * that runs as nobody produces audit rows that say nobody did it, and a
 * permission model with an unnamed bypass is a permission model with a hole.
 *
 * ── It held `['*']`, and the wildcard branch below was deleted ─────────────
 *
 * The two changes did not land together. `assertPermission` stopped honouring
 * `*` when the permission model was rebuilt, and this constant kept it — with a
 * comment explaining why the wildcard was safe HERE, which stayed true about
 * the identity and stopped being true about the mechanism.
 *
 * The result was total and silent: every background path that asserts a
 * permission began refusing itself. Marking a withdrawal failed, the confirm
 * job, the deal sweep — each raising "system@oxshare.internal cannot … : the
 * withdrawals.settle permission is required" about an identity that is supposed
 * to be able to do everything.
 *
 * Enumerating the catalog is what the wildcard was standing in for, and it is
 * strictly better: this identity cannot log in — no password, no session, no
 * token is ever minted for it — so it is reachable only from code already
 * running inside the process, and it now holds a list somebody can read.
 */
export const SYSTEM_ACTOR: Actor = {
  id: '00000000-0000-0000-0000-000000000000',
  email: 'system@oxshare.internal',
  permissions: CATALOG_KEYS,
};

/**
 * The one spelling of a permission key: lower-case, dot-separated, exactly as
 * `config/permissions.json` declares it.
 *
 * Exported so that everything deciding an authorization question shares this
 * definition rather than writing its own. That is not tidiness — it is the
 * whole point. Two spellings (`kyc:review` and `kyc.review`) were alive since
 * RBAC was built, bridged by four separate `replace(/:/g, '.')` shims, and the
 * shims were generative: `assertGrantable` normalised BEFORE checking the
 * catalog, so the colon form passed validation and was stored verbatim. The
 * system kept manufacturing the inconsistency it was compensating for.
 *
 * Migration 0009 converted the stored keys and the shims came out — but this
 * file was written afterwards and put one back, while its comment claimed to
 * match `PermissionsGuard`. It did not: the guard compared `kyc:review` as
 * itself and refused it, this function rewrote it to `kyc.review` and allowed
 * it. An authorization answer that depends on which layer is asking is not an
 * authorization answer. It is exactly the fifth spelling that spec warned was
 * one copy-paste away.
 */
export function normalizePermissionKey(key: string): string {
  return key.toLowerCase();
}

/*
 * No wildcard branch. `*` used to mean "every permission", including every
 * permission added after the grant was made — migration 0044 expanded every
 * stored one into the catalog as it stood that day, and nothing writes one
 * again. Leaving the branch here would silently re-privilege any row that
 * acquired a `*` afterwards, which is the failure mode dropping it prevents.
 */
export function actorHasPermission(actor: Actor, permission: string): boolean {
  const wanted = normalizePermissionKey(permission);
  return actor.permissions.some((held) => normalizePermissionKey(held) === wanted);
}

/**
 * Refuses unless the actor holds the permission.
 *
 * Throws a DomainError rather than an HttpException — services never import
 * HTTP types, and AllExceptionsFilter maps AuthorizationError to 403 in one
 * place. That is also what lets a queued job call the same method and get a
 * meaningful failure instead of an HTTP exception with nowhere to go.
 */
export function assertActorCan(actor: Actor, permission: string, action: string): void {
  if (actorHasPermission(actor, permission)) return;

  throw new AuthorizationError(
    `${actor.email} cannot ${action}: the ${permission} permission is required.`,
  );
}

/**
 * ANY-of, matching `@RequirePermissions(...keys)` at the edge — the guard has
 * always been any-of (`required.some`), and a service that re-asserts a SINGLE
 * key against a route that accepts two turns one of the route's own grants
 * into a refusal nobody can explain from the permission matrix.
 */
export function assertActorCanAny(
  actor: Actor,
  permissions: readonly string[],
  action: string,
): void {
  if (permissions.some((permission) => actorHasPermission(actor, permission))) return;

  throw new AuthorizationError(
    `${actor.email} cannot ${action}: one of ${permissions.join(', ')} is required.`,
  );
}
