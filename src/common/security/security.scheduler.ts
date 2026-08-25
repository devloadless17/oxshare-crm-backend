import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { lt } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db } from '../../database/db';
import { idempotencyKeys } from '../../database/schema';
import { IDEMPOTENCY_RETENTION_HOURS } from './idempotency.interceptor';
import { RefreshTokensService } from './refresh-tokens.service';
import { LoginAttemptsService } from './login-attempts.service';
import { JobLeaseService } from '../scheduling/job-lease.service';

/**
 * Retention sweeps for the two tables this milestone added.
 *
 * Both were built with a documented retention window and neither had anything
 * calling it — a sweep method nobody schedules is a comment, and the tables grow
 * without bound until someone notices at 3am. Wiring it here is the difference.
 *
 * Deliberately conservative about WHAT is deleted:
 *
 *  - Idempotency keys go once no plausible retry could still arrive. Deleting
 *    one early turns a replay back into a fresh request, which on a withdrawal
 *    endpoint means a second withdrawal.
 *  - Refresh tokens go at EXPIRY, not at first use. The row is the record that a
 *    token was already rotated, so removing it early downgrades a detectable
 *    replay (R-3.3) into a plain "unknown token" — losing exactly the signal the
 *    family design exists to produce.
 *
 * Hourly rather than per-minute: neither table is large enough for the delay to
 * matter, and a sweep that runs constantly is a lock-contention source on tables
 * the login path writes to.
 */
@Injectable()
export class SecurityScheduler {
  private readonly logger = new Logger(SecurityScheduler.name);

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Db,
    private readonly refreshTokens: RefreshTokensService,
    private readonly loginAttempts: LoginAttemptsService,
    private readonly leases: JobLeaseService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR, { name: 'security.sweep' })
  async sweep(): Promise<void> {
    /*
     * ONE INSTANCE. Cheap and idempotent, so a duplicate run is harmless — but
     * "harmless" is not free: on four replicas it is four times the queries for
     * one result, and a job nobody leases is a job that quietly stops being
     * counted when the estate grows. Every scheduled job on this platform now
     * runs once per tick; the exceptions were the ones people forget.
     */
    await this.leases.run('security.sweep', 30 * 60_000, () => this.sweepOnce());
  }

  private async sweepOnce(): Promise<void> {
    await Promise.all([
      this.sweepIdempotencyKeys(),
      this.sweepRefreshTokens(),
      this.sweepLoginAttempts(),
    ]);
  }

  private async sweepLoginAttempts(): Promise<void> {
    try {
      const deleted = await this.loginAttempts.sweepExpired();
      if (deleted > 0) {
        this.logger.log(`Swept ${deleted} stale login-attempt counter(s)`);
      }
    } catch (error) {
      this.logger.error(
        `Login attempt sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async sweepIdempotencyKeys(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - IDEMPOTENCY_RETENTION_HOURS * 60 * 60 * 1000);
      const deleted = await this.db
        .delete(idempotencyKeys)
        .where(lt(idempotencyKeys.createdAt, cutoff))
        .returning({ id: idempotencyKeys.id });

      if (deleted.length > 0) {
        this.logger.log(
          `Swept ${deleted.length} idempotency key(s) older than the retention window`,
        );
      }
    } catch (error) {
      // A failed sweep is housekeeping, never a reason to take the process down.
      // It retries in an hour; the only cost of missing one is a slightly larger
      // table.
      this.logger.error(
        `Idempotency key sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async sweepRefreshTokens(): Promise<void> {
    try {
      const deleted = await this.refreshTokens.sweepExpired();
      if (deleted > 0) {
        this.logger.log(`Swept ${deleted} expired refresh token(s)`);
      }
    } catch (error) {
      this.logger.error(
        `Refresh token sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
