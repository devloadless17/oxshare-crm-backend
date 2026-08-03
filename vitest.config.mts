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
  },
});
