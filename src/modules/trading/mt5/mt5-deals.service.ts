import { Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
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

    // Linked means a CLIENT owns it: an account the MT5 sync found unowned (0166) is not.
    const [account] = await db
      .select({ id: tradingAccounts.id })
      .from(tradingAccounts)
      .where(and(eq(tradingAccounts.login, deal.login), isNotNull(tradingAccounts.userId)))
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

  /**
   * Ingest MANY deals in one round trip — the shape that survives a busy day.
   *
   * ## What this replaces
   *
   * One HTTP request per deal, delivered sequentially by the bridge's outbox:
   * roughly fifty a second once the round trip is counted. A quiet platform
   * never notices. A hundred thousand deals — a volatile hour, a backfill, a
   * bridge that was offline over a weekend — takes over half an hour to hand
   * over, during which the CRM's idea of what has been traded is simply behind.
   * Commission waits on that, and so does every screen that reads from it.
   *
   * The same hundred thousand arrive in two hundred requests of five hundred.
   *
   * ## Why the per-deal endpoint stays
   *
   * It is the live push path, where a single deal wants to arrive NOW rather
   * than wait to be batched with others. Batching is for the sweep, which by
   * definition already has a window's worth in hand.
   *
   * ## Identical semantics, on purpose
   *
   * Same unique ticket, same `onConflictDoNothing`, same "an unknown login is
   * STORED not rejected" rule. A batch is a performance decision and must not
   * become a second, subtly different ingestion path — that is how two
   * behaviours for one event drift until nobody knows which one ran.
   *
   * ## Per-deal outcomes, because the bridge needs them
   *
   * The outbox marks entries delivered INDIVIDUALLY. Answering "the batch
   * worked" would force it to mark all-or-nothing, and one bad row would either
   * strand ninety-nine good deliveries or falsely retire them. So the response
   * says what happened to each ticket, and re-sending ones the CRM already holds
   * is free — ingestion is idempotent by the database, which is exactly what
   * makes batching safe here.
   */
  async ingestBatch(
    deals: Mt5DealDto[],
    source: string,
  ): Promise<{ results: (IngestResult & { dealId: string })[] }> {
    if (deals.length === 0) return { results: [] };

    const db = getDb();

    /*
     * ONE insert for the whole batch. `returning` names the tickets that were
     * actually written, so a duplicate is identified by its ABSENCE rather than
     * by asking the database about it again — the same signal the single-deal
     * path reads from `inserted.length`.
     *
     * A duplicate inside the payload itself would make Postgres raise on the
     * second row of one statement, so the batch is de-duplicated first. The
     * sweep re-reads a rolling window and the outbox can hold the same ticket
     * from both push and sweep, so this is an ordinary input, not a defect.
     */
    const unique = new Map<string, Mt5DealDto>();
    for (const deal of deals) unique.set(deal.dealId, deal);

    const inserted = await db
      .insert(mt5Deals)
      .values(
        [...unique.values()].map((deal) => ({
          mt5DealId: deal.dealId,
          login: deal.login,
          mt5OrderId: deal.orderId ?? null,
          mt5PositionId: deal.positionId ?? null,
          symbol: deal.symbol,
          action: deal.action,
          entry: deal.entry,
          // Strings straight through — see the single-deal path.
          volume: deal.volume,
          price: deal.price,
          profit: deal.profit,
          commission: deal.commission,
          swap: deal.swap,
          comment: deal.comment ?? null,
          dealtAt: new Date(deal.dealtAt),
          source,
        })),
      )
      .onConflictDoNothing({ target: mt5Deals.mt5DealId })
      .returning({ dealId: mt5Deals.mt5DealId });

    const written = new Set(inserted.map((row) => row.dealId));

    /*
     * ONE lookup for every login in the batch, rather than one per deal. At five
     * hundred deals on a busy account that is the difference between a single
     * indexed IN and five hundred round trips — and the orphan answer is a
     * property of the LOGIN, so asking per deal was always redundant.
     */
    const logins = [...new Set([...unique.values()].map((deal) => deal.login))];
    const known = await db
      .select({ login: tradingAccounts.login })
      .from(tradingAccounts)
      .where(and(inArray(tradingAccounts.login, logins), isNotNull(tradingAccounts.userId)));
    const linked = new Set(known.map((row) => row.login));

    const orphanLogins = new Set<string>();
    const results = [...unique.values()].map((deal) => {
      const ingested = written.has(deal.dealId);
      const orphaned = ingested && !linked.has(deal.login);
      if (orphaned) orphanLogins.add(deal.login);
      return { dealId: deal.dealId, ingested, orphaned };
    });

    /*
     * SUMMARISED, not one line per deal. The single-deal path logs each ingest
     * because each is a request; five hundred of those lines would bury the one
     * fact worth reading, which is how many were new.
     *
     * Orphans are named by LOGIN rather than by ticket for the same reason: an
     * unlinked account produces a deal every time it trades, and the account is
     * the thing somebody has to go and fix.
     */
    const newCount = results.filter((r) => r.ingested).length;
    this.logger.log(
      `Ingested ${newCount} of ${unique.size} deal(s) in one batch (${source}); ` +
        `${unique.size - newCount} already held.`,
    );

    if (orphanLogins.size > 0) {
      this.logger.warn(
        `${orphanLogins.size} MT5 login(s) in this batch match no trading account: ` +
          `${[...orphanLogins].join(', ')}. Their deals are stored and accrue once linked.`,
      );
    }

    return { results };
  }
}
