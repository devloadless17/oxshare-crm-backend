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
      // Measured 2026-08-04: statements 33.7, branches 17.3, functions 28.9,
      // lines 34.3. Set a couple of points under.
      thresholds: { lines: 32, functions: 26, branches: 15, statements: 31 },
    },
  },
});
