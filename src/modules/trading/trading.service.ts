import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db } from '../../database/db';
import { mt5Deals, positions, tradingAccounts } from '../../database/schema';
import { ExternalServiceError, NotFoundError } from '../../common/errors/domain-errors';
import { Mt5BridgeClient } from './mt5/mt5-bridge.client';
import {
  CANCELLED_ACTIONS,
  CLOSING_ENTRIES,
  TRADE_ACTIONS,
  dealActionLabel,
  isRealisedTrade,
} from './mt5/deal-codes';
import type { TradingAccountDto } from './dto/trading-account.dto';
import type { PositionDto } from './dto/position.dto';
import type {
  AccountDealPageDto,
  AccountSnapshotDto,
  AccountStatsDto,
  ListAccountDealsQueryDto,
} from './dto/account-detail.dto';

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
  /*
   * The bridge is injected for ONE method — `snapshotMine` — and that is the
   * whole reason this service is no longer purely a database reader.
   *
   * The alternative was a second service for the one MT5-crossing read, mirroring
   * the split `Mt5AccountsController` documents on the admin side. It is not
   * worth it here: that split exists because the admin WRITE surface (open an
   * account, move a balance) is a different thing to reason about from a query.
   * A read-through for the account this service already loaded and
   * ownership-checked is not, and separating them would mean the ownership check
   * lived in one service and the read that depends on it in another.
   */
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: Db,
    private readonly bridge: Mt5BridgeClient,
  ) {}

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

  /**
   * ONE account, and only if this client owns it.
   *
   * The ownership predicate is in the WHERE clause rather than a check on the
   * loaded row, so a request for somebody else's account id is indistinguishable
   * from a request for one that does not exist — both are the same 404. Loading
   * first and comparing after leaks the difference through whatever the error
   * message ends up saying.
   *
   * Every other read on the detail screen goes through here first (R-4.4): the
   * deal history, the statistics and the MT5 snapshot all take an account id
   * from the URL, and this is the single place that decides whether the caller
   * may have it.
   */
  async findMine(userId: string, accountId: string): Promise<TradingAccountDto> {
    const [row] = await this.db
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
      .where(and(eq(tradingAccounts.id, accountId), eq(tradingAccounts.userId, userId)))
      .limit(1);

    if (!row) throw new NotFoundError('Trading account not found.');
    return row;
  }

  /**
   * What MT5 holds on this account right now, read live through the bridge.
   *
   * ## Why the client may read this when the cached column exists
   *
   * `trading_accounts.balance` is what a transfer credited and nothing more. The
   * moment the client opens a position it is stale, and it is stale in the
   * direction that matters: a client who is down sees the figure from before the
   * trade. The detail screen is where somebody checks their money, so it asks
   * the server that owns the answer.
   *
   * ## `floating` is derived here, and it is the only floating figure we have
   *
   * Equity is balance plus credit plus unrealised profit, so the account-level
   * floating total falls straight out of three numbers MT5 just sent.
   * Per-POSITION floating does not, and must not be invented: the bridge exposes
   * closed deals and account snapshots, and no open-position feed exists to
   * attribute a total across trades.
   *
   * decimal.js rather than subtraction on numbers — §6.1 governs a figure
   * DERIVED from money exactly as it governs one read from a column.
   *
   * ## Null has two causes and the caller must tell them apart
   *
   * An account with no MT5 login has never been provisioned, and is a different
   * state from a bridge that could not be reached — which throws. A screen
   * rendering both as "unavailable" tells a client with a working account that
   * their broker is down.
   */
  async snapshotMine(userId: string, accountId: string): Promise<AccountSnapshotDto | null> {
    const account = await this.findMine(userId, accountId);
    if (!account.login) return null;

    /*
     * An unconfigured bridge fails as an EXTERNAL SERVICE problem, not as a
     * validation one. The admin route says "set MT5_BRIDGE_URL" because an
     * operator can act on that; a client cannot, and the deployment's
     * environment variables are not theirs to be told about. Both reach the
     * portal as "the live figures could not be read", which is the true
     * statement either way — and the screen keeps rendering the CRM balance
     * beside it, labelled as the cached figure it is.
     */
    if (!this.bridge.isConfigured) {
      throw new ExternalServiceError('The trading server could not be reached.');
    }

    const snapshot = await this.bridge.getAccount(account.login);
    if (!snapshot) return null;

    const floating = new Decimal(snapshot.equity)
      .minus(snapshot.balance)
      .minus(snapshot.credit)
      .toFixed(8);

    return {
      // MT5 sends the login as a number; it leaves here as the string every
      // other surface uses, because leading zeros are significant.
      login: String(snapshot.login),
      group: snapshot.group,
      currency: snapshot.currency,
      leverage: snapshot.leverage,
      balance: snapshot.balance,
      equity: snapshot.equity,
      credit: snapshot.credit,
      margin: snapshot.margin,
      marginFree: snapshot.marginFree,
      marginLevel: snapshot.marginLevel,
      floating,
    };
  }

  /**
   * This account's deal history, paged and filtered.
   *
   * ## Joined on the LOGIN, which is why an unprovisioned account is empty
   *
   * `mt5_deals` names an MT5 login, never an account id — the schema comment
   * records why: a deal arriving before its account has been linked would
   * otherwise be orphaned forever, and that ordering is normal during
   * onboarding. An account with no login therefore has no deals BY DEFINITION,
   * and the query is skipped rather than run against a null.
   */
  async listDealsMine(
    userId: string,
    accountId: string,
    query: ListAccountDealsQueryDto = {},
  ): Promise<AccountDealPageDto> {
    const account = await this.findMine(userId, accountId);
    const page = Math.max(query.page ?? 1, 1);
    const limit = Math.min(Math.max(query.limit ?? 25, 1), 100);

    if (!account.login) return { items: [], total: 0, page, limit };

    const where = and(...this.dealPredicates(account.login, query));

    const [{ total }] = await this.db
      .select({ total: sql<number>`COUNT(*)::int` })
      .from(mt5Deals)
      .where(where);

    const rows = await this.db
      .select({
        ticket: mt5Deals.mt5DealId,
        symbol: mt5Deals.symbol,
        action: mt5Deals.action,
        entry: mt5Deals.entry,
        volume: mt5Deals.volume,
        price: mt5Deals.price,
        profit: mt5Deals.profit,
        commission: mt5Deals.commission,
        swap: mt5Deals.swap,
        comment: mt5Deals.comment,
        dealtAt: mt5Deals.dealtAt,
      })
      .from(mt5Deals)
      .where(where)
      /*
       * By `dealtAt`, never `ingestedAt`. The sweep re-reads a rolling 24 hours
       * and can ingest an older deal after a newer one, so ordering by arrival
       * would reshuffle a client's history every time a partition healed.
       *
       * The ticket breaks ties: two deals can share a timestamp, and without a
       * total order an offset page can drop or repeat a row between requests.
       */
      .orderBy(desc(mt5Deals.dealtAt), desc(mt5Deals.mt5DealId))
      .limit(limit)
      .offset((page - 1) * limit);

    return {
      items: rows.map((row) => ({
        ...row,
        actionLabel: dealActionLabel(row.action),
        closing: isRealisedTrade(row),
      })),
      total,
      page,
      limit,
    };
  }

  /**
   * The account's realised performance, summed in the database.
   *
   * Counts and totals cover CLOSED round trips only — `AccountStatsDto` records
   * why an opening deal must not be counted, and `deal-codes.ts` what qualifies
   * as one. Balance operations are excluded here and surfaced as history
   * instead: a deposit is not a winning trade.
   *
   * Every SUM is `COALESCE`d because SUM over no rows is NULL, and a null total
   * reaching a formatter renders blank where the true answer is zero. MIN and MAX
   * are deliberately NOT coalesced: "the best trade was 0" and "there were no
   * trades" are different statements, and only one may be shown beside a currency
   * symbol.
   */
  async statsMine(userId: string, accountId: string): Promise<AccountStatsDto> {
    const account = await this.findMine(userId, accountId);
    if (!account.login) return { ...EMPTY_STATS };

    const realised = and(
      eq(mt5Deals.login, account.login),
      inArray(mt5Deals.action, [...TRADE_ACTIONS]),
      inArray(mt5Deals.entry, [...CLOSING_ENTRIES]),
    );

    const [row] = await this.db
      .select({
        trades: sql<number>`COUNT(*)::int`,
        wins: sql<number>`COUNT(*) FILTER (WHERE ${mt5Deals.profit} > 0)::int`,
        losses: sql<number>`COUNT(*) FILTER (WHERE ${mt5Deals.profit} < 0)::int`,
        volume: sql<string>`COALESCE(SUM(${mt5Deals.volume}), 0)::text`,
        netProfit: sql<string>`COALESCE(SUM(${mt5Deals.profit}), 0)::text`,
        grossProfit: sql<string>`COALESCE(SUM(${mt5Deals.profit}) FILTER (WHERE ${mt5Deals.profit} > 0), 0)::text`,
        grossLoss: sql<string>`COALESCE(SUM(${mt5Deals.profit}) FILTER (WHERE ${mt5Deals.profit} < 0), 0)::text`,
        commission: sql<string>`COALESCE(SUM(${mt5Deals.commission}), 0)::text`,
        swap: sql<string>`COALESCE(SUM(${mt5Deals.swap}), 0)::text`,
        bestTrade: sql<string | null>`MAX(${mt5Deals.profit})::text`,
        worstTrade: sql<string | null>`MIN(${mt5Deals.profit})::text`,
      })
      .from(mt5Deals)
      .where(realised);

    /*
     * The date range spans EVERY deal, not only the realised ones. "Active
     * since" is answered by the first thing that happened on the account —
     * usually the opening deposit — so a client who has funded an account but
     * not yet traded it has a real first date rather than a blank.
     */
    const [dates] = await this.db
      .select({
        firstDealAt: sql<Date | null>`MIN(${mt5Deals.dealtAt})`,
        lastDealAt: sql<Date | null>`MAX(${mt5Deals.dealtAt})`,
      })
      .from(mt5Deals)
      .where(eq(mt5Deals.login, account.login));

    return { ...row, firstDealAt: dates.firstDealAt, lastDealAt: dates.lastDealAt };
  }

  /**
   * The WHERE clause for a deal listing, shared by the count and the page.
   *
   * One builder rather than two so the pair cannot drift: a count built from
   * different predicates than the rows it counts reports "312 results" over a
   * page of 25 that came from somewhere else, and a client's own history is the
   * last place to discover that.
   *
   * Dates compare by DATE PART — `::date >= ::date` — matching
   * `TransactionsService`. Comparing a timestamp against an end date parsed as
   * midnight excludes almost the whole final day.
   */
  private dealPredicates(login: string, query: ListAccountDealsQueryDto) {
    return [
      eq(mt5Deals.login, login),
      ...(query.kind === 'trades' ? [inArray(mt5Deals.action, [...TRADE_ACTIONS])] : []),
      /*
       * Spelled out rather than inverting the trade filter. A plain
       * `notInArray(TRADE_ACTIONS)` would sweep the cancelled actions in with the
       * balance operations, and `isBalanceOperation` excludes them deliberately —
       * a cancellation is the reversal of an event, not money moving.
       */
      ...(query.kind === 'balance'
        ? [notInArray(mt5Deals.action, [...TRADE_ACTIONS, ...CANCELLED_ACTIONS])]
        : []),
      ...(query.symbol ? [eq(mt5Deals.symbol, query.symbol)] : []),
      ...(query.from ? [sql`${mt5Deals.dealtAt}::date >= ${query.from}::date`] : []),
      ...(query.to ? [sql`${mt5Deals.dealtAt}::date <= ${query.to}::date`] : []),
    ];
  }
}

/**
 * What an account with no MT5 login has done: nothing, and every figure says so.
 *
 * A literal rather than a computed empty row, because the alternative is running
 * the aggregate against a null login and trusting it to return zeros — which it
 * would, right up until somebody adds a join.
 *
 * The three nullables stay null: there is no best trade, and `'0'` beside a
 * currency symbol claims there was one that broke even.
 */
const EMPTY_STATS: AccountStatsDto = {
  trades: 0,
  wins: 0,
  losses: 0,
  volume: '0',
  netProfit: '0',
  grossProfit: '0',
  grossLoss: '0',
  commission: '0',
  swap: '0',
  bestTrade: null,
  worstTrade: null,
  firstDealAt: null,
  lastDealAt: null,
};
