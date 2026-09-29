import { Inject, Injectable, Logger } from '@nestjs/common';
import { desc, eq, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.module';
import type { Db } from '../database/db';
import { paymentProviderEvents } from '../database/schema';

export type PaymentProviderEventRow = typeof paymentProviderEvents.$inferSelect;

/**
 * What a provider reported, in the platform's one vocabulary — whatever the
 * provider itself calls it (`provider_type` keeps that).
 */
export type ProviderEventType =
  | 'payment.pending'
  | 'payment.succeeded'
  | 'payment.failed'
  | 'payment.reversed'
  | 'payout.submitted'
  | 'payout.completed'
  | 'payout.rejected'
  | 'payout.cancelled';

/**
 * What the platform did about it:
 *   applied  — it moved the transaction;
 *   ignored  — nothing to do (a duplicate, a stale report, an echo of our own);
 *   rejected — not applied automatically: a person must decide (it now needs attention);
 *   failed   — could not be applied yet, and the provider or the poller will try again.
 */
export type ProviderEventOutcome = 'applied' | 'ignored' | 'rejected' | 'failed';

export type ProviderEventSource = 'webhook' | 'poll' | 'desk';

export interface ProviderEventRecord {
  providerCode: string;
  eventType: ProviderEventType;
  /**
   * The provider's id for the payment or payout the event is about. With the
   * type it is the event's identity (`payment.succeeded:<id>`), so the same fact
   * reported twice — a retried webhook, then the poller — is ONE row.
   */
  subjectId: string;
  providerType?: string | null;
  source: ProviderEventSource;
  transactionId?: string | null;
  outcome: ProviderEventOutcome;
  reason?: string | null;
}

/**
 * The payment provider event log (`payment_provider_events`, 0168): every
 * webhook and poll result, with what the platform did about it. A provider's
 * page lists its recent events; a transaction's timeline lists its own.
 *
 * ## One row per fact, by constraint
 *
 * `UNIQUE(provider_code, event_key)`, where the key is the normalised type plus
 * the provider's id for the subject. A duplicate is a no-op, never a second
 * row. The one exception is a `failed` row: it is retried, so the retry's
 * outcome replaces it and the log shows how it ended, not how it began.
 *
 * ## It never breaks what it records
 *
 * `append` swallows its own failures and logs them. The money has already moved
 * (or deliberately not) by the time it is called, and it runs on its own
 * connection, never inside a caller's transaction — where one failed INSERT
 * would abort the whole transaction and roll the money back with it.
 */
@Injectable()
export class PaymentProviderEventsStore {
  private readonly logger = new Logger(PaymentProviderEventsStore.name);

  constructor(@Inject(DRIZZLE_DB) private readonly db: Db) {}

  async append(event: ProviderEventRecord): Promise<void> {
    const row = {
      providerCode: event.providerCode,
      eventKey: `${event.eventType}:${event.subjectId}`.slice(0, 200),
      eventType: event.eventType,
      providerType: event.providerType?.slice(0, 100) ?? null,
      source: event.source,
      transactionId: event.transactionId ?? null,
      outcome: event.outcome,
      reason: event.reason?.slice(0, 500) ?? null,
    };
    try {
      await this.db
        .insert(paymentProviderEvents)
        .values(row)
        .onConflictDoUpdate({
          target: [paymentProviderEvents.providerCode, paymentProviderEvents.eventKey],
          set: {
            outcome: row.outcome,
            reason: row.reason,
            source: row.source,
            providerType: row.providerType,
            transactionId: sql`COALESCE(${row.transactionId}::uuid, ${paymentProviderEvents.transactionId})`,
            receivedAt: sql`now()`,
          },
          setWhere: eq(paymentProviderEvents.outcome, 'failed'),
        });
    } catch (error) {
      this.logger.warn(
        `Could not record ${row.providerCode} event ${row.eventKey} (${row.outcome}): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** A provider's latest events — its page's "Recent events". */
  recent(providerCode: string, limit: number): Promise<PaymentProviderEventRow[]> {
    return this.db
      .select()
      .from(paymentProviderEvents)
      .where(eq(paymentProviderEvents.providerCode, providerCode))
      .orderBy(desc(paymentProviderEvents.receivedAt))
      .limit(limit);
  }

  /** Every event about one transaction, oldest first — its timeline. */
  forTransaction(transactionId: string): Promise<PaymentProviderEventRow[]> {
    return this.db
      .select()
      .from(paymentProviderEvents)
      .where(eq(paymentProviderEvents.transactionId, transactionId))
      .orderBy(paymentProviderEvents.receivedAt);
  }
}
