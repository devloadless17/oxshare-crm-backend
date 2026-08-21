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
 * ── Why a log line and not a fix ───────────────────────────────────────────
 *
 * Writing the missing keys here would be the same re-widening the seed's
 * `onConflictDoNothing` exists to prevent, except worse: it would run in
 * production, on every boot, with no migration recording that a role's
 * permissions had changed or who decided it. Granting authority is a decision,
 * and a decision needs an author.
 *
 * It also cannot distinguish the two reasons a key can be missing. "A migration
 * was forgotten" and "an operator deliberately narrowed this role" look
 * identical in the row. Only a human knows which, so this hands them the fact
 * and the remedy and stops.
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
 * It is READ-ONLY and never throws. An API that refuses to serve because a
 * reporting query failed would be a worse outage than the one it reports.
 */
export async function reportPermissionDrift(logger = new Logger('PermissionDrift')): Promise<void> {
  try {
    const db = getDb();
    const [role] = await db
      .select({ permissions: roles.permissions })
      .from(roles)
      .where(eq(roles.name, 'Administrator'))
      .limit(1);

    // No row: a fresh database, or a deployment that names its full-access role
    // something else. Neither is drift, and neither is this function's business.
    if (!role) return;

    const held = new Set(role.permissions ?? []);
    const missing = CATALOG_KEYS.filter((key) => !held.has(key)).sort();
    if (missing.length === 0) return;

    logger.error(
      `The "Administrator" role is missing ${missing.length} permission ` +
        `${missing.length === 1 ? 'key' : 'keys'} that config/permissions.json defines: ` +
        `${missing.join(', ')}. ` +
        'Anyone on that role gets 403 on the matching screens and cannot grant these to ' +
        'anybody else either. If a migration was forgotten, add one modelled on ' +
        'src/database/migrations/0085_grant_ledger_view.sql. If this role was narrowed ' +
        'deliberately, this line is expected and can be ignored.',
    );
  } catch (error) {
    // Reporting must never be the reason the process does not start.
    logger.warn(
      `Could not check the Administrator role against the permission catalog: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
