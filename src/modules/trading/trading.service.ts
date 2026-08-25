import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, desc, eq } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db } from '../../database/db';
import { positions, tradingAccounts, tradingProductGroups } from '../../database/schema';
/*
 * The product resolution lives in `common/` because the back office asks the
 * same question through `AdminHoldingsService`, and two implementations of
 * "which product is this account under" would eventually give two answers to a
 * client and a support agent looking at the same row.
 */
import {
  PRODUCT_BY_GROUP,
  PRODUCT_BY_ID,
  PRODUCT_GROUP_JOIN_ON,
  PRODUCT_NAME,
} from '../../common/account-product';
import {
  ExternalServiceError,
  NotFoundError,
  ValidationError,
} from '../../common/errors/domain-errors';
import { Mt5BridgeClient } from './mt5/mt5-bridge.client';
import { Mt5AccountSyncService } from './mt5/mt5-account-sync.service';
import { dealActionLabel, isRealisedTrade } from './mt5/deal-codes';
import type { TradingAccountDto } from './dto/trading-account.dto';
import type { PositionDto } from './dto/position.dto';
import type {
  AccountDealDto,
  AccountHistoryDto,
  AccountHistoryQueryDto,
  AccountPositionDto,
  AccountSnapshotDto,
  AccountStatsDto,
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
  private readonly logger = new Logger(TradingService.name);

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
    /*
     * The mirror's writer, so a live read is not thrown away after paying for
     * the MT5 session lock. It owns the staleness guard, which is why this
     * writes THROUGH it rather than issuing its own UPDATE — see `snapshotMine`.
     */
    private readonly accountSync: Mt5AccountSyncService,
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
        name: tradingAccounts.name,
        mt5Group: tradingAccounts.mt5Group,
        product: PRODUCT_NAME,
        environment: tradingAccounts.environment,
        currency: tradingAccounts.currency,
        balance: tradingAccounts.balance,
        leverage: tradingAccounts.leverage,
        status: tradingAccounts.status,
        createdAt: tradingAccounts.createdAt,
      })
      .from(tradingAccounts)
      // The recorded product first, the derived one behind it — see PRODUCT_NAME.
      .leftJoin(PRODUCT_BY_ID, eq(PRODUCT_BY_ID.id, tradingAccounts.productId))
      .leftJoin(tradingProductGroups, PRODUCT_GROUP_JOIN_ON)
      .leftJoin(PRODUCT_BY_GROUP, eq(PRODUCT_BY_GROUP.id, tradingProductGroups.productId))
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
        name: tradingAccounts.name,
        mt5Group: tradingAccounts.mt5Group,
        product: PRODUCT_NAME,
        environment: tradingAccounts.environment,
        currency: tradingAccounts.currency,
        balance: tradingAccounts.balance,
        leverage: tradingAccounts.leverage,
        status: tradingAccounts.status,
        createdAt: tradingAccounts.createdAt,
      })
      .from(tradingAccounts)
      // The recorded product first, the derived one behind it — see PRODUCT_NAME.
      .leftJoin(PRODUCT_BY_ID, eq(PRODUCT_BY_ID.id, tradingAccounts.productId))
      .leftJoin(tradingProductGroups, PRODUCT_GROUP_JOIN_ON)
      .leftJoin(PRODUCT_BY_GROUP, eq(PRODUCT_BY_GROUP.id, tradingProductGroups.productId))
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

    this.assertBridge();

    const snapshot = await this.viaBridge('snapshot', accountId, () =>
      this.bridge.getAccount(account.login as string),
    );
    const readAt = new Date();
    if (!snapshot) return null;

    /*
     * ── THE FRESHEST FIGURE IN THE SYSTEM, WRITTEN DOWN ───────────────────
     *
     * This read just cost the MT5 session lock — the most expensive thing the
     * bridge does — and the answer was rendered once and thrown away, while the
     * mirror beside it kept a figure minutes older. The next screen the client
     * opened showed the stale one.
     *
     * So it writes through, exactly as the admin operation path already does.
     * The staleness guard inside `recordFromOperation` decides whether it wins:
     * a sweep snapshot read more recently still takes precedence, because the
     * comparison is between MT5 READ TIMES rather than between writers.
     *
     * `readAt` is stamped AFTER the call returns, for the reason the operation
     * path records: the direct response carries no read time of its own, and
     * understating it is the dangerous direction — an older sweep read carrying
     * a newer stamp would overwrite this one.
     *
     * Failure here must never reach the client. They asked for a balance and the
     * balance is in hand; a mirror that did not update is the next sweep's
     * problem, not a reason to fail a read that succeeded.
     */
    void this.accountSync
      .recordFromOperation(account.login, snapshot.balance, readAt)
      .catch(() => undefined);

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
   * Refuse before calling a bridge that was never configured.
   *
   * An EXTERNAL SERVICE failure, not a validation one. The admin route says
   * "set MT5_BRIDGE_URL" because an operator can act on that; a client cannot,
   * and the deployment's environment variables are not theirs to be told about.
   * Either way the portal reads it as "the live figures could not be read",
   * which is the true statement.
   */
  private assertBridge(): void {
    if (!this.bridge.isConfigured) {
      throw new ExternalServiceError('The trading server could not be reached.');
    }
  }

  /**
   * Run a bridge read for a CLIENT, and never let its internals reach them.
   *
   * ## What this exists to stop
   *
   * A client's account page rendered this, in full:
   *
   *   "MT5 bridge returned 500 for GET /accounts/6477978/deals?from=…:
   *    Mt5Bridge.Mt5.Mt5WebApiException: MT5 counts 1 deal(s) for 6477978 …"
   *
   * — a .NET type name, an internal URL, another client's-eye view of our
   * topology, and a login, on a screen belonging to somebody who cannot act on
   * any of it. The detail is exactly right for an operator and wrong for the
   * person reading it.
   *
   * So the cause is LOGGED with the account it belongs to, and the client gets
   * one plain sentence. The request id already on the error response is what
   * ties the two together when they call support — which is the whole reason
   * that id exists.
   *
   * Admin routes are deliberately NOT routed through here: an operator debugging
   * a broker integration needs the underlying message, and `Mt5AccountsService`
   * keeps passing it through.
   */
  private async viaBridge<T>(what: string, accountId: string, read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (error) {
      this.logger.error(
        `Bridge read failed (${what}) for trading account ${accountId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );

      /*
       * Re-thrown as the same TYPE, so the HTTP status and the client's retry
       * affordance are unchanged — only the wording is. A client seeing "could
       * not be reached" and a retry button is being told the truth: the read
       * failed and trying again is a reasonable thing to do.
       */
      throw new ExternalServiceError(
        'We could not read this account from the trading server just now. Please try again.',
      );
    }
  }

  /**
   * Every OPEN position on this account, read live from MT5.
   *
   * ## Why this does not touch the `positions` table
   *
   * That table exists, and nothing writes to it. It must stay that way: a
   * position's profit moves on every tick, so a stored row is stale the moment
   * it is written and would reach a client wearing the same label as a live
   * figure. This reads through the bridge on demand and keeps nothing.
   *
   * ## An empty list is an answer
   *
   * An account with nothing open returns `[]`, and so does a login MT5 does not
   * know. Both mean "there is nothing open to show you", which is what the
   * screen asked. An account with no login at all short-circuits before the
   * bridge is called — there is nothing to ask about.
   */
  async positionsMine(userId: string, accountId: string): Promise<AccountPositionDto[]> {
    const account = await this.findMine(userId, accountId);
    if (!account.login) return [];

    this.assertBridge();

    const positions = await this.viaBridge('positions', accountId, () =>
      this.bridge.getPositions(account.login as string),
    );

    return positions.map((position) => ({
      // A ticket identifies, it does not measure — a string all the way out, so
      // nothing downstream is tempted to do arithmetic on it.
      ticket: String(position.ticket),
      symbol: position.symbol,
      action: position.action,
      side: POSITION_SIDES[position.action] ?? `action ${position.action}`,
      volume: position.volume,
      priceOpen: position.priceOpen,
      priceCurrent: position.priceCurrent,
      stopLoss: position.stopLoss,
      takeProfit: position.takeProfit,
      profit: position.profit,
      swap: position.swap,
      commission: position.commission,
      comment: position.comment || null,
      openedAt: new Date(position.openedAt),
    }));
  }

  /**
   * What this account did over a window: the deals, and the statistics computed
   * from exactly those deals.
   *
   * ## One read, two views
   *
   * The statistics come from the SAME array that is returned, not from a second
   * query. Two reads of one window would cost twice the latency against a server
   * we do not own and — worse — could disagree: a client would see totals over
   * one set beside a list showing another.
   *
   * ## Live, not from `mt5_deals`
   *
   * The ingested table is the commission engine's record, filled by a sweep. A
   * client-facing history served from it shows nothing whenever ingestion is
   * behind or broken, and this deployment has spent whole days in that state. A
   * slower answer that is true beats an instant one that is empty.
   */
  async historyMine(
    userId: string,
    accountId: string,
    query: AccountHistoryQueryDto = {},
  ): Promise<AccountHistoryDto> {
    const account = await this.findMine(userId, accountId);
    const { from, to } = resolveWindow(query);

    if (!account.login) {
      return { from, to, stats: emptyStats(), deals: [] };
    }

    this.assertBridge();

    const deals = await this.viaBridge('history', accountId, () =>
      this.bridge.getAccountDeals(account.login as string, from, to),
    );

    const items: AccountDealDto[] = deals
      .map((deal) => ({
        ticket: String(deal.dealId),
        symbol: deal.symbol,
        action: deal.action,
        actionLabel: dealActionLabel(deal.action),
        entry: deal.entry,
        closing: isRealisedTrade(deal),
        volume: deal.volume,
        price: deal.price,
        profit: deal.profit,
        commission: deal.commission,
        swap: deal.swap,
        comment: deal.comment || null,
        dealtAt: new Date(deal.dealtAt),
      }))
      /*
       * ── TRIMMED BACK TO WHAT THE CLIENT ASKED FOR ────────────────────────
       *
       * The bridge widens its query past `to` to absorb the trading server's
       * clock zone: MT5 compares absolute unix seconds against deal times
       * recorded in its OWN local zone, so a window ending at "now" lands the
       * offset in the past and the most recent hours are invisible. Measured
       * live at +3 on this deployment.
       *
       * That margin is why a client asking for today now SEES today — and it
       * also means the bridge can hand back deals past the requested end. This
       * is a statement screen, so the range a client chose is the range they
       * are shown, and the filter belongs HERE rather than in the bridge: it
       * rests on the deal's own reported time being true UTC, which is an
       * assumption only a live server can settle, and a wrong assumption costs
       * a one-line change here instead of a redeploy of the bridge.
       */
      .filter(
        (deal) =>
          deal.dealtAt.getTime() >= from.getTime() && deal.dealtAt.getTime() <= to.getTime(),
      )
      /*
       * Newest first, with the TICKET breaking ties. Two deals can share a
       * timestamp at MT5's one-second resolution, and without a total order the
       * list reshuffles between two renders of identical data.
       */
      .sort(
        (a, b) => b.dealtAt.getTime() - a.dealtAt.getTime() || Number(b.ticket) - Number(a.ticket),
      );

    return { from, to, stats: computeStats(items), deals: items };
  }
}

/** MT5's numeric position side, named. An unknown code is reported raw. */
const POSITION_SIDES: Record<number, string> = { 0: 'buy', 1: 'sell' };

/**
 * The window to read, with defaults and the ceiling applied.
 *
 * ## Thirty days by default, thirty-one at most
 *
 * The ceiling is not a preference. MT5 silently TRUNCATES a request for a larger
 * range rather than refusing it, so a client asking for a year would be shown a
 * partial history that looks complete. The bridge refuses over 31 days for the
 * same reason; this refuses first, so the message names the window instead of
 * arriving from a service the client has never heard of.
 *
 * ## Inclusive at both ends, by DATE PART
 *
 * `to` becomes the END of its day. Parsing it as midnight excludes almost the
 * whole final day — the "my newest row vanished when I set an end date" bug that
 * `date-range.ts` and `TransactionsService` both carry a note about.
 */
function resolveWindow(query: AccountHistoryQueryDto): { from: Date; to: Date } {
  const to = query.to ? endOfDay(query.to) : endOfDay(todayIso());
  const from = query.from ? startOfDay(query.from) : new Date(to.getTime() - THIRTY_DAYS_MS);

  if (from.getTime() > to.getTime()) {
    throw new ValidationError('The start of the range must not be after its end.');
  }

  if (to.getTime() - from.getTime() > MAX_WINDOW_MS) {
    throw new ValidationError(
      'A history window may cover at most 31 days. Ask for a shorter range — the trading ' +
        'server truncates anything larger without saying so, which would show a partial history ' +
        'as though it were complete.',
    );
  }

  return { from, to };
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
/** 31 whole days, plus the part-day the inclusive end adds. */
const MAX_WINDOW_MS = 32 * 24 * 60 * 60 * 1000;

/**
 * `YYYY-MM-DD` to a LOCAL day boundary.
 *
 * Local constructor rather than `new Date('2026-08-01')`, which parses as UTC
 * and so starts the window in the wrong place for every zone but one — the trap
 * the portal's `todayIso()` documents from the other direction.
 */
function startOfDay(iso: string): Date {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(year, month - 1, day, 0, 0, 0, 0);
}

function endOfDay(iso: string): Date {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(year, month - 1, day, 23, 59, 59, 999);
}

function todayIso(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * The statistics for one window, from the deals in it.
 *
 * ## decimal.js for every total (§6.1)
 *
 * The arithmetic moved out of Postgres when the read went live, so it happens
 * here — and `+` on two of these values is exactly the coercion the money rules
 * exist to forbid. The window's ceiling is what keeps the loop bounded.
 *
 * ## Only realised round trips count
 *
 * An opening deal carries `profit: '0'` because nothing has been realised yet.
 * Counting opens would drag every average toward zero and add one guaranteed
 * non-winning row per position. Balance operations are excluded for a blunter
 * reason: a deposit is not a winning trade.
 */
function computeStats(deals: AccountDealDto[]): AccountStatsDto {
  const realised = deals.filter((deal) => deal.closing);

  let volume = new Decimal(0);
  let netProfit = new Decimal(0);
  let grossProfit = new Decimal(0);
  let grossLoss = new Decimal(0);
  let commission = new Decimal(0);
  let swap = new Decimal(0);
  let best: Decimal | null = null;
  let worst: Decimal | null = null;
  let wins = 0;
  let losses = 0;

  for (const deal of realised) {
    const profit = new Decimal(deal.profit);

    volume = volume.plus(deal.volume);
    netProfit = netProfit.plus(profit);
    commission = commission.plus(deal.commission);
    swap = swap.plus(deal.swap);

    if (profit.isPositive() && !profit.isZero()) {
      wins += 1;
      grossProfit = grossProfit.plus(profit);
    } else if (profit.isNegative() && !profit.isZero()) {
      losses += 1;
      grossLoss = grossLoss.plus(profit);
    }
    // A trade closing at exactly zero is neither — see the DTO note.

    if (best === null || profit.greaterThan(best)) best = profit;
    if (worst === null || profit.lessThan(worst)) worst = profit;
  }

  /*
   * The dates span EVERY deal in the window, not only the realised ones. "Last
   * activity" is answered by the last thing that happened on the account — a
   * deposit counts — so a client who funded an account without trading it has a
   * real date rather than a blank.
   */
  const times = deals.map((deal) => deal.dealtAt.getTime());

  return {
    trades: realised.length,
    wins,
    losses,
    volume: volume.toFixed(8),
    netProfit: netProfit.toFixed(8),
    grossProfit: grossProfit.toFixed(8),
    grossLoss: grossLoss.toFixed(8),
    commission: commission.toFixed(8),
    swap: swap.toFixed(8),
    // Null rather than '0' with no trades: '0' beside a currency symbol claims
    // there WAS a best trade and it broke even.
    bestTrade: best === null ? null : best.toFixed(8),
    worstTrade: worst === null ? null : worst.toFixed(8),
    firstDealAt: times.length ? new Date(Math.min(...times)) : null,
    lastDealAt: times.length ? new Date(Math.max(...times)) : null,
  };
}

/**
 * What an account with no MT5 login did: nothing, and every figure says so.
 *
 * A function rather than a shared constant, because a caller that mutated one
 * field of a shared object would change every future empty response — and that
 * bug reads as a data problem rather than an aliasing one.
 */
function emptyStats(): AccountStatsDto {
  return {
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
}
