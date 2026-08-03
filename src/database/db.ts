import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

// Lazy singleton: created on first use, which is always after Nest's
// ConfigModule has loaded .env — never at import time, when process.env
// may not be populated yet. Stores import getDb() directly (they are plain
// objects outside Nest DI); DatabaseModule exposes the same instance to DI.
let instance: NodePgDatabase<typeof schema> | null = null;
let pool: Pool | null = null;

export function getDb(): NodePgDatabase<typeof schema> {
  if (!instance) {
    const connectionString =
      process.env['DATABASE_URL'] ?? 'postgresql://oxshare:oxshare_dev@localhost:5432/oxshare';
    pool = new Pool({
      connectionString,
      ssl: connectionString.includes('neon.tech') ? { rejectUnauthorized: false } : false,
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
    await getDb().execute('select 1' as unknown as never);
    return true;
  } catch {
    return false;
  }
}
