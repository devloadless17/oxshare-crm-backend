import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { ScheduledJob } from '../../../common/scheduling/scheduled-job.decorator';
import { JobLeaseService } from '../../../common/scheduling/job-lease.service';
import { DRIZZLE_DB } from '../../../database/database.module';
import type { Db } from '../../../database/db';
import { transactions } from '../../../database/schema';
import { PaymentProviderRegistry } from '../providers/payment-provider-registry';
import type { PaymentProviderAdapter } from '../providers/payment-provider';
import { HostedDepositsService } from './hosted-deposits.service';
import { PayoutEngine } from './payout-engine.service';
import { ProviderBalanceWatch } from './provider-balance-watch.service';
import { ProviderRecordsAudit } from './provider-records-audit.service';
import { ProviderBooks } from './provider-books.service';

/**
 * THE POLL BEHIND EVERY PROVIDER'S WEBHOOK — the sweep half of push + sweep
 * (0173; Rival's own poller before it).
 *
 * Webhooks are at-least-once and then gone: a deploy window, a key rotated a
 * minute early, a delivery eaten by a proxy — each is a client who paid and
 * holds no balance, or a payout the desk thinks is still travelling. This
 * makes that self-healing: for every provider, the deposit engine and the
 * payout engine ask the provider what it holds, through the SAME idempotent
 * paths the webhook uses, so the two race freely and the database decides.
 *
 * ## Which providers, and why "switched off" is not "skip"
 *
 * A provider switched off takes no NEW money, but money it already holds must
 * still settle (the approved design, 0168): a deposit link the client paid, a
 * payout it was sent. So a provider is swept while it is usable OR while any
 * movement on it is still open; the payout engine sends nothing new unless it
 * is usable.
 *
 * ## One instance per provider, every provider at once
 *
 * Every step is idempotent, so the lease is about COST: several replicas
 * polling one provider for the same rows multiply the traffic against APIs
 * that rate-limit. Each provider has its own lease AND runs alongside the
 * others, so one slow provider (3pay paces itself to 60 reads a minute) does
 * not hold the others.
 *
 * ## After the money: what the provider holds
 *
 * Once its movements are settled, a usable provider's prefunded balance is
 * read once and compared with our books (`ProviderBooks`, 0175) and with the
 * payouts waiting on it (`ProviderBalanceWatch`), and its own records are
 * audited (`ProviderRecordsAudit`: anything there that no transaction explains
 * is raised). None of them moves money.
 *
 * A sweep that fails is "unchecked, not known-bad": logged at error, not paged
 * — the webhook remains the primary path.
 */
@Injectable()
export class ProviderReconcileScheduler {
  private readonly logger = new Logger(ProviderReconcileScheduler.name);

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Db,
    private readonly registry: PaymentProviderRegistry,
    private readonly deposits: HostedDepositsService,
    private readonly payouts: PayoutEngine,
    private readonly leases: JobLeaseService,
    private readonly records: ProviderRecordsAudit,
    private readonly balances: ProviderBalanceWatch,
    private readonly books: ProviderBooks,
  ) {}

  @ScheduledJob('payments.reconcileProviders')
  async sweep(): Promise<void> {
    const results = await Promise.allSettled(
      this.registry
        .list()
        .filter((adapter) => !adapter.builtIn)
        .map(async (adapter) => {
          if (!(await this.worthSweeping(adapter))) return;
          await this.leases.run(`payments.reconcile:${adapter.code}`, 10 * 60_000, () =>
            this.runOnce(adapter),
          );
        }),
    );
    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.error(`A provider reconcile did not run: ${messageOf(result.reason)}`);
      }
    }
  }

  /** Reconcile one provider now — the scheduled sweep's unit, for a person or a spec. */
  async runOnce(adapter: PaymentProviderAdapter): Promise<void> {
    let depositsSwept = false;
    try {
      depositsSwept = (await this.deposits.sweep(adapter.code)).complete;
    } catch (error) {
      this.logger.error(
        `${adapter.name} deposit sweep did not complete — open deposits are UNCHECKED this ` +
          `round, not known-bad; the webhook remains live. ${messageOf(error)}`,
      );
    }
    try {
      await this.payouts.reconcile(adapter.code);
    } catch (error) {
      this.logger.error(
        `${adapter.name} payout reconcile did not complete — payouts in flight are UNCHECKED ` +
          `this round, not known-bad. ${messageOf(error)}`,
      );
    }
    if (!(await adapter.isUsable())) return;
    if (adapter.balance) {
      try {
        /*
         * Read right after the sweeps, before the records audit pages through
         * the provider's lists: the books can start only on a reading taken
         * while what the sweeps just learned is still the whole story. One read
         * serves both the books (§6.5 step 3) and the payout funds warning.
         */
        const readAt = new Date();
        const balance = await adapter.balance();
        await this.books.check(adapter, { balance, readAt }, depositsSwept);
        await this.balances.check(adapter, balance);
      } catch (error) {
        this.logger.warn(`${adapter.name} balance could not be checked: ${messageOf(error)}`);
      }
    }
    try {
      await this.records.run(adapter);
    } catch (error) {
      this.logger.error(`${adapter.name} records audit did not complete: ${messageOf(error)}`);
    }
  }

  private async worthSweeping(adapter: PaymentProviderAdapter): Promise<boolean> {
    if (await adapter.isUsable()) return true;
    // Switched off or not set up: only while money on it is still open.
    const [open] = await this.db
      .select({ one: sql<number>`1` })
      .from(transactions)
      .where(
        and(
          eq(transactions.providerCode, adapter.code),
          inArray(transactions.state, ['pending', 'approved']),
        ),
      )
      .limit(1);
    return open !== undefined;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
