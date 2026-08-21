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
/**
 * The upward-reach test shared by EVERY admin-management act — D-59, resolved
 * (owner, 13 Aug 2026): nobody may edit, suspend, re-scope or demote an
 * administrator who holds a permission they do not hold themselves.
 *
 * This is how "no one can touch the super admin" is expressed without
 * resurrecting a special tier: the full-access admin outranks everyone, so
 * nobody below reaches them; EQUALS are peers (two Administrators can rescue
 * each other, so a locked-out top admin never needs the database); and the
 * ladder is closed in every direction — you cannot demote your way past
 * someone, because you cannot touch them at all.
 *
 * Sets, not counts: two admins can hold the same NUMBER of permissions and
 * still not be peers.
 */
export function targetOutranksActor(
  actor: Pick<Admin, 'permissions'>,
  target: Pick<Admin, 'permissions'>,
): boolean {
  const held = new Set(actor.permissions);
  return target.permissions.some((p) => !held.has(p));
}

/**
 * The MANAGEMENT rule (edit/suspend) — deliberately weaker than the reset
 * rule above, and the difference is the act.
 *
 * Reset is impersonation, so it refuses on ANY key the actor lacks: authority
 * over an account is authority over everything it can do. Management is not
 * impersonation — suspending or renaming a KYC reviewer does not hand you
 * `kyc.review` — so refusing every LATERAL case (disjoint permission sets)
 * would only mean the admin-manager needs a copy of every key in the building.
 *
 * What must be unreachable is the account ABOVE you: one that holds everything
 * you hold and more. That is the super admin from any lesser seat, and it is a
 * set comparison, not a tier — equals stay peers (two full-access admins can
 * rescue each other), and the full-access admin supersedes everyone.
 */
export function targetSupersedesActor(
  actor: Pick<Admin, 'permissions'>,
  target: Pick<Admin, 'permissions'>,
): boolean {
  const targetHeld = new Set(target.permissions);
  const containsActor = actor.permissions.every((p) => targetHeld.has(p));
  return containsActor && targetOutranksActor(actor, target);
}

export type ResetRefusal = 'self' | 'target-outranks-actor' | 'actor-not-permitted';

/**
 * `null` means allowed; anything else names why not.
 *
 * ── PERMISSIONS MUST BE THE RESOLVED SET, NOT THE ROW'S SNAPSHOT ────────────
 *
 * `admins.permissions` is a snapshot taken when the role was assigned; the
 * ROLE is the live truth and the guard resolves it on every request. Feeding
 * this function two raw rows therefore compared stale data on both sides — and
 * that was a ladder: widen role R, and every admin on R holds more than their
 * row says; an actor whose keys cover the stale row passes the subset test
 * below, resets that admin, and signs in as an account that now outranks them.
 * `AdminAuthService.initiatePasswordReset` resolves both sides through the same
 * resolver `AdminRbacService.assertActorOutranks` uses, and this function is
 * typed on `permissions` alone so nothing can hand it a row by accident.
 *
 * ── No master tier ──────────────────────────────────────────────────────────
 *
 * There is no `master_admin` role and no `'*'` wildcard any more (see
 * admin.guard.ts); full access is a real list of real keys. This used to wave
 * through an actor whose `role` column said master and refuse a target whose
 * did — two claims nothing else in the system honours, one of which was a
 * bypass-shaped hole. The subset ladder below expresses the same rules
 * honestly: a full-access admin holds every key and so reaches everyone
 * (rule 1), and nobody below them holds a superset of theirs (rule 2).
 */
export function refuseReset(
  actor: Pick<Admin, 'id' | 'permissions'>,
  target: Pick<Admin, 'id' | 'permissions'>,
): ResetRefusal | null {
  /*
   * Self first, before any privilege reasoning.
   *
   * A full-access admin passes every check below, so without this the highest
   * privilege in the system would be the one able to bypass proof-of-password
   * on its own account — the exact inversion of what privilege should buy.
   */
  if (actor.id === target.id) return 'self';

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

  // One definition of "outranks" for every management act — see above.
  return targetOutranksActor(actor, target) ? 'target-outranks-actor' : null;
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
