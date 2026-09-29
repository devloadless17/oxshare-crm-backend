import { Inject, Injectable, Logger } from '@nestjs/common';
import { ScheduledJob } from '../../../common/scheduling/scheduled-job.decorator';
import { and, eq, isNotNull, lt } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../../database/database.module';
import type { Db } from '../../../database/db';
import { transactions } from '../../../database/schema';
import { TransactionsService } from '../transactions.service';
import { RivalClient } from './rival.client';
import { RivalConfigService } from './rival-config.service';
import { RivalWithdrawalsService } from './rival-withdrawals.service';
import { JobLeaseService } from '../../../common/scheduling/job-lease.service';

/**
 * The poll backstop behind Rival's webhook — the sweep half of push + sweep.
 *
 * Webhooks are at-least-once with SIX attempts over ~7.5 hours, and then the
 * event is gone. A CRM that was down for a deploy window, a webhook key
 * rotated a minute before an event fired, a delivery eaten by a proxy — every
 * one of those is a client who paid and holds no balance. This sweep makes
 * that state self-healing: everything it finds converges on the SAME
 * idempotent settle path the webhook uses, so the two can race freely and the
 * ledger constraint decides.
 *
 * Three populations, all bounded per sweep:
 *
 *  1. Pending deposits WITH a Rival id, quiet for 2+ minutes — ask Rival's
 *     stored state (cheap) and settle what it answers.
 *  2. The same rows once they are 30+ minutes old — one `/refresh` first,
 *     which makes Rival re-ask Whish itself: the recovery for a callback
 *     RIVAL missed, per its own integration doc.
 *  3. Pending deposits WITHOUT a Rival id — the create never confirmed. The
 *     create is REPLAYED under the same idempotency key, which Rival resolves
 *     to the original payment if one exists and mints it if none does; either
 *     way the row gains its id and rejoins population 1.
 *
 * A per-row failure logs and moves on: one unreachable payment must not
 * shield the other forty-nine. A sweep skipped because Rival is down is
 * "unchecked, not known-bad" — the webhook remains the primary path, so this
 * logs at error and does not page.
 *
 * (Slice 3 adds the withdrawal sweep: approved rows with a Rival withdrawal
 * id, and claimed-but-unrecorded submissions adopted by notes-match.)
 */
const QUIET_MS = 2 * 60_000;
const REFRESH_AFTER_MS = 30 * 60_000;
const BATCH = 50;

@Injectable()
export class RivalPollScheduler {
  private readonly logger = new Logger(RivalPollScheduler.name);

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Db,
    private readonly config: RivalConfigService,
    private readonly rival: RivalClient,
    private readonly transactions: TransactionsService,
    private readonly withdrawals: RivalWithdrawalsService,
    private readonly leases: JobLeaseService,
  ) {}

  @ScheduledJob('rival.reconcile')
  async sweep(): Promise<void> {
    if (!(await this.config.isEnabled())) return;

    /*
     * ONE INSTANCE. Every settle this reaches is idempotent — it shares the
     * webhook's path, which is why "the two can race freely" — so this is about
     * cost: four replicas polling Rival for the same pending deposits is four
     * times the provider traffic for one answer, against an API that rate-limits.
     */
    await this.leases.run('rival.reconcile', 10 * 60_000, () => this.runOnce());
  }

  private async runOnce(): Promise<void> {
    try {
      await this.sweepDeposits();
    } catch (error) {
      this.logger.error(
        `Rival deposit sweep did not complete — pending deposits are UNCHECKED this round, ` +
          `not known-bad; the webhook remains live. ${
            error instanceof Error ? error.message : String(error)
          }`,
      );
    }
    try {
      // Orphan adoption (the no-idempotency-key defence) + decided-poll.
      await this.withdrawals.reconcile();
    } catch (error) {
      this.logger.error(
        `Rival withdrawal reconcile did not complete — in-flight payouts are UNCHECKED this ` +
          `round, not known-bad. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async sweepDeposits(): Promise<void> {
    const quietBefore = new Date(Date.now() - QUIET_MS);

    const rows = await this.db
      .select({
        id: transactions.id,
        provider: transactions.provider,
        providerRef: transactions.providerRef,
        rivalExternalId: transactions.rivalExternalId,
        createdAt: transactions.createdAt,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.provider, 'whish'),
          eq(transactions.state, 'pending'),
          eq(transactions.direction, 'deposit'),
          lt(transactions.createdAt, quietBefore),
          isNotNull(transactions.providerRef),
        ),
      )
      .limit(BATCH);

    let settled = 0;
    let recovered = 0;
    for (const row of rows) {
      try {
        if (!row.rivalExternalId) {
          if (await this.transactions.recoverRivalExternalId(row.id)) recovered += 1;
          continue;
        }
        if (Date.now() - row.createdAt.getTime() > REFRESH_AFTER_MS) {
          /*
           * The authoritative re-pull: Rival re-asks Whish and settles its
           * OWN side if the callback it was owed never came. Our settle then
           * reads the corrected state. Failures fall through to the plain
           * settle — a refresh Rival refuses must not stop the read.
           */
          try {
            await this.rival.refreshWhishPayment(row.rivalExternalId);
          } catch (error) {
            this.logger.warn(
              `Refresh of Rival payment ${row.rivalExternalId} failed; ` +
                `settling from stored state instead. ${
                  error instanceof Error ? error.message : String(error)
                }`,
            );
          }
        }
        const { state } = await this.transactions.settleGatewayDeposit(
          row.provider,
          row.providerRef ?? '',
        );
        if (state !== 'pending') settled += 1;
      } catch (error) {
        this.logger.error(
          `Sweep could not resolve deposit ${row.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (rows.length > 0) {
      this.logger.log(
        `Rival sweep: ${rows.length} pending deposit(s) checked, ${settled} settled, ` +
          `${recovered} recovered a missing externalId.`,
      );
    }
  }
}
