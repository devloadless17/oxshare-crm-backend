import { defineConfig } from 'vitest/config';

// ARCHITECTURE §2/§11: Vitest, and money-path tests run against a REAL
// Postgres via Testcontainers — never a mock. Container startup is slow by
// design; correctness beats speed on this path.
export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
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
      JWT_ACCESS_SECRET: 'test-only-access-secret-never-used-outside-vitest',
      JWT_REFRESH_SECRET: 'test-only-refresh-secret-never-used-outside-vitest',
      MT5_BRIDGE_SECRET: 'test-only-bridge-secret-never-used-outside-vitest',
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
      // Raised after the KYC-config rule spec landed. Measured 2026-08-04:
      // statements 36.3, branches 20.5, functions 32.5, lines 37.0. Set a couple of
      // points under.
      thresholds: { lines: 35, functions: 30, branches: 18, statements: 34 },
    },
  },
});
