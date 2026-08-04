import { defineConfig } from 'vitest/config';

// ARCHITECTURE §2/§11: Vitest, and money-path tests run against a REAL
// Postgres via Testcontainers — never a mock. Container startup is slow by
// design; correctness beats speed on this path.
export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
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
      // Raised after the request-validation spec landed. Measured 2026-08-04:
      // statements 35.2, branches 18.9, functions 30.4, lines 36.0. Set a couple of
      // points under.
      thresholds: { lines: 34, functions: 28, branches: 17, statements: 33 },
    },
  },
});
