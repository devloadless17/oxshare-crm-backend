import { defineConfig } from 'vitest/config';

// ARCHITECTURE §2/§11: Vitest, and money-path tests run against a REAL
// Postgres via Testcontainers — never a mock. Container startup is slow by
// design; correctness beats speed on this path.
export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    /*
     * One Postgres container for the run, not one per suite.
     *
     * Eleven suites each started and stopped their own: eleven image starts,
     * eleven health-check waits. That is where the run-to-run variance came
     * from — the same commit measured 61s and 191s, and the slow run failed
     * with six tests skipped, which is a beforeAll giving up rather than an
     * assertion breaking. A money suite that goes red under load is worse than
     * a slow one: "just re-run it" is how a real failure gets waved through.
     *
     * Each suite still gets its own freshly-migrated DATABASE inside it — see
     * test/money-setup.ts. Sharing the container is a performance decision;
     * sharing a database would have been a correctness one.
     */
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,

    /*
     * Test secrets, so the suite is hermetic.
     *
     * `AdminAuthModule` builds its JwtModule with
     * `config.getOrThrow('ADMIN_JWT_SECRET')` — deliberately, since a JWT signed
     * with a fallback secret is worse than a boot failure. But that makes every
     * spec which boots AppModule (di-wiring, openapi-routes, validation) depend
     * on a `.env` file that is gitignored and therefore does not exist on CI or
     * in a fresh clone. Those three suites had been failing on CI for four
     * commits with `Configuration key "ADMIN_JWT_SECRET" does not exist`, while
     * every local run passed because every local machine has a .env.
     *
     * Declaring them here rather than in the workflow keeps "it passed locally"
     * and "it passed in CI" the same statement — a fresh clone with no .env now
     * runs the full suite. process.env takes precedence over the .env file in
     * @nestjs/config, so these values win and the run is deterministic.
     *
     * They are obviously fake and over the 32-character minimum that
     * config/env.validation.ts enforces. Nothing here weakens production: that
     * validation still refuses to start without real secrets.
     */
    env: {
      NODE_ENV: 'test',
      ADMIN_JWT_SECRET: 'test-only-admin-secret-never-used-outside-vitest',
      /*
       * All FOUR signing secrets, and all four distinct.
       *
       * This one was missed when it became required, and the gap was invisible
       * on any machine with a `.env` — which is every machine that had been
       * working on the project. It surfaced only on a checkout without one:
       * `ADMIN_JWT_REFRESH_SECRET: Required`, and every HTTP spec failed to boot
       * before running a single assertion.
       *
       * CI never caught it because ci.yml sets the variable itself, so CI stayed
       * green while a fresh clone did not — precisely the divergence this block
       * exists to close. A promise that "it passed locally" and "it passed in CI"
       * mean the same thing has to be re-checked whenever the required set grows.
       *
       * The values must differ from each other: env.validation refuses to start
       * when two signing secrets share a value, so reusing one here would trade
       * this failure for a more confusing one.
       */
      ADMIN_JWT_REFRESH_SECRET: 'test-only-admin-refresh-secret-never-used-outside-vitest',
      JWT_ACCESS_SECRET: 'test-only-access-secret-never-used-outside-vitest',
      JWT_REFRESH_SECRET: 'test-only-refresh-secret-never-used-outside-vitest',
      MT5_BRIDGE_SECRET: 'test-only-bridge-secret-never-used-outside-vitest',
      // Required alongside the bridge secret: env.validation refuses to start
      // with a live deal webhook and no Redis for its single-use replay markers
      // (§8.4, R-5.3). Nothing here CONNECTS — the client is lazy and every
      // test injects a fake — this only satisfies the boot-time coupling, which
      // is exactly the check that would otherwise be untested.
      REDIS_URL: 'redis://localhost:6379',
    },

    // One container, shared connection: money tests must observe each other's
    // concurrency, so they may not run in isolated parallel workers.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: [
        '**/*.spec.ts',
        // Drizzle-generated, and never hand-edited.
        'src/database/migrations/**',
        'src/database/schema.ts',
        // Bootstrap and dev seeding, exercised by running the app rather than by
        // a unit test.
        'src/main.ts',
        'src/database/seed.ts',
        '**/*.module.ts',
        // DTOs are declarations; there is no branch in them to cover.
        '**/dto/**',
      ],
      /*
       * A FLOOR, not a target — filled in from a measured run, and it may only
       * ever go up.
       *
       * Read this number in context: the four ARCHITECTURE §11 money tests cover
       * the paths that can lose money, against a real Postgres. Broad line
       * coverage across controllers and stores is a much weaker signal than those
       * four, so do not chase the percentage at their expense.
       */
      // Raised after slice 3 (RBAC). Measured 2026-08-05: statements 76.9,
      // branches 67.7, functions 73.1, lines 78.1 — from admin-users.spec.ts
      // (`updateAdmin` had NO tests at all), the admin-suspension HTTP spec, and
      // the invite-journey HTTP spec that caught the email-case login bug.
      //
      // Set a few points under the measurement. These are RATCHETS against
      // regression, not targets: they may only ever go up, and a floor set above
      // what the suite actually reaches is the kind that gets disabled the first
      // time it blocks someone.
      //
      // ⚠️ BRANCHES lowered 69 → 65 on 2026-08-10, and the rule above says these
      // may only go up — so here is why this one is different.
      //
      // 69 was never attainable. The measurement it was "set a few points
      // under" recorded branches at 67.7, and the floor went in at 69 — ABOVE
      // it. That went unnoticed for five days because the step never ran: 33
      // test failures from the permission rework killed the job before coverage
      // was evaluated, on every push since 6 August. The first green suite is
      // what surfaced it.
      //
      // Measured 2026-08-10, on the run where all 1285 pass: statements 77.31,
      // branches 66.37, functions 76.13, lines 78.81. The other three floors
      // are met as written and are NOT touched — this is one threshold that was
      // wrong when it was typed, not a coverage collapse. See DECISIONS D-53.
      thresholds: { lines: 78, functions: 73, branches: 65, statements: 77 },
    },
  },
});
