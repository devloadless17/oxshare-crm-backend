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
 * ## One instance per provider
 *
 * Every step is idempotent, so the lease is about COST: several replicas
 * polling one provider for the same rows multiply the traffic against APIs
 * that rate-limit. Each provider has its own lease, so one slow provider does
 * not hold the others.
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
  ) {}

  @ScheduledJob('payments.reconcileProviders')
  async sweep(): Promise<void> {
    for (const adapter of this.registry.list()) {
      if (adapter.builtIn) continue;
      if (!(await this.worthSweeping(adapter))) continue;
      await this.leases.run(`payments.reconcile:${adapter.code}`, 10 * 60_000, () =>
        this.runOnce(adapter),
      );
    }
  }

  /** Reconcile one provider now — the scheduled sweep's unit, for a person or a spec. */
  async runOnce(adapter: PaymentProviderAdapter): Promise<void> {
    try {
      await this.deposits.sweep(adapter.code);
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
