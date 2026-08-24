/**
 * Apply pending Drizzle migrations. The deploy runs this; a human can too.
 *
 *   docker compose -f docker-compose.prod.yml run --rm api node scripts/migrate.mjs
 *
 * ── Why a script and not `npm run db:migrate` ───────────────────────────────
 *
 * `db:migrate` is `drizzle-kit migrate`, and drizzle-kit is a devDependency. The
 * production image carries a pruned tree, so it is not there and will not be.
 * `drizzle-orm/node-postgres/migrator` is a PROD dependency and writes the same
 * `drizzle.__drizzle_migrations` table drizzle-kit does, so the two are
 * interchangeable against the same database — you can run either locally and
 * this one in the container without them disagreeing about what is applied.
 *
 * ── Two deliberate differences from drizzle.config.ts ───────────────────────
 *
 * 1. **No fallback connection string.** drizzle.config.ts defaults to
 *    `postgresql://oxshare:oxshare_dev@localhost:5432/oxshare` when DATABASE_URL
 *    is unset, which is a convenience locally and a trap in a container: it
 *    would migrate nothing, report success, and leave the real database behind.
 *    Here an unset DATABASE_URL is an error.
 *
 * 2. **The migrations folder is resolved from THIS FILE, not the cwd.**
 *    drizzle-orm's migrator concatenates strings — `${folder}/meta/_journal.json`
 *    with no path.resolve — so a cwd-relative './src/database/migrations' breaks
 *    the moment anything sets a working_dir, and breaks as a bare "Can't find
 *    meta/_journal.json file" that says nothing about why.
 *
 * All pending migrations run inside ONE transaction, so an interrupted deploy
 * (a cancelled workflow, a dropped ssh) rolls back whole rather than leaving the
 * schema halfway.
 */

import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set. Refusing to guess a database to migrate.');
  process.exit(1);
}

/*
 * Mirrors src/database/db.ts: TLS is verified everywhere except a loopback or
 * the in-compose service, which is reached over the container network and has no
 * certificate. Kept in step with that file deliberately — a migrator that
 * connects on terms the application would refuse is a divergence that only
 * surfaces as "migrations work but the app won't boot".
 */
const isLocal = /@(localhost|127\.0\.0\.1|postgres)[:/]/.test(connectionString);

const migrationsFolder = fileURLToPath(new URL('../src/database/migrations', import.meta.url));

const pool = new pg.Pool({
  connectionString,
  ssl: isLocal ? false : { rejectUnauthorized: true },
  // One connection, one job. The app's DB_POOL_MAX has nothing to do with this.
  max: 1,
  connectionTimeoutMillis: 15_000,
  // Migrations legitimately take longer than a request; db.ts's 30s cap would
  // abort a large index build partway.
  statement_timeout: 0,
});

/*
 * drizzle's migrate() is silent about what it did, and a deploy log that reads
 * "up to date" right after applying twelve migrations hides exactly the thing an
 * operator scrolls back to find. The ledger table it writes is the honest
 * source: count before, count after, report the difference. Before the first
 * migration the table itself does not exist — that is the `catch → 0`.
 */
async function appliedCount() {
  try {
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations',
    );
    return rows[0].n;
  } catch {
    return 0;
  }
}

try {
  console.log(`Applying migrations from ${migrationsFolder}`);
  const before = await appliedCount();
  await migrate(drizzle(pool), { migrationsFolder });
  const after = await appliedCount();
  console.log(
    after > before
      ? `Applied ${after - before} migration(s); ${after} total.`
      : `Already up to date (${after} applied).`,
  );
} catch (error) {
  console.error(`Migration failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
