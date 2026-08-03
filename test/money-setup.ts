import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import * as schema from '../src/database/schema';

// Boots a throwaway Postgres 16 and runs the real committed migrations against
// it — so the tests exercise the same DDL production will, including the
// append-only ledger trigger.
export interface MoneyTestContext {
  container: StartedPostgreSqlContainer;
  pool: Pool;
  db: NodePgDatabase<typeof schema>;
}

export async function startMoneyTestDb(): Promise<MoneyTestContext> {
  const container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const pool = new Pool({ connectionString: container.getConnectionUri() });
  const db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: './src/database/migrations' });

  // The stores and WalletService resolve their connection from DATABASE_URL
  // through the lazy singleton, so point that at the container.
  process.env['DATABASE_URL'] = container.getConnectionUri();
  return { container, pool, db };
}

export async function stopMoneyTestDb(ctx: MoneyTestContext): Promise<void> {
  await ctx.pool.end();
  await ctx.container.stop();
}
