import { describe, expect, it } from 'vitest';
import { pendingMigrationHint } from './pending-migration';

/**
 * The hint has to be RIGHT more than it has to be present.
 *
 * A wrong "run your migrations" on an unrelated failure is worse than no hint
 * at all: it sends the reader confidently to the one place the problem is not,
 * and they come back distrusting every other line the job prints.
 */
describe('pendingMigrationHint', () => {
  it('fires on a missing table', () => {
    // 42P01, which is what a scheduler hits on a branch nobody migrated.
    expect(pendingMigrationHint({ code: '42P01' })).toContain('npm run db:migrate');
  });

  it('fires on a missing column', () => {
    // 42703 — the same class of problem, and the shape a half-applied migration
    // leaves behind.
    expect(pendingMigrationHint({ code: '42703' })).toContain('npm run db:migrate');
  });

  it('finds the code through the wrapper drizzle puts around it', () => {
    /*
     * The reason the helper looks at `cause` at all. Drizzle throws its own
     * `Failed query: …` error and the SQLSTATE only survives on the original —
     * checking the outer object alone finds nothing on exactly the path this
     * exists for, which is how it would have shipped looking correct.
     */
    const wrapped = Object.assign(new Error('Failed query: select ...'), {
      cause: { code: '42P01' },
    });
    expect(pendingMigrationHint(wrapped)).toContain('npm run db:migrate');
  });

  it('stays silent on a connection failure', () => {
    // The database being down is not the database being behind.
    expect(pendingMigrationHint({ code: 'ECONNREFUSED' })).toBe('');
  });

  it('stays silent on a constraint violation', () => {
    // 23505 is a real bug or a real race — never a pending migration.
    expect(pendingMigrationHint({ code: '23505' })).toBe('');
  });

  it('stays silent on an ordinary error with no code at all', () => {
    expect(pendingMigrationHint(new Error('something else'))).toBe('');
  });

  it('does not throw on null or a non-object', () => {
    // It runs inside a catch block. Throwing here would replace a logged error
    // with an unhandled one.
    expect(pendingMigrationHint(null)).toBe('');
    expect(pendingMigrationHint(undefined)).toBe('');
    expect(pendingMigrationHint('a string')).toBe('');
  });
});
