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
 * The identity a background job acts under.
 *
 * Explicit and auditable, never an implicit "trusted because internal". A job
 * that runs as nobody produces audit rows that say nobody did it, and a
 * permission model with an unnamed bypass is a permission model with a hole.
 *
 * The `*` is deliberate and safe here in a way it would not be for a person:
 * this identity cannot log in — no password, no session, no token is ever
 * minted for it — so it can only ever be reached from code that already runs
 * inside the process.
 */
export const SYSTEM_ACTOR: Actor = {
  id: '00000000-0000-0000-0000-000000000000',
  email: 'system@oxshare.internal',
  permissions: ['*'],
};

/** Same normalization as PermissionsGuard: 'kyc:review' ≡ 'kyc.review'. */
function normalize(key: string): string {
  return key.replace(/:/g, '.').toLowerCase();
}

export function actorHasPermission(actor: Actor, permission: string): boolean {
  if (actor.permissions.includes('*')) return true;
  const wanted = normalize(permission);
  return actor.permissions.some((held) => normalize(held) === wanted);
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
