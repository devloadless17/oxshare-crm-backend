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
  process.env['TEST_PG_URI'] = ipv4(container.getConnectionUri());
}

/**
 * `localhost` → `127.0.0.1`, because the two are not interchangeable here.
 *
 * Testcontainers builds its URI with the hostname `localhost`. On a machine
 * where `localhost` resolves to IPv6 `::1` first — the default on Windows, and
 * on any host with an IPv6 loopback line in `hosts` — that name points
 * somewhere the published port is not: Docker's forward listens on IPv4 only,
 * so the connection reaches nothing and comes back `read ECONNRESET`.
 *
 * The failure is maximally confusing, which is why this is worth a helper and
 * a comment rather than an inline replace. The container starts, reports
 * healthy, and hands out a URI; every suite then dies on its first statement.
 * A whole run goes red at once and reads like the database is broken rather
 * than merely unreachable — the visible error is on `CREATE DATABASE`, several
 * frames from the cause. `127.0.0.1` has no such ambiguity.
 */
function ipv4(uri: string): string {
  const url = new URL(uri);
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return url.toString();
}

export async function teardown(): Promise<void> {
  await container?.stop();
}
