import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ReconciliationService } from './reconciliation.service';
import { ALERT_KINDS, raiseAlert } from '../../common/logging/alerts';

/**
 * Runs reconciliation against live data, on a schedule.
 *
 * PLATFORM-CONVENTIONS §12.2. The §11 test proves the code balanced against a
 * fixture at commit time. This proves the production ledger balances now — the
 * two are different claims, and only the second one is about the money that
 * actually exists.
 *
 * Hourly, not nightly. A discrepancy is not urgent to REPAIR — the answer is
 * always a diagnosis followed by a compensating entry (§6.4), never a hurried
 * fix — but it is urgent to KNOW, because every hour it goes unnoticed is
 * another hour of writes layered on top of a ledger that already disagrees with
 * itself. An hour of exposure is a bounded problem; a night of it is a much
 * larger one to unpick.
 */
@Injectable()
export class ReconciliationScheduler {
  private readonly logger = new Logger(ReconciliationScheduler.name);

  constructor(private readonly reconciliation: ReconciliationService) {}

  @Cron(CronExpression.EVERY_HOUR, { name: 'wallet.reconcile' })
  async reconcile(): Promise<void> {
    try {
      await this.reconciliation.run();
    } catch (error) {
      /*
       * A failed CHECK is not a failed ledger, and must not read like one.
       *
       * The message says so explicitly, because the alert this raises will be
       * read at 3am by someone who needs to know in one line whether money is
       * wrong or whether a query timed out.
       */
      raiseAlert(
        this.logger,
        ALERT_KINDS.RECONCILIATION_UNAVAILABLE,
        'notify',
        'The reconciliation job could not run — the ledger is unchecked, not known-good',
      );
      this.logger.error(
        'Reconciliation could not RUN (this is not itself a discrepancy — the ledger has not ' +
          `been checked, which is its own problem): ${
            error instanceof Error ? error.message : String(error)
          }`,
      );
    }
  }
}
