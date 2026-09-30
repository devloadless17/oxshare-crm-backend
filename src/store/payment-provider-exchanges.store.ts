import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, lt, sql } from 'drizzle-orm';
import { DRIZZLE_DB } from '../database/database.module';
import type { Db } from '../database/db';
import { paymentProviderExchanges } from '../database/schema';

type ExchangeRow = typeof paymentProviderExchanges.$inferSelect;

/** How much of a body is kept — every 3pay answer fits many times over. */
const BODY_MAX = 64 * 1024;
/** How long an exchange is kept (3pay's guide: "at least 90 days"); the table's trigger agrees. */
export const EXCHANGE_RETENTION_DAYS = 90;

export interface ExchangeRecord {
  providerCode: string;
  direction: 'outbound' | 'inbound';
  method: string;
  path: string;
  requestBody?: string | null;
  status?: number | null;
  responseBody?: string | null;
  error?: string | null;
  durationMs?: number | null;
  reference?: string | null;
}

/**
 * WHAT A PROVIDER WAS ASKED AND WHAT IT ANSWERED (0175) — every call out and
 * every delivery in, kept 90 days (3pay's guide, §10: "Log every 3pay API
 * request/response for at least 90 days for audit and reconciliation").
 *
 * It never holds a credential (they travel in headers, which are not kept)
 * or a webhook's signature. The table is append-only by trigger; the daily
 * prune removes only what is past its 90 days.
 *
 * `record` NEVER throws and is never awaited by a money path: a log that
 * could fail a payout would be worse than a gap in the log. A failure is
 * loud in the server log instead.
 */
@Injectable()
export class PaymentProviderExchangesStore {
  private readonly logger = new Logger(PaymentProviderExchangesStore.name);

  constructor(@Inject(DRIZZLE_DB) private readonly db: Db) {}

  record(entry: ExchangeRecord): void {
    void this.db
      .insert(paymentProviderExchanges)
      .values({
        providerCode: entry.providerCode,
        direction: entry.direction,
        method: entry.method.slice(0, 10),
        path: entry.path.slice(0, 512),
        requestBody: clip(entry.requestBody),
        status: entry.status ?? null,
        responseBody: clip(entry.responseBody),
        error: entry.error ? entry.error.slice(0, 500) : null,
        durationMs: entry.durationMs ?? null,
        reference: entry.reference ? entry.reference.slice(0, 128) : null,
      })
      .catch((error: unknown) =>
        this.logger.error(
          `Could not record a ${entry.providerCode} ${entry.direction} exchange ` +
            `(${entry.method} ${entry.path}): ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
  }

  /**
   * The newest first, optionally before an id (the next page) and about one
   * reference, at most `limit`.
   */
  list(
    providerCode: string,
    limit: number,
    before?: number,
    reference?: string,
  ): Promise<ExchangeRow[]> {
    return this.db
      .select()
      .from(paymentProviderExchanges)
      .where(
        and(
          eq(paymentProviderExchanges.providerCode, providerCode),
          before !== undefined ? lt(paymentProviderExchanges.id, before) : undefined,
          reference !== undefined ? eq(paymentProviderExchanges.reference, reference) : undefined,
        ),
      )
      .orderBy(desc(paymentProviderExchanges.id))
      .limit(limit);
  }

  /** Remove what is past the retention, in small batches so no lock is held long. */
  async prune(): Promise<number> {
    let removed = 0;
    for (;;) {
      const result = await this.db.execute(sql`
        DELETE FROM payment_provider_exchanges
         WHERE id IN (
           SELECT id FROM payment_provider_exchanges
            WHERE occurred_at < now() - make_interval(days => ${EXCHANGE_RETENTION_DAYS + 1})
            LIMIT 5000)`);
      const count = result.rowCount ?? 0;
      removed += count;
      if (count < 5000) return removed;
    }
  }
}

function clip(body: string | null | undefined): string | null {
  if (body === null || body === undefined) return null;
  return body.length > BODY_MAX ? `${body.slice(0, BODY_MAX)}…[truncated]` : body;
}
