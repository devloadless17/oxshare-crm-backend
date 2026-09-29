import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../../database/database.module';
import type { Db } from '../../../database/db';
import { tradingAccounts } from '../../../database/schema';
import { Mt5LivePublisher, type Mt5LiveEvent } from './live-snapshot';
import { Mt5AccountSyncService } from './mt5-account-sync.service';
import { positionSideLabel } from './position-side';
import type { Mt5LiveDto } from './dto/mt5-live.dto';

/**
 * How often ONE account's live reading is allowed to refresh the balance mirror.
 *
 * The live loop reads a watched account every round — potentially several times
 * a second — and the mirrored `trading_accounts.balance` is a column read by
 * screens, not a tick feed. Writing every reading would be an UPDATE per second
 * per watched account for a value that moves only when a deal closes.
 *
 * Thirty seconds is far fresher than the path this supplements (a five-minute
 * sweep, twice over) and far quieter than the feed it rides on. It is a write
 * BUDGET, not a staleness target: the guard inside `recordFromOperation` decides
 * whether any given write actually lands.
 */
const MIRROR_WRITE_INTERVAL_MS = 30_000;

/**
 * Stop the throttle map growing into every account ever watched.
 *
 * Entries are only useful for `MIRROR_WRITE_INTERVAL_MS`; past that the next
 * reading writes regardless. Pruning on a size trigger rather than a timer keeps
 * this free in the common case — a handful of accounts watched at once never
 * reaches it.
 */
const THROTTLE_PRUNE_AT = 500;

export interface LiveIngestResult {
  /** False when nothing was announced. `reason` says why. */
  delivered: boolean;
  reason?: 'unknown-login';
}

/**
 * Turning one live MT5 reading into an event addressed to its owner.
 *
 * ── This is a ROUTING step, and that is all it is ──────────────────────────
 *
 * Nothing here is written down. The bridge read MT5, this finds out whose
 * account that login is, and the reading goes out on a Postgres channel to
 * whichever socket that client has open. Equity and floating P/L are recomputed
 * from prices on every tick, so storing one would produce exactly the stale
 * figure wearing a fresh label that `/accounts/[id]` exists to prevent — see
 * `Mt5AccountSnapshotDto`, which refuses these same fields for that reason.
 *
 * The balance mirror is deliberately NOT updated from here either, even though
 * the reading carries a balance. That column is the sweep's, guarded on read
 * times so a late delivery cannot move it backwards, and writing to it from a
 * path that fires several times a second per watched account would be a write
 * storm in exchange for a number the sweep already maintains correctly.
 *
 * ── An unknown login is an ordinary answer ─────────────────────────────────
 *
 * The broker's server carries accounts this CRM never opened, and a client can
 * have a page open for an account that has since been closed. Neither is an
 * error and neither is retried: the bridge treats a live reading as a
 * latest-value observation and simply sends a fresher one next round.
 */
@Injectable()
export class Mt5LiveService {
  private readonly logger = new Logger(Mt5LiveService.name);

