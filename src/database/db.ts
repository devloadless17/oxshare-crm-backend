import { Logger } from '@nestjs/common';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

// Nest's Logger, not console: this file runs inside the app, so its output has to
// land in the same JSON stream (with the correlation id) as everything else.
const logger = new Logger('Database');

/** The drizzle instance. Also the type a transaction handle is assignable to. */
export type Db = NodePgDatabase<typeof schema>;

/** Either the pool-backed instance or a transaction handle, so a repository
 *  method can run inside a caller's transaction (ARCHITECTURE §6.2). */
export type Executor = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

// Lazy singleton: created on first use, which is always after Nest's
// ConfigModule has loaded .env — never at import time, when process.env
// may not be populated yet. DatabaseModule provides this instance under
// DRIZZLE_DB; every store takes it by constructor injection.
let instance: NodePgDatabase<typeof schema> | null = null;
let pool: Pool | null = null;

export function getDb(): NodePgDatabase<typeof schema> {
  if (!instance) {
    const connectionString =
      process.env['DATABASE_URL'] ?? 'postgresql://oxshare:oxshare_dev@localhost:5432/oxshare';
    // TLS: verify certificates. The previous `rejectUnauthorized: false` for
    // managed hosts disabled verification entirely, and every other host got no
    // TLS at all. Local dev over a loopback socket is the only exemption.
    const isLocal = /@(localhost|127\.0\.0\.1|postgres)[:/]/.test(connectionString);
    pool = new Pool({
      connectionString,
      ssl: isLocal ? false : { rejectUnauthorized: true },
      // Bounded pool + timeouts: an unbounded pool on a money system turns one
      // slow query into total connection starvation.
      max: Number(process.env['DB_POOL_MAX'] ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 30_000,
    });

    // WITHOUT THIS HANDLER THE PROCESS DIES.
    //
    // `pg` emits 'error' on the Pool when an IDLE client's connection breaks —
    // a database restart, a failover, an admin `pg_terminate_backend`, a network
    // blip. An 'error' event with no listener is, in Node, an unhandled error:
    // it does not reject a promise, it terminates the process.
    //
    // Verified by stopping Postgres under a running API (4 Aug 2026): the whole
    // service exited with "terminating connection due to administrator command".
    // Every instance would go down together on a routine database restart, and
    // /health/ready could never report the outage because nothing was alive to
    // answer it.
    //
    // Logging and swallowing is the correct handling: the pool discards the
    // broken client and the next query opens a fresh one, so this is recoverable
    // by design — it only looked fatal because nobody was listening. Queries
    // in flight still reject normally and surface to their own callers.
    pool.on('error', (error: Error) => {
      logger.error(
        `Idle Postgres client errored (pool will discard it and reconnect): ${error.message}`,
      );
    });

    instance = drizzle(pool, { schema });
  }
  return instance;
}

/** Tests only: drop the cached instance so the next getDb() re-reads DATABASE_URL. */
export function resetDb(): void {
  instance = null;
  pool = null;
}

/** Close the pool — test teardown and graceful shutdown. */
export async function closeDb(): Promise<void> {
  await pool?.end();
  instance = null;
  pool = null;
}

/** Cheap connectivity probe for the health endpoint. */
export async function pingDb(): Promise<boolean> {
  try {
    await getDb().execute('select 1');
    return true;
  } catch {
    return false;
  }
}
