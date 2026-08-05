import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, lt, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db } from '../../database/db';
import { loginAttempts } from '../../database/schema';
import { ALERT_KINDS, raiseAlert } from '../logging/alerts';
import type { AuthSurface } from './refresh-tokens.service';

/**
 * Per-account lockout on failed sign-ins — PLATFORM-CONVENTIONS R-3.5.
 *
 * `@nestjs/throttler` already limits login to 5 per minute, and that limit is
 * keyed on the IP. It is genuine protection against one attacker on one address
 * and no protection at all against the attack this system actually invites: a
 * distributed run against a single administrator account, from as many rented
 * addresses as the attacker likes. Nothing anywhere counted failures per
 * ACCOUNT, so that run was bounded only by how fast they could source IPs.
 *
 * The throttler is also in-memory and per-process, so its counters reset on
 * every deploy and do not add up across replicas. This does, because it is a
 * table.
 *
 * THREE PROPERTIES THAT MUST SURVIVE ANY LATER TIDY-UP:
 *
 * 1. **Attempts are recorded for identifiers that do not exist.** It would be
 *    natural to look the account up first and skip the bookkeeping when there is
 *    none. That turns "did this address lock out?" into a membership oracle and
 *    gives back exactly what the dummy-hash timing fix in password.service.ts
 *    was added to remove.
 *
 * 2. **The lock expires by itself.** An administrator-cleared lockout is a
 *    denial of service an attacker can trigger for free against any address they
 *    can name — every admin's, all at once, before a real attempt. Self-healing
 *    after fifteen minutes means there is no unlock queue to build and no
 *    support path to socially engineer.
 *
 * 3. **The counter is claimed with one atomic statement**, never read-then-write.
 *    Five concurrent failed logins must produce five failures, not one; a
 *    check-then-insert here is the same class of bug ARCHITECTURE §6 rule 3
 *    forbids on the money path, for the same reason.
 */
@Injectable()
export class LoginAttemptsService {
  private readonly logger = new Logger(LoginAttemptsService.name);

  /** R-3.5: five failures per account in fifteen minutes. */
  static readonly MAX_FAILURES = 5;
  static readonly WINDOW_MS = 15 * 60 * 1000;
  static readonly LOCKOUT_MS = 15 * 60 * 1000;

  constructor(@Inject(DRIZZLE_DB) private readonly db: Db) {}

  /**
   * One spelling of an identifier, so `Admin@OxShare.com` and `admin@oxshare.com`
   * cannot hold two independent counters and each stay under the limit.
   */
  private key(identifier: string): string {
    return identifier.trim().toLowerCase();
  }

  /**
   * How long this identifier is locked out for, or null.
   *
   * Returns the remaining time rather than a boolean so the caller can say
   * something useful without computing it again.
   */
  async lockedFor(surface: AuthSurface, identifier: string): Promise<number | null> {
    const [row] = await this.db
      .select({ lockedUntil: loginAttempts.lockedUntil })
      .from(loginAttempts)
      .where(
        and(eq(loginAttempts.surface, surface), eq(loginAttempts.identifier, this.key(identifier))),
      )
      .limit(1);

    if (!row?.lockedUntil) return null;
    const remaining = row.lockedUntil.getTime() - Date.now();
    return remaining > 0 ? remaining : null;
  }

  /**
   * Record a failure and lock the account if it has now had too many.
   *
   * The whole decision is one INSERT ... ON CONFLICT DO UPDATE: the row is
   * created or its counter advanced in a single statement, so concurrent
   * attempts cannot both read "4 failures" and both write "5".
   *
   * The window is enforced by resetting the counter when the last failure is
   * older than WINDOW_MS — five failures spread across a day are a forgetful
   * user, not an attack, and locking them out teaches nobody anything.
   */
  async recordFailure(surface: AuthSurface, identifier: string): Promise<void> {
    const key = this.key(identifier);

    /*
     * Every timestamp comes from the DATABASE clock, not this process's.
     *
     * Partly because it is one source of truth — several API instances with
     * drifting clocks must not each have their own opinion of when a lockout
     * ends. And partly because it is what works: binding a JS `Date` into a raw
     * `sql` fragment sends it through `toString()`, and Postgres was handed
     * `Wed Aug 05 2026 15:16:29 GMT+0300 (Eastern European Summer Time)` where
     * it wanted a timestamptz. Every failed login answered 500 instead of 401.
     */
    const window = sql.raw(`interval '${LoginAttemptsService.WINDOW_MS / 60_000} minutes'`);
    const lockout = sql.raw(`interval '${LoginAttemptsService.LOCKOUT_MS / 60_000} minutes'`);

    const [row] = await this.db
      .insert(loginAttempts)
      .values({ surface, identifier: key, failures: 1 })
      .onConflictDoUpdate({
        target: [loginAttempts.surface, loginAttempts.identifier],
        set: {
          // Start again when the previous failure fell outside the window.
          failures: sql`CASE
            WHEN ${loginAttempts.updatedAt} < now() - ${window} THEN 1
            ELSE ${loginAttempts.failures} + 1
          END`,
          lockedUntil: sql`CASE
            WHEN ${loginAttempts.updatedAt} >= now() - ${window}
             AND ${loginAttempts.failures} + 1 >= ${LoginAttemptsService.MAX_FAILURES}
            THEN now() + ${lockout}
            ELSE NULL
          END`,
          updatedAt: sql`now()`,
        },
      })
      .returning({ failures: loginAttempts.failures, lockedUntil: loginAttempts.lockedUntil });

    if (row?.lockedUntil) {
      /*
       * A security event, not a log line. Repeated lockouts on one admin address
       * are what a stuffing run looks like from the inside, and nobody is
       * watching the request log for a pattern.
       *
       * The identifier is included on purpose: it is the subject of the event
       * and the only thing that makes the alert actionable. It is an email
       * address the caller supplied, never a credential.
       */
      raiseAlert(
        this.logger,
        ALERT_KINDS.LOGIN_LOCKOUT,
        surface === 'admin' ? 'page' : 'notify',
        `${LoginAttemptsService.MAX_FAILURES} failed sign-ins for "${key}" on the ${surface} ` +
          'surface — the account is locked for 15 minutes',
        { surface, identifier: key, failures: row.failures },
      );
    }
  }

  /** A successful sign-in clears the slate for that identifier. */
  async recordSuccess(surface: AuthSurface, identifier: string): Promise<void> {
    await this.db
      .delete(loginAttempts)
      .where(
        and(eq(loginAttempts.surface, surface), eq(loginAttempts.identifier, this.key(identifier))),
      );
  }

  /**
   * Drop rows whose window and lock have both passed.
   *
   * Kept rather than deleted on unlock: the row IS the record that an account
   * was being attacked, and it is worth surviving long enough to be seen.
   */
  async sweepExpired(): Promise<number> {
    const cutoff = new Date(Date.now() - LoginAttemptsService.WINDOW_MS);
    const deleted = await this.db
      .delete(loginAttempts)
      .where(lt(loginAttempts.updatedAt, cutoff))
      .returning({ id: loginAttempts.id });
    return deleted.length;
  }
}
