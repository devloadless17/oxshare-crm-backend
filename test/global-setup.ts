import { PostgreSqlContainer, StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * ONE Postgres container for the whole run.
 *
 * Every money suite used to start and stop its own: eleven container boots and
 * eleven migration runs per `npm test`. That is not just slow, it is the source
 * of the run-to-run variance — a full run measured 61s once and 191s the next
 * time on the same commit, and one of those slow runs failed with six tests
 * skipped, which is the shape of a `beforeAll` giving up rather than a real
 * assertion breaking.
 *
 * A money suite that goes red under load is worse than one that is merely slow.
 * "Just re-run it" is how a genuine failure gets waved through, and this is the
 * suite where a genuine failure means the ledger does not balance.
 *
 * ISOLATION IS UNCHANGED. The container is shared; the DATABASE is not. Each
 * suite still creates its own freshly-migrated database inside this container
 * (see money-setup.ts), so no suite can observe another's rows — which matters
 * for assertions like "every wallet in the database reconciles", where a
 * neighbouring suite's fixtures would silently widen what is being checked.
 *
 * What is paid once instead of eleven times: image resolution, container start,
 * and the health-check wait. Migrations still run per database, because that is
 * what proves the committed DDL applies cleanly.
 */

let container: StartedPostgreSqlContainer | undefined;

export async function setup(): Promise<void> {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  // Suites reach the container through this, rather than through an import —
  // vitest runs globalSetup in a separate module graph from the test files.
  process.env['TEST_PG_URI'] = container.getConnectionUri();
}

export async function teardown(): Promise<void> {
  await container?.stop();
}
