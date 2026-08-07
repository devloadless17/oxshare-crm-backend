import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CommissionService } from './commission.service';

/**
 * Pays out matured commission accruals, on a schedule.
 *
 * ## Why a job rather than crediting at accrual time
 *
 * `CommissionService` writes `pending` rows when a deposit settles and moves no
 * money. This is what turns them into balance. The separation is deliberate —
 * see the service's own note — because a commission is earned at one moment and
 * payable at another, and crediting both at once makes every commission
 * irreversible before the revenue behind it is final.
 *
 * ## Hourly, and safe to run on every instance
 *
 * The work is idempotent all the way down: each credit is guarded by
 * `ledger_entries_wallet_reference_uq` and each status write is conditional on
 * the row still being `pending`. Two schedulers racing over the same accrual
 * cannot both pay it — the second finds nothing to update and `post` returns the
 * original entry rather than a second credit.
 *
 * That is what makes this safe to keep as a `@Cron` today and safe to move onto
 * BullMQ later without changing the logic: at-least-once delivery is already the
 * assumption.
 *
 * ## A failure here is not urgent, and the log says so
 *
 * An unpaid accrual is money still owed and still recorded — the row survives
 * and the next run retries it. That is a materially smaller problem than the
 * reconciliation job failing, which leaves the ledger UNCHECKED, so this logs
 * rather than raising an alert.
 */
@Injectable()
export class CommissionScheduler {
  private readonly logger = new Logger(CommissionScheduler.name);

  constructor(private readonly commissions: CommissionService) {}

  @Cron(CronExpression.EVERY_HOUR, { name: 'ib.confirmAccruals' })
  async confirm(): Promise<void> {
    try {
      const { confirmed, failed } = await this.commissions.confirmPending();
      if (failed > 0) {
        this.logger.warn(
          `${failed} commission accrual(s) could not be credited and remain pending; they will be ` +
            'retried on the next run. Nothing is lost — the accrual rows are the record.',
        );
      }
      if (confirmed > 0) {
        this.logger.log(`Credited ${confirmed} commission accrual(s).`);
      }
    } catch (error) {
      /*
       * The batch method already isolates per-accrual failures, so reaching here
       * means the RUN itself could not start — a database outage rather than a
       * bad row. Every accrual stays pending, which is the correct state.
       */
      this.logger.error(
        'The commission confirm job could not RUN. Every accrual remains pending and payable on ' +
          `the next run: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
