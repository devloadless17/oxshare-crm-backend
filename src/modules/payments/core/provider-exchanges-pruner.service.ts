import { Injectable, Logger } from '@nestjs/common';
import { JobLeaseService } from '../../../common/scheduling/job-lease.service';
import { ScheduledJob } from '../../../common/scheduling/scheduled-job.decorator';
import {
  EXCHANGE_RETENTION_DAYS,
  PaymentProviderExchangesStore,
} from '../../../store/payment-provider-exchanges.store';

/**
 * Removes what the providers were asked and answered once it is past its 90
 * days (0175) — the only deletion the exchanges table's trigger allows.
 */
@Injectable()
export class ProviderExchangesPruner {
  private readonly logger = new Logger(ProviderExchangesPruner.name);

  constructor(
    private readonly exchanges: PaymentProviderExchangesStore,
    private readonly leases: JobLeaseService,
  ) {}

  @ScheduledJob('payments.pruneExchanges')
  async prune(): Promise<void> {
    await this.leases.run('payments.pruneExchanges', 30 * 60_000, async () => {
      const removed = await this.exchanges.prune();
      if (removed > 0) {
        this.logger.log(
          `Removed ${removed} provider exchange(s) older than ${EXCHANGE_RETENTION_DAYS} days.`,
        );
      }
    });
  }
}
