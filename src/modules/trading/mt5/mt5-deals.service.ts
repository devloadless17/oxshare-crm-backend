import { Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { getDb } from '../../../database/db';
import { mt5Deals, tradingAccounts } from '../../../database/schema';
import type { Mt5DealDto } from './dto/mt5-deal.dto';

/** What ingestion did with a deal. */
export interface IngestResult {
  /** False when we already had this ticket — a normal, expected outcome. */
  ingested: boolean;
  /** True when the login matches no trading account we know about. */
  orphaned: boolean;
}

/**
 * Ingests closed deals from the MT5 bridge.
 *
 * ── Idempotent by the DATABASE, not by a check ─────────────────────────────
 *
 * Every deal arrives at least twice: the bridge pushes it live and its sweep
 * re-reads a rolling 24 hours every five minutes (ARCHITECTURE §3.1). A
 * `SELECT` then `INSERT` would race itself the first time both paths landed
 * together, and that is not rare — it is the design.
 *
 * So the unique index on `mt5_deal_id` carries it, with
 * `onConflictDoNothing()`. The number of affected rows tells us which delivery
 * won, and neither answer is an error.
 *
 * ── An unknown login is STORED, not rejected ───────────────────────────────
 *
 * A deal can arrive before the CRM has linked its `trading_accounts.login` —
 * during onboarding that ordering is normal, not exceptional. Rejecting it would
 * make the bridge retry forever against a condition only a human can clear, and
 * dropping it would lose a real financial event.
 *
 * It is stored and flagged instead, with `commission_processed_at` left NULL.
 * `DealCommissionService` joins on login every run, so a deal ingested before
 * its account was linked accrues as soon as the link exists — no backfill, no
 * replay.
 *
 * ── Ingestion does NOT accrue, and the queue is why ────────────────────────
 *
 * This method's only job is to get the deal into the database and answer the
 * bridge. What it is worth to a partner is decided by `DealCommissionService`,
 * off the request path, for two reasons: the bridge retries anything that is not
 * a 2xx, so slow work here turns into re-delivered deals exactly when the system
 * is already struggling — and the orphan case above simply cannot be resolved at
 * ingest time, because the account may not exist yet.
 *
 * The seam was missing entirely until then: deals landed here and nothing read
 * them, so no trade produced any commission by any route, and every stage of the
 * pipeline reported success while it happened.
 */
@Injectable()
export class Mt5DealsService {
  private readonly logger = new Logger(Mt5DealsService.name);

  async ingest(deal: Mt5DealDto, source: string): Promise<IngestResult> {
    const db = getDb();

    const inserted = await db
      .insert(mt5Deals)
      .values({
        mt5DealId: deal.dealId,
        login: deal.login,
        mt5OrderId: deal.orderId ?? null,
        mt5PositionId: deal.positionId ?? null,
        symbol: deal.symbol,
        action: deal.action,
        entry: deal.entry,
        // Straight through as strings. The bridge already converted from MT5's
        // doubles at the only place that conversion belongs; parsing them here
        // would reintroduce the float this whole path exists to avoid.
        volume: deal.volume,
        price: deal.price,
        profit: deal.profit,
        commission: deal.commission,
        swap: deal.swap,
        comment: deal.comment ?? null,
        dealtAt: new Date(deal.dealtAt),
        source,
      })
      .onConflictDoNothing({ target: mt5Deals.mt5DealId })
      .returning({ id: mt5Deals.id });

    if (inserted.length === 0) {
      // The duplicate case, and the common one. Logged at debug: at one sweep
      // every five minutes over a 24-hour window, an info line here would be
      // most of the log.
      this.logger.debug(`Deal ${deal.dealId} already ingested (${source})`);
      return { ingested: false, orphaned: false };
    }

    const [account] = await db
      .select({ id: tradingAccounts.id })
      .from(tradingAccounts)
      .where(eq(tradingAccounts.login, deal.login))
      .limit(1);

    if (!account) {
      this.logger.warn(
        `Ingested deal ${deal.dealId} for login ${deal.login}, which matches no trading account. ` +
          'Stored anyway — it will be picked up once the account is linked.',
      );
      return { ingested: true, orphaned: true };
    }

    this.logger.log(`Ingested deal ${deal.dealId} for login ${deal.login} (${source})`);
    return { ingested: true, orphaned: false };
  }
}
