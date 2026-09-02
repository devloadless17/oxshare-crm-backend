import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../../database/database.module';
import type { Db } from '../../../database/db';
import { tradingAccounts } from '../../../database/schema';
import { Mt5LivePublisher, type Mt5LiveEvent } from './live-snapshot';
import { positionSideLabel } from './position-side';
import type { Mt5LiveDto } from './dto/mt5-live.dto';

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

  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Db,
    private readonly publisher: Mt5LivePublisher,
  ) {}

  async ingest(reading: Mt5LiveDto): Promise<LiveIngestResult> {
    const [account] = await this.db
      .select({ id: tradingAccounts.id, userId: tradingAccounts.userId })
      .from(tradingAccounts)
      .where(eq(tradingAccounts.login, reading.login))
      .limit(1);

    if (!account) {
      this.logger.debug(`Live reading for MT5 ${reading.login} names no account here; ignored`);
      return { delivered: false, reason: 'unknown-login' };
    }

    /*
     * `userId` is NOT NULL on the table, so there is no ownerless branch to
     * handle here — every trading account is opened for a client. Worth stating
     * because the room name IS the owner, and a nullable owner would mean
     * emitting into `client:null`, which is a room somebody could join.
     */
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
    return { delivered: true };
  }
}
