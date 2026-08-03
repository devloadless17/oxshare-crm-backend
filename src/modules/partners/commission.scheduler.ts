import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { CommissionService } from './commission.service';

/**
 * §9's `commission.confirm` queue: "Repeatable, 60s — promotes matured accruals".
 *
 * Until BullMQ + Redis land this runs on @nestjs/schedule. That is a deliberate
 * intermediate step, not the destination: a cron in-process cannot survive a
 * restart mid-batch the way a queue can, and it runs on every replica.
 *
 * It is safe to run concurrently regardless, because `confirmMatured` credits
 * inside a transaction and claims each accrual with a conditional update — two
 * replicas racing the same accrual cannot double-pay. `SCHEDULER_ENABLED=false`
 * turns it off for a replica that should not run jobs.
 *
 * Without this, accruals sat at status='accrued' forever and no IB was ever
 * paid — the pipeline was built and never connected to a trigger.
 */
@Injectable()
export class CommissionScheduler {
  private readonly logger = new Logger(CommissionScheduler.name);
  private running = false;

  constructor(
    private readonly commission: CommissionService,
    private readonly config: ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'commission.confirm' })
  async confirmMaturedAccruals(): Promise<void> {
    if (this.config.get('SCHEDULER_ENABLED', 'true') === 'false') return;

    // In-process guard so a slow batch does not overlap itself. Cross-process
    // safety comes from the conditional update, not from this flag.
    if (this.running) {
      this.logger.warn('Previous confirm run still in progress; skipping this tick.');
      return;
    }

    this.running = true;
    try {
      const result = await this.commission.confirmMatured();
      if (result.confirmed > 0 || result.failed > 0) {
        this.logger.log(
          `Confirm run: ${result.confirmed} credited, ${result.failed} failed, ${result.examined} examined.`,
        );
      }
    } catch (error) {
      // Never let a job failure kill the process; the next tick retries.
      this.logger.error(`Confirm run failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