  /**
   * Login → when its balance was last written to the mirror by THIS instance.
   *
   * Per-instance rather than shared, deliberately. The API runs on more than one
   * node, so N instances may each write once per window — which is N harmless
   * UPDATEs guarded by a read-time comparison, and cheaper than coordinating a
   * distributed throttle for a column the sweep would have written anyway.
   */
  private readonly mirroredAt = new Map<string, number>();

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Db,
    private readonly publisher: Mt5LivePublisher,
    /*
     * The mirror's writer, so the freshest balance in the system stops being
     * discarded — see `mirrorBalance`. Through the service rather than an inline
     * UPDATE because it owns the staleness guard that stops a late reading
     * moving a balance backwards.
     */
    private readonly accountSync: Mt5AccountSyncService,
  ) {}

  async ingest(reading: Mt5LiveDto): Promise<LiveIngestResult> {
    const [account] = await this.db
      .select({ id: tradingAccounts.id, userId: tradingAccounts.userId })
      .from(tradingAccounts)
      .where(eq(tradingAccounts.login, reading.login))
      .limit(1);

    /*
     * An account with NO client (0166, found by the MT5 sync) is treated as
     * unknown here. The room name IS the owner, so an ownerless reading would be
     * emitted into `client:null` — a room somebody could join.
     */
    if (!account || account.userId === null) {
      this.logger.debug(`Live reading for MT5 ${reading.login} names no client's account; ignored`);
      return { delivered: false, reason: 'unknown-login' };
    }

    const event: Mt5LiveEvent = {
      userId: account.userId,
      accountId: account.id,
      currency: reading.currency,
      balance: reading.balance,
      equity: reading.equity,
      credit: reading.credit,
      margin: reading.margin,
      marginFree: reading.marginFree,
      marginLevel: reading.marginLevel ?? null,
      readAt: reading.readAt,
      positions: reading.positions.map((position) => ({
        ticket: position.ticket,
        symbol: position.symbol,
        action: position.action,
        /*
         * Named HERE, exactly as `positionsMine` names it, because the table
         * renders the label rather than the code. Sending the number alone is
         * what emptied the Side column on every pushed row.
         */
        side: positionSideLabel(position.action),
        volume: position.volume,
        priceOpen: position.priceOpen,
        priceCurrent: position.priceCurrent,
        stopLoss: position.stopLoss ?? null,
        takeProfit: position.takeProfit ?? null,
        profit: position.profit,
        swap: position.swap,
        commission: position.commission ?? null,
        comment: position.comment ?? null,
        openedAt: position.openedAt,
      })),
    };

    await this.publisher.publish(event);

    /*
     * ── AND WRITE THE BALANCE THROUGH ────────────────────────────────────
     *
     * AFTER the publish, and never awaited into it. The live event is the
     * time-critical half — a client is watching for it — and a mirror write is
     * housekeeping that must not sit in front of it or fail it.
     */
    void this.mirrorBalance(reading);

    return { delivered: true };
  }

  /**
   * Refresh the mirrored balance from a live reading, at most once per window.
   *
   * ## Why this exists
   *
   * The live loop holds the freshest balance in the system — it re-reads a
   * watched account every round — and this path used to discard it. Meanwhile
   * the mirror that `/accounts`, the transfer picker and the admin console read
   * was fed only by a five-minute sweep behind a five-minute deal ingestion, so
   * a client could watch a live balance on one screen while the number behind
   * the next one was minutes old.
   *
   * It also sidesteps the slower half of that chain entirely: this is a BALANCE
   * read, so it does not wait for the sweep to notice a deal.
   *
   * ## Never throws, never blocks the feed
   *
   * Called without await. Nobody asked for this write — the client asked for
   * live figures and already has them — so a database blip must cost a slightly
   * stale column and nothing else. The sweep repairs it either way.
   *
   * ## The guard that makes it safe belongs to `recordFromOperation`
   *
   * That UPDATE applies only when this reading is NEWER than whatever produced
   * the stored value, comparing MT5 read times rather than writers. So a live
   * reading racing a sweep delivery cannot move a balance backwards, and the
   * throttle below is purely about write volume rather than correctness.
   */
  private async mirrorBalance(reading: Mt5LiveDto): Promise<void> {
    const now = Date.now();
    const last = this.mirroredAt.get(reading.login);
    if (last !== undefined && now - last < MIRROR_WRITE_INTERVAL_MS) return;

    /*
     * Stamped BEFORE the write, so a slow UPDATE cannot let a second reading
     * through behind it. Erring toward writing less often is the safe direction
     * for something the sweep already covers.
     */
    this.mirroredAt.set(reading.login, now);
    this.prune(now);

    try {
      await this.accountSync.recordFromOperation(
        reading.login,
        reading.balance,
        new Date(reading.readAt),
      );
    } catch (error) {
      this.logger.debug(
        `Could not mirror the live balance for MT5 ${reading.login}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Drop throttle entries that can no longer suppress anything. */
  private prune(now: number): void {
    if (this.mirroredAt.size < THROTTLE_PRUNE_AT) return;

    for (const [login, at] of this.mirroredAt) {
      if (now - at >= MIRROR_WRITE_INTERVAL_MS) this.mirroredAt.delete(login);
    }
  }
}
