import { Inject, Injectable, Logger } from '@nestjs/common';
import Decimal from 'decimal.js';
import { and, eq, isNull } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../../database/database.module';
import type { Db } from '../../../database/db';
import { transactions } from '../../../database/schema';
import { ALERT_KINDS, raiseAlert } from '../../../common/logging/alerts';
import { PaymentProviderRegistry } from '../providers/payment-provider-registry';
import type { PaymentProviderAdapter } from '../providers/payment-provider';

/** A standing shortfall is repeated at most this often. */
const REPEAT_MS = 60 * 60_000;

/**
 * THE BALANCE WATCH — a warning BEFORE payouts start failing for want of funds
 * (0174).
 *
 * A provider that pays out of a PREFUNDED balance (3pay: `totalAmt`) refuses a
 * payout it cannot cover, and each refusal becomes a flagged row a person must
 * resend. This compares what the provider holds with what the payouts approved
 * and not yet sent will ask it to move (each one grossed up by its quote, at
 * par), and pages once an hour while the balance falls short — so the company
 * tops up first, and nothing is refused.
 *
 * Reads and pages; never holds or changes a payout.
 */
@Injectable()
export class ProviderBalanceWatch {
  private readonly logger = new Logger(ProviderBalanceWatch.name);
  private readonly warnedAt = new Map<string, number>();

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Db,
    private readonly registry: PaymentProviderRegistry,
  ) {}

  async check(adapter: PaymentProviderAdapter, now: number = Date.now()): Promise<void> {
    const rail = adapter.payouts;
    if (!adapter.balance || !rail) return;
    const waiting = await this.db
      .select({
        amount: transactions.amount,
        currency: transactions.currency,
        providerCode: transactions.providerCode,
        channelCode: transactions.channelCode,
      })
      .from(transactions)
      .where(
        and(
          eq(transactions.providerCode, adapter.code),
          eq(transactions.direction, 'withdrawal'),
          eq(transactions.state, 'approved'),
          isNull(transactions.providerPayoutId),
          isNull(transactions.providerSubmittedAt),
        ),
      );
    if (waiting.length === 0) {
      this.warnedAt.delete(adapter.code);
      return;
    }

    let needed = new Decimal(0);
    for (const tx of waiting) {
      const channel = this.registry.findChannel(tx, 'payout');
      if (!channel) continue;
      needed = needed.plus((await rail.quote(channel, tx.amount, tx.currency)).gross);
    }
    const balance = await adapter.balance();
    if (new Decimal(balance.available).gte(needed)) {
      this.warnedAt.delete(adapter.code);
      return;
    }
    if (now - (this.warnedAt.get(adapter.code) ?? 0) < REPEAT_MS) return;
    this.warnedAt.set(adapter.code, now);
    raiseAlert(
      this.logger,
      ALERT_KINDS.PAYMENT_STATE_MISMATCH,
      'page',
      `${adapter.name} holds ${balance.available} ${balance.asset} available, but the ` +
        `${waiting.length} approved payout(s) waiting to be sent need ${needed.toFixed()}. ` +
        `Top up the ${adapter.name} balance, or they will be refused one by one.`,
      {
        provider: adapter.code,
        available: balance.available,
        needed: needed.toFixed(),
        waiting: waiting.length,
      },
    );
  }
}
