import { Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import { CATALOG_KEYS } from '../common/security/actor';
import { getDb } from './db';
import { roles } from './schema';

/**
 * Report — never repair — an `Administrator` role that has fallen behind the
 * permission catalog.
 *
 * ── The failure this exists to make visible ────────────────────────────────
 *
 * Permissions are a STORED SNAPSHOT, not a reference to `permissions.json`. The
 * seed writes the whole catalog into the `Administrator` row, but it writes it
 * with `onConflictDoNothing({ target: roles.name })` — deliberately, because a
 * seed that re-widened a role on every boot would silently undo an operator who
 * had narrowed it on purpose. An EXISTING row is therefore frozen at whatever
 * the catalog held the day it was created.
 *
 * So a new key reaches nobody until a migration writes it into the rows, and
 * until then the symptom is a 403 on a screen the full-access account plainly
 * ought to reach. It compounds: `assertGrantable` refuses to hand out a key the
 * granter does not hold, so nobody on that role can grant it to anyone else
 * either, and the gap cannot be closed from inside the console.
 *
 * This has now been repaired by hand three times — migrations 0068, 0075 and
 * 0085 — and each time it was found by a person hitting the wall in a browser,
 * twice in PRODUCTION. Nothing reported it, because from the application's
 * point of view a role that lacks a permission is not an error; it is a role.
 *
 * ── It REPAIRS the Administrator role, and only that role ─────────────────
 *
 * This used to report and stop, on the reasoning that "a migration was
 * forgotten" and "an operator deliberately narrowed this role" look identical
 * in the row, so only a human can tell which apart. The reasoning was sound and
 * its premise was wrong.
 *
 * The owner settled it (24 Aug 2026): **`Administrator` is the top-level role
 * INSIDE the system.** Above it sits only the project owner, who is not a row in
 * this table at all. So "somebody deliberately narrowed the top role" is not a
 * case worth preserving — it is not a supported operation, and the ambiguity
 * that justified stopping does not exist. A key the catalog defines belongs to
 * this role by definition of what the role is.
 *
 * That decision USED to live only in this comment, because the code could not
 * derive it: the match was `WHERE name = 'Administrator'` — a magic string —
 * against a row that said `is_system = false`. The role was special in fact and
 * ordinary in the data, so renaming it in the console silently stopped the
 * top-up, and nothing in the schema said which role the rule was about.
 *
 * `is_system` now carries it. The flag means "the backend maintains this role's
 * permissions against the catalog", the match is on the flag, and the magic
 * string is gone. That also makes the row safe to SHOW and ASSIGN in the
 * console — the admin UI used to hide and refuse to assign system roles, which
 * is what made `Master Admin` unhandoutable and got it deleted. Editing and
 * deleting are still refused; holding it was never the thing in question.
 *
 * The repair is deliberately narrow on three axes:
 *
 *  - **Only the role named `Administrator`.** Every other role is read, never
 *    written. The whole point of the other thirteen seeded roles is that they
 *    are narrow — a Support Agent lacking `payments.edit` is not drift, it is
 *    the role — so widening any of them would be the destructive act this
 *    module was originally written to refuse.
 *  - **It only ever ADDS.** A key somebody put on the role by hand that the
 *    catalog does not define is left alone rather than tidied away. This closes
 *    a gap; it does not enforce equality.
 *  - **It names every key it grants, in the log.** Granting authority is still a
 *    decision needing an author, and the author is now this rule — so it says
 *    so, next to the startup banner where somebody is already looking.
 *
 * ⚠️ The consequence worth knowing before it surprises somebody: narrowing the
 * Administrator role from the console now reverts on the next boot. If a
 * genuinely limited operator is wanted, the answer is a DIFFERENT role — which
 * is what the other thirteen exist for — not a smaller top role.
 *
 * ── Why bootstrap, and why every environment ──────────────────────────────
 *
 * Boot is the moment the answer changes: a deploy carrying a new catalog key is
 * exactly when the gap opens, and the line lands in `docker logs` next to the
 * startup banner where somebody is already looking. It runs in production too —
 * `runSeeds()` does not, which is precisely why production is where this keeps
 * being discovered by hand.
 *
 * A missing row is silence, not a warning: a fresh database has no
 * `Administrator` role yet, and on that path the seed is about to create it
 * holding the whole catalog.
 *
 * It never throws. An API that refuses to serve because this query failed would
 * be a worse outage than the gap it closes.
 */
export async function reportPermissionDrift(logger = new Logger('PermissionDrift')): Promise<void> {
  try {
    const db = getDb();

    /*
     * Matched on `is_system`, NOT on the name.
     *
     * This used to read `WHERE name = 'Administrator'` — a magic string, against
     * a row that said `is_system = false`. The role was therefore special in
     * fact and ordinary in the data, and the note at the top of this file had to
     * say so in prose "because the code cannot derive it". Two things followed:
     * renaming the role in the console silently stopped the auto-update, and
     * nothing in the schema recorded which role this rule was about.
     *
     * The flag now MEANS this rule. `is_system = true` reads as "the backend
     * maintains this role's permissions against the catalog" — which is what an
     * operator already assumes when they see the badge, and what makes the row
     * safe to show and assign in the console rather than hide.
     *
     * Plural because the schema allows it. Nothing stops a second system role
     * existing, and one that quietly missed the top-up would be the same silent
     * gap this whole module exists to close.
     */
    const systemRoles = await db
      .select({ id: roles.id, name: roles.name, permissions: roles.permissions })
      .from(roles)
      .where(eq(roles.isSystem, true));

    // No rows: a fresh database whose seed is about to create one holding the
    // whole catalog, or a deployment that runs without a system role at all.
    // Neither is drift, and neither is this function's business.
    if (systemRoles.length === 0) return;

    for (const role of systemRoles) {
      await grantCatalogTo(db, role, logger);
    }
  } catch (error) {
    // Reporting must never be the reason the process does not start.
    logger.warn(
      `Could not check the system roles against the permission catalog: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Brings ONE system role up to the catalog. Adds only; never removes. */
async function grantCatalogTo(
  db: ReturnType<typeof getDb>,
  role: { id: string; name: string; permissions: string[] | null },
  logger: Logger,
): Promise<void> {
  {
    const held = role.permissions ?? [];
    const heldSet = new Set(held);
    const missing = CATALOG_KEYS.filter((key) => !heldSet.has(key)).sort();
    if (missing.length === 0) return;

    /*
     * UNION, not replace. The write is `held ∪ catalog`, so a key somebody added
     * by hand that the catalog does not define survives — this closes a gap
     * rather than enforcing equality, and tidying away a key nobody asked about
     * would be the destructive half of "sync" that this deliberately is not.
     *
     * Sorted so the stored array has a stable order and two databases that took
     * different routes to the same set compare equal by eye.
     */
    const granted = [...new Set([...held, ...CATALOG_KEYS])].sort();

    await db.update(roles).set({ permissions: granted }).where(eq(roles.id, role.id));

    /*
     * `log`, not `warn`. Having closed the gap, this is a normal and expected
     * consequence of a deploy that added a key — the abnormal thing was the
     * silence before it. It still names every key, because granting authority
     * is a decision that needs an author and the author is this rule.
     */
    logger.log(
      `Granted the "${role.name}" role ${missing.length} permission ` +
        `${missing.length === 1 ? 'key' : 'keys'} that config/permissions.json defines and the ` +
        `role lacked: ${missing.join(', ')}. ` +
        'It is a SYSTEM role, so the catalog is its definition — see the note at the top of ' +
        'database/permission-drift.ts. Roles that are not system roles are never touched.',
    );
  }
}
