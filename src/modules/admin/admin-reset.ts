import type { Admin } from '../../store/admins.store';

/**
 * Who may reset whose password — the whole of it, as one pure function.
 *
 * ── Why this is a seam rather than three lines in the service ───────────────
 *
 * A RESET CAPABILITY IS IMPERSONATION. Whoever can reset an admin's password
 * can become that admin, on a console that approves payouts. So this is not a
 * permission check with a guard bolted on; the guard IS the feature, and it is
 * separated from the service for the same reason `commission.ts` is: no DB, no
 * HTTP, so every branch can be asserted directly instead of through a fixture.
 *
 * The failure this exists to prevent is quiet. A permission check alone —
 * "does the actor hold admins.manage?" — looks correct in review and lets any
 * sub-admin holding it reset a MASTER admin and take the entire console. The
 * privilege comparison is the part that matters, and it is the part that is
 * easy to leave out.
 *
 * ── The rules, and where they come from ────────────────────────────────────
 *
 * DECISIONS D-44, resolved 6 Aug 2026:
 *
 *  1. A master admin may reset ANY admin, including another master. Masters are
 *     peers. Forbidding it would leave a sole locked-out master with no path
 *     back except the database — the situation the feature exists to remove.
 *     The cost is named and accepted: masters can seize each other's accounts,
 *     and the audit trail is what makes that survivable rather than invisible.
 *
 *  2. Nobody may reset UPWARDS. A sub-admin never reaches a master, and never
 *     reaches a peer holding permissions they do not themselves hold —
 *     otherwise reset becomes a ladder: grant yourself nothing, reset someone
 *     who has more, sign in as them.
 *
 *  3. Nobody resets THEMSELVES through this path. An admin who knows their
 *     password uses change-password, which verifies the current one. Allowing
 *     self-reset here would turn a stolen session into a permanent one without
 *     ever proving knowledge of the password.
 */
export type ResetRefusal =
  'self' | 'target-outranks-actor' | 'target-is-master' | 'actor-not-permitted';

/** `null` means allowed; anything else names why not. */
export function refuseReset(
  actor: Pick<Admin, 'id' | 'role' | 'permissions'>,
  target: Pick<Admin, 'id' | 'role' | 'permissions'>,
): ResetRefusal | null {
  /*
   * Self first, before any privilege reasoning.
   *
   * A master admin passes every check below, so without this the highest
   * privilege in the system would be the one able to bypass proof-of-password
   * on its own account — the exact inversion of what privilege should buy.
   */
  if (actor.id === target.id) return 'self';

  const actorIsMaster = actor.role === 'master_admin' || actor.permissions.includes('*');
  // Rule 1: masters are peers, so this is the last word for them.
  if (actorIsMaster) return null;

  // Rule 2, the upward cases. Role first, because a master's authority does not
  // live in its permission list — `role` is the claim that outranks everything.
  if (target.role === 'master_admin' || target.permissions.includes('*')) {
    return 'target-is-master';
  }

  /*
   * A non-master needs an explicit grant AND must not be reaching above itself.
   *
   * The subset test is the ladder-closer: holding `admins.reset` is not
   * authority over someone who holds `admins.reset` PLUS `withdrawals.approve`.
   * Comparing sets rather than counting them matters — two admins can hold the
   * same NUMBER of permissions and still not be peers.
   */
  /*
   * `admins.reset` is the admin-management grant in this catalogue, despite the
   * name: it is what `POST /admin/invite` requires to CREATE an administrator.
   * There is no `admins.*` namespace, and inventing one here would have made
   * this branch unreachable — a guard nobody can satisfy looks like a feature
   * and behaves like dead code.
   */
  if (!actor.permissions.includes('admins.reset')) return 'actor-not-permitted';

  const held = new Set(actor.permissions);
  const reachesHigher = target.permissions.some((p) => !held.has(p));
  return reachesHigher ? 'target-outranks-actor' : null;
}

/**
 * How long a reset link lives.
 *
 * Far shorter than the 48 hours an invite gets, and the difference is the
 * situation rather than the mechanism: an invite waits for someone to notice an
 * email from a company they have not joined yet, while a reset is something a
 * locked-out colleague is actively waiting for, usually while talking to the
 * person who triggered it. A credential that grants an admin account should
 * live exactly as long as it is needed.
 */
export const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
