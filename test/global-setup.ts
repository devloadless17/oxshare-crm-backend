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

/**
 * An ALREADY-RUNNING Postgres, named by the environment, is used as-is.
 *
 * The container is the default because it needs no setup and pins the server
 * version. But it needs a working container runtime, and there are machines
 * that run this suite where there is not one: the production VPS has Docker
 * Engine up while the CLI is refused on the named pipe unless the shell is
 * elevated and in `docker-users`. There, every suite in the run died on
 * "Could not find a working container runtime strategy" — the money
 * acceptance tests included, which is the one suite you most want to be able
 * to run on the box you are about to trust with a ledger.
 *
 * Pointing this at a real server is SAFE, and the reason is in money-setup.ts
 * rather than here: a suite never touches the database named in the URI. It
 * CREATEs `money_<uuid>`, migrates that, and DROPs it on teardown. The URI is
 * used for exactly two statements, both DDL against a generated name. So the
 * role needs CREATEDB, and nothing it already owns is at risk.
 *
 * Deliberately NOT falling back automatically when the container fails to
 * start. A suite that silently retargets itself at whatever `DATABASE_URL`
 * happens to hold is how a test run ends up creating databases on production
 * because somebody's shell had the deploy env sourced. Setting TEST_PG_URI is
 * a decision somebody makes out loud.
 */
export async function setup(): Promise<void> {
  const provided = process.env['TEST_PG_URI'];
  if (provided) {
    process.env['TEST_PG_URI'] = ipv4(provided);
    return;
  }

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
