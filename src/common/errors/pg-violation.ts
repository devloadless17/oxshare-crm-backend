/**
 * Did this error come from Postgres refusing a write on ONE named constraint?
 *
 * For the places where a constraint IS the decision — the payments core's
 * fingerprint lock refuses a second unresolved identical payout by index, and
 * the caller must tell that apart from any other failure. Matching the
 * constraint by NAME, never by message text.
 *
 * drizzle-orm wraps the driver's error in its own `Failed query: …` Error and
 * moves the original to `cause` (see `pgErrorCode` in all-exceptions.filter.ts
 * for how that once turned every unique violation into a 500), so the chain is
 * walked rather than the top error read.
 */
export function violatesConstraint(error: unknown, constraint: string, code = '23505'): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth += 1) {
    if (typeof current !== 'object') return false;
    const candidate = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (candidate.code === code && candidate.constraint === constraint) return true;
    current = candidate.cause;
  }
  return false;
}

/**
 * Did Postgres refuse this write as a unique violation (23505) on ANY
 * constraint? Walks the same cause chain as `violatesConstraint`. Prefer that
 * one wherever the constraint is known.
 */
export function isUniqueViolation(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth += 1) {
    if (typeof current !== 'object') return false;
    const candidate = current as { code?: unknown; cause?: unknown };
    if (candidate.code === '23505') return true;
    current = candidate.cause;
  }
  return false;
}
