/**
 * Create the FIRST admin on a fresh production database. Run once, by hand.
 *
 *   docker compose -f docker-compose.prod.yml run --rm \
 *     -e BOOTSTRAP_ADMIN_EMAIL=you@example.com \
 *     -e BOOTSTRAP_ADMIN_PASSWORD='...' \
 *     api node scripts/bootstrap-admin.mjs
 *
 * ── Why this exists rather than `runSeeds()` ────────────────────────────────
 *
 * Production skips the seeds (main.ts gates the import on NODE_ENV), so a fresh
 * deploy has no admin and no roles — and the invite flow needs a signed-in admin
 * to send an invite. Something has to break that circle.
 *
 * `runSeeds()` is the wrong thing to break it with. It has NO internal
 * production guard; its safety is entirely the caller's. Run against a live
 * database it also inserts e2e-admin@, e2e@, e2e-kyc@, e2e-logout@ and
 * e2e-restricted@oxshare.com, a cohort of fixture clients on @oxshare-e2e.test,
 * two e2e tags and an "E2E Restricted" role — test identities with known
 * passwords, in a money system. The seed file's own comments say this cannot
 * reach production BECAUSE main.ts gates it, which is exactly why calling it
 * from anywhere else is unsafe.
 *
 * So: one role, one admin, nothing else.
 *
 * ── What it deliberately reuses ─────────────────────────────────────────────
 *
 * The permission catalog and the password hasher are imported from the compiled
 * application, not reimplemented. A bootstrap that hand-lists permissions drifts
 * from config/permissions.json the first time a key is added, and the drift
 * looks like a master admin mysteriously missing a screen.
 *
 * Idempotent by DB constraint (unique role name, unique admin email), never
 * check-then-insert — the same discipline as seed.ts. Running it twice is safe
 * and, notably, does NOT reset the password of an admin that already exists.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { and, eq, isNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { admins, roles } from '../dist/database/schema.js';
import { PasswordService } from '../dist/common/security/password.service.js';

const email = process.env.BOOTSTRAP_ADMIN_EMAIL;
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
const name = process.env.BOOTSTRAP_ADMIN_NAME ?? 'Administrator';
const connectionString = process.env.DATABASE_URL;

const problems = [];
if (!connectionString) problems.push('DATABASE_URL is not set.');
if (!email) problems.push('BOOTSTRAP_ADMIN_EMAIL is not set.');
if (!password) problems.push('BOOTSTRAP_ADMIN_PASSWORD is not set.');
// Not a policy, just a floor. This account holds every permission in the system
// from the moment it exists, and it is created outside the console's own rules.
if (password && password.length < 12) {
  problems.push('BOOTSTRAP_ADMIN_PASSWORD must be at least 12 characters.');
}
if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}

/*
 * Every key in the catalog, listed out rather than wildcarded — the same choice
 * seed.ts documents. `['*']` would grant permissions added AFTER this account
 * was made, retroactively; listing them means a new key has to be ticked
 * deliberately, like any other.
 *
 * Read from dist/, because the runtime image carries no src/config.
 */
const catalogPath = fileURLToPath(new URL('../dist/config/permissions.json', import.meta.url));
const ALL_PERMISSIONS = Object.values(JSON.parse(readFileSync(catalogPath, 'utf-8'))).flatMap(
  (module) => module.permissions.map((entry) => entry.key),
);

// Mirrors src/database/db.ts — see the same comment in scripts/migrate.mjs.
const isLocal = /@(localhost|127\.0\.0\.1|postgres)[:/]/.test(connectionString);

const pool = new pg.Pool({
  connectionString,
  ssl: isLocal ? false : { rejectUnauthorized: true },
  max: 1,
  connectionTimeoutMillis: 15_000,
});

try {
  const db = drizzle(pool);
  // argon2id with the application's own parameters. Constructed directly: it is
  // @Injectable() but has no dependencies, which is how seed.ts uses it too.
  const passwordHash = await new PasswordService().hash(password);

  const [role] = await db
    .insert(roles)
    .values({
      name: 'Administrator',
      description: 'Every permission in the catalog.',
      permissions: ALL_PERMISSIONS,
      maskedFields: [],
    })
    .onConflictDoNothing({ target: roles.name })
    .returning({ id: roles.id });

  // onConflictDoNothing returns nothing when the row already existed, which is
  // the normal case on a re-run — so read it back rather than treating the empty
  // result as a failure.
  const roleId =
    role?.id ??
    (await db.select({ id: roles.id }).from(roles).where(eq(roles.name, 'Administrator')).limit(1))
      .at(0)?.id;

  if (!roleId) throw new Error('Administrator role could not be created or found.');

  const [created] = await db
    .insert(admins)
    .values({
      email,
      passwordHash,
      name,
      // `role` (the enum column) is deliberately left at its default: it is dead
      // after migration 0044 and nothing reads it. Access comes from roleId.
      permissions: ALL_PERMISSIONS,
    })
    .onConflictDoNothing({ target: admins.email })
    .returning({ id: admins.id });

  /*
   * `isNull(roleId)` so re-running never undoes a narrowing an operator has
   * since applied by hand — the same guard seed.ts puts on its own backfill.
   */
  await db
    .update(admins)
    .set({ roleId })
    .where(and(eq(admins.email, email), isNull(admins.roleId)));

  if (created) {
    console.log(`Created admin ${email} with the Administrator role.`);
    console.log('Sign in and change this password now — it was passed in as an environment');
    console.log('variable and is visible in the shell history of whoever ran this.');
  } else {
    console.log(`Admin ${email} already exists; password left unchanged.`);
  }
} catch (error) {
  console.error(`Bootstrap failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
