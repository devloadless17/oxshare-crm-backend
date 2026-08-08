import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq } from 'drizzle-orm';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db } from '../../database/db';
import { positions, tradingAccounts } from '../../database/schema';
import type { TradingAccountDto } from './dto/trading-account.dto';
import type { PositionDto } from './dto/position.dto';

/**
 * The signed-in client's own trading accounts.
 *
 * ## The owner comes from the session, never from a parameter (R-4.4)
 *
 * `userId` is an argument to these methods because the CONTROLLER reads it off
 * `req.user`. There is no route parameter and there must never be one: this
 * endpoint is authenticated but not permission-gated, so a caller-supplied owner
 * is the whole distance between "my accounts" and "anyone's accounts". The admin
 * route takes a `userId` filter precisely because it is gated and this is not —
 * the same split `WalletController.myLedger` records.
 *
 * ## No pagination, deliberately
 *
 * A client holds a handful of trading accounts, not a growing log — unlike the
 * ledger, which is append-only and therefore keyset-paged. Returning the whole
 * list lets the portal group by environment and count each group without
 * discovering on page two that there was a third demo account.
 *
 * If that assumption ever breaks — an operator issuing accounts in bulk — this
 * needs the same cursor treatment as the ledger, not an offset page.
 */
@Injectable()
export class TradingService {
  constructor(@Inject(DRIZZLE_DB) private readonly db: Db) {}

  /**
   * Every account this client holds, live and demo together.
   *
   * Ordered live-before-demo and then newest-first. The environment ordering is
   * not cosmetic: a demo account and a live one differ by whether the money is
   * real, and a list that interleaves them by date invites acting on the wrong
   * one. The portal groups them into separate sections regardless — this makes
   * the response already grouped so the two cannot disagree about which is
   * which.
   *
   * `asc(environment)` gives live first because the enum declares `live` before
   * `demo`, and Postgres orders an enum by its declared order rather than
   * alphabetically — which is the opposite of what the letters would give.
   */
  async listMine(userId: string): Promise<TradingAccountDto[]> {
    const rows = await this.db
      .select({
        id: tradingAccounts.id,
        login: tradingAccounts.login,
        mt5Group: tradingAccounts.mt5Group,
        environment: tradingAccounts.environment,
        currency: tradingAccounts.currency,
        balance: tradingAccounts.balance,
        tier: tradingAccounts.tier,
        leverage: tradingAccounts.leverage,
        status: tradingAccounts.status,
        createdAt: tradingAccounts.createdAt,
      })
      .from(tradingAccounts)
      .where(eq(tradingAccounts.userId, userId))
      .orderBy(asc(tradingAccounts.environment), desc(tradingAccounts.createdAt));

    /*
     * Returned as-is. `balance` arrives from Drizzle as the STRING Postgres
     * sends for NUMERIC(28,8), and it stays one all the way to the client
     * (§6.1) — there is no mapping step here precisely so nobody is tempted to
     * add a `Number()` to it.
     */
    return rows;
  }

  /**
   * The accounts a client may transfer INTO — live, active, and nothing else.
   *
   * Exposed for the transfer screen, which currently has no way to enumerate
   * destinations and so cannot offer one. A demo account is excluded because
   * crediting real money to it is a loss with no counterparty, and a suspended
   * or closed account is excluded because the transfer would be refused after
   * the client had already committed to it.
   *
   * The refusal still lives in `TransfersService` — this narrows what is
   * OFFERED, and does not become the check. A second opinion about the same
   * question is a second thing to drift.
   */
  async listTransferable(userId: string): Promise<TradingAccountDto[]> {
    const rows = await this.listMine(userId);
    return rows.filter((row) => row.environment === 'live' && row.status === 'active');
  }

  /**
   * This client's positions — open by default, or the closed history.
   *
   * ## Returns an empty list today, and that is a real answer
   *
   * Nothing writes to `positions`: there is no MT5 bridge, so no ingestion path
   * exists. This is a genuine query against a genuine table, so "no open
   * positions" is something the database said rather than something the portal
   * assumed. See the table comment in schema.ts for why that distinction is
   * worth a migration.
   *
   * Joined to `trading_accounts` for the login, because a trade is meaningless
   * without knowing which account it sits on — and a client with a live and a
   * demo account has two very different reads of the same symbol.
   *
   * `limit` is capped rather than trusted: the closed history grows without
   * bound, and an uncapped caller would eventually ask for all of it.
   */
  async listPositions(
    userId: string,
    options: { status?: 'open' | 'closed'; limit?: number } = {},
  ): Promise<PositionDto[]> {
    const status = options.status ?? 'open';
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);

    const rows = await this.db
      .select({
        id: positions.id,
        tradingAccountId: positions.tradingAccountId,
        login: tradingAccounts.login,
        ticket: positions.ticket,
        symbol: positions.symbol,
        side: positions.side,
        volume: positions.volume,
        openPrice: positions.openPrice,
        closePrice: positions.closePrice,
        stopLoss: positions.stopLoss,
        takeProfit: positions.takeProfit,
        profit: positions.profit,
        swap: positions.swap,
        commission: positions.commission,
        currency: positions.currency,
        status: positions.status,
        openedAt: positions.openedAt,
        closedAt: positions.closedAt,
      })
      .from(positions)
      .innerJoin(tradingAccounts, eq(tradingAccounts.id, positions.tradingAccountId))
      .where(and(eq(positions.userId, userId), eq(positions.status, status)))
      /*
       * Open positions read newest-first by OPEN time; closed ones by CLOSE
       * time. Ordering the closed set by `openedAt` would bury a trade opened
       * last month and closed this morning beneath older, already-settled ones.
       */
      .orderBy(status === 'open' ? desc(positions.openedAt) : desc(positions.closedAt))
      .limit(limit);

    // Returned as-is: every numeric column arrives as the STRING Postgres sends
    // for NUMERIC, and stays one (§6.1). No mapping step, so nobody is tempted
    // to add a `Number()` to a price or a P/L.
    return rows;
  }
}
