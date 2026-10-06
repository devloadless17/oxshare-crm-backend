import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import * as schema from '../src/database/schema';

/**
 * A freshly-migrated database, per suite, inside the run's shared container.
 *
 * The container is started once in test/global-setup.ts — see the reasoning
 * there. What this file owns is the guarantee that mattered before and still
 * does: every suite gets its own empty database, running the real committed
 * migrations, including the append-only ledger and audit triggers.
 *
 * Per-suite isolation is not a nicety here. `money.spec.ts` asserts "every
 * wallet in the database reconciles" as a CI invariant; if a neighbouring
 * suite's fixtures were visible, that assertion would quietly be checking
 * something else. Sharing a container is a performance decision. Sharing a
 * database would have been a correctness one, and is not what this does.
 */
export interface MoneyTestContext {
  pool: Pool;
  db: NodePgDatabase<typeof schema>;
  /** The database this suite owns, dropped on teardown. */
  databaseName: string;
}

/** The shared container's admin connection, from globalSetup. */
function containerUri(): string {
  const uri = process.env['TEST_PG_URI'];
  if (!uri) {
    // A clear failure beats eleven confusing ones: this means the suite was run
    // in a way that skipped globalSetup (a bare `vitest` against a stale config,
    // or a runner that does not honour it).
    throw new Error(
      'TEST_PG_URI is not set — test/global-setup.ts did not run. Run the suite through `npm test`.',
    );
  }
  return uri;
}

/**
 * @param options.migrationsFolder a folder to migrate from instead of the
 *   committed one — for a spec that stops the history at a point (a copy with
 *   the later migrations left out) to prove what ONE migration does to data
 *   written before it (`migration-0139-profile.spec.ts`).
 */
export async function startMoneyTestDb(
  options: { migrationsFolder?: string } = {},
): Promise<MoneyTestContext> {
  // A valid identifier, unique per suite. `randomUUID` has hyphens, which would
  // need quoting everywhere; underscores keep it unquoted and greppable.
  const databaseName = `money_${randomUUID().replace(/-/g, '')}`;

  const admin = new Pool({ connectionString: containerUri() });
  try {
    // No parameter binding in DDL, hence the interpolation — safe because the
    // name is generated here from a UUID, never from input.
    await admin.query(`CREATE DATABASE ${databaseName}`);
  } finally {
    await admin.end();
  }

  const uri = new URL(containerUri());
  uri.pathname = `/${databaseName}`;
  const connectionString = uri.toString();

  const pool = new Pool({ connectionString });
  /*
   * WITHOUT THIS LISTENER A PASSING SHARD FAILS AT RANDOM (6 Oct 2026, a
   * production release blocked with every test green).
   *
   * `stopMoneyTestDb` awaits `pool.end()`, which resolves once the idle clients
   * are TOLD to close — not once their sockets are closed — and then drops the
   * database WITH (FORCE), which terminates them. A client still closing gets
   * that FATAL 57P01 as an `'error'` on the pool; with no listener Node treats it
   * as an uncaught exception, and vitest reports it against whichever file runs
   * next. Production's pool carries the same listener for the same reason
   * (`database/db.ts`). Queries in flight still reject to their own callers.
   */
  pool.on('error', () => undefined);
  const db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: options.migrationsFolder ?? './src/database/migrations' });

  // The stores and the money services resolve their connection from
  // DATABASE_URL through the lazy singleton, so point that at this suite's
  // database. Safe because vitest.config.mts sets fileParallelism: false —
  // suites run one at a time in one process.
  process.env['DATABASE_URL'] = connectionString;

  return { pool, db, databaseName };
}

export async function stopMoneyTestDb(ctx: MoneyTestContext): Promise<void> {
  await ctx.pool.end();

  // Dropped rather than left behind: a long run would otherwise accumulate a
  // database per suite inside the shared container, and the next suite's
  // CREATE DATABASE competes with them for shared buffers.
  const admin = new Pool({ connectionString: containerUri() });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${ctx.databaseName} WITH (FORCE)`);
  } catch {
    // Teardown failing must not fail a suite that passed. The container is
    // discarded at the end of the run regardless.
  } finally {
    await admin.end();
  }
}
