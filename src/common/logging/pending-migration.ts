/**
 * "This job failed because the database is behind the code."
 *
 * ## Why this exists
 *
 * A scheduler whose table does not exist yet fails on a timer, and Postgres's
 * own message is `relation "mt5_groups" does not exist` wrapped in the driver's
 * full SQL text. That is accurate and almost useless: it names a table nobody
 * asked for by name, prints the entire query, and repeats every minute. The
 * first person to see it goes looking for a bug in the query.
 *
 * The actual cause is almost always the same one — a branch was pulled and
 * `npm run db:migrate` was not run — and it has a one-line fix. Saying so at
 * the point of failure turns a confusing recurring error into an instruction.
 *
 * ## Matched on the SQLSTATE, not on the message
 *
 * `42P01` is undefined_table and `42703` is undefined_column; both are exactly
 * "the schema does not have what this code expects". Matching on the text
 * instead would break on a Postgres locale or a driver that reformats, and
 * would risk claiming a migration is pending when something else went wrong —
 * which is worse than saying nothing, because it sends the reader to the one
 * place the problem is not.
 */
const SCHEMA_BEHIND_CODE = new Set(['42P01', '42703']);

/**
 * A short hint to append to an error line, or an empty string when the failure
 * was not a schema mismatch.
 *
 * Returns a string rather than logging, so the caller keeps ownership of its
 * own message and the hint reads as part of one sentence rather than as a
 * second, unattributed line.
 */
export function pendingMigrationHint(error: unknown): string {
  /*
   * The code can be on the error or on its `cause`: drizzle wraps the driver's
   * error in its own `Failed query: …`, and the SQLSTATE only survives on the
   * original. Checking just the outer object finds nothing on exactly the path
   * this helper exists for.
   */
  const codeOf = (value: unknown): string | undefined =>
    typeof value === 'object' && value !== null && 'code' in value
      ? String((value).code)
      : undefined;

  const code = codeOf(error) ?? codeOf((error as { cause?: unknown } | null | undefined)?.cause);

  if (!code || !SCHEMA_BEHIND_CODE.has(code)) return '';

  return (
    ' — the database is missing a table or column this code expects, which means ' +
    'migrations are pending. Run `npm run db:migrate`.'
  );
}
