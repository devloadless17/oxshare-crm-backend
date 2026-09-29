import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from 'drizzle-orm';
import Decimal from 'decimal.js';
import { DRIZZLE_DB } from '../../database/database.module';
import type { Db } from '../../database/db';
import { mt5Deals, positions, tradingAccounts, tradingProductGroups } from '../../database/schema';
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
import { DEFAULT_PAGE_SIZE } from '../../common/pagination';
import { Mt5BridgeClient } from './mt5/mt5-bridge.client';
import { Mt5AccountSyncService } from './mt5/mt5-account-sync.service';
import {
  CLOSING_ENTRIES,
  TRADE_ACTIONS,
  dealActionLabel,
  isCancelledAction,
  isRealisedTrade,
  isTradeAction,
} from './mt5/deal-codes';
import { positionSideLabel } from './mt5/position-side';
import type { TradingAccountDto } from './dto/trading-account.dto';
import type { PositionDto } from './dto/position.dto';
import type {
  AccountDealDto,
  AccountHistoryDto,
  AccountHistoryQueryDto,
  AccountPositionDto,
  AccountSnapshotDto,
  AccountStatsDto,
  AccountWatchDto,
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

/**
 * How old the mirrored balance must be before opening the accounts list asks
 * MT5 for it.
 *
 * Twenty seconds, which is shorter than the portal's own 30s poll on that
 * screen and far shorter than a sweep cycle. The point is the FIRST paint after
 * a client closes a trade and opens the site — anything longer and the number
 * they are most certain about is the one the screen gets wrong. Anything much
 * shorter and an ordinary reload starts costing an MT5 read for no new answer.
 */
const BALANCE_REFRESH_AFTER_MS = 20_000;

/**
 * The most accounts one list request will read from MT5.
 *
 * The MT5 session is a single lock, so these reads are serial: this is how long
 * one client can hold it. Five covers every real client — the platform caps live
 * accounts at five by default — while bounding what somebody holding twenty
 * could do to everybody else.
 */
const BALANCE_REFRESH_MAX = 5;

/**
 * The whole-operation budget for those reads.
 *
 * A balance read measured ~150ms on an idle bridge and 40 SECONDS while a deal
 * sweep round was running. This is what keeps that second number out of the
 * client's page load: past the budget the mirror answers, which is exactly the
 * behaviour this screen had before and is never worse than it.
 */
const BALANCE_REFRESH_BUDGET_MS = 2_500;

@Injectable()
export class TradingService {
  private readonly logger = new Logger(TradingService.name);

  /*
   * The bridge is injected for the two reads that must be LIVE — `snapshotMine`
   * and `positionsMine` — and that is the whole reason this service is no longer
   * purely a database reader.
   *
   * `historyMine` is deliberately NOT among them. A closed deal does not move,
   * so it is served from `mt5_deals`; a balance and an open position move on
   * every tick, so they are not. That line — does this figure change while the
   * client is looking at it — is what decides whether a read here crosses to a
   * server we do not own.
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
  async listMine(userId: number): Promise<TradingAccountDto[]> {
    /*
     * ── ASK MT5 BEFORE ANSWERING, WHEN THE MIRROR IS OLD ──────────────────
     *
     * The sweep cannot be fast enough for this moment. A client closes a trade
     * in the terminal, opens the portal, and the first thing they see is their
     * balance — and the mirror behind it is written by a background round whose
     * worst case is minutes. "I closed a deal and the site shows the old
     * number" is not a latency to tune down; it is the screen being wrong at
     * the one moment the client is certain what the right answer is.
     *
     * So the LIST does what the detail page already does: reads MT5 and writes
     * through. Bounded three ways, because this is the most-visited screen in
     * the portal and every read takes the bridge's single MT5 session lock —
     * see `refreshOwnBalances` for what each bound is protecting.
     *
     * Best-effort by construction: it never throws and never blocks past its
     * deadline, so an unreachable or busy bridge costs a stale figure rather
     * than a screen the client cannot open. The mirror is still the source of
     * the response below; this only gives it a chance to be current first.
     */
    await this.refreshOwnBalances(userId);

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
  async listTransferable(userId: number): Promise<TradingAccountDto[]> {
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
    userId: number,
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
      /*
       * The `id` TIEBREAK, and it is not cosmetic.
       *
       * `opened_at` and `closed_at` are not unique — two positions opened in the
       * same instant are ordinary — and Postgres gives no guarantee about the
       * relative order of tied rows between queries. With a LIMIT on the end,
       * that decides WHICH of the tied rows is included: the same client
       * refreshing sees the list reorder, and one trade appear or vanish at the
       * boundary, with nothing having changed.
       *
       * `sorting.ts` states the rule for the paged lists; a capped list has the
       * same problem in a smaller window. Migration 0129 indexes both pairs, so
       * the tiebreak is free.
       */
      .orderBy(
        status === 'open' ? desc(positions.openedAt) : desc(positions.closedAt),
        desc(positions.id),
      )
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
  async findMine(userId: number, accountId: string): Promise<TradingAccountDto> {
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
  async snapshotMine(userId: number, accountId: string): Promise<AccountSnapshotDto | null> {
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
  /**
   * Bring this client's balances up to date from MT5, within a budget.
   *
   * ## Three bounds, and each one is protecting something different
   *
   * **Staleness.** Only an account whose mirror is older than
   * `BALANCE_REFRESH_AFTER_MS` is read. A client reloading the page, or the 30s
   * poll on the accounts screen, therefore costs nothing at all — the sweep or
   * the previous load has usually just written the figure. This is what stops
   * the most-visited screen in the portal becoming a per-render MT5 call.
   *
   * **Count.** At most `BALANCE_REFRESH_MAX` accounts per request. The reads are
   * serial by necessity — the MT5 session is a single lock — so an unbounded
   * loop would let one client with many accounts hold it for as long as they had
   * accounts, which is the starvation the deal sweep already had to be taught
   * not to cause.
   *
   * **Time.** A whole-operation deadline. A read measured at ~150ms on an idle
   * bridge was measured at FORTY SECONDS while a sweep round was running, and a
   * client opening the accounts page must never wait that out. Past the deadline
   * the loop stops and the mirror answers; an in-flight read is left to land on
   * its own, which is harmless because it writes through the same staleness
   * guard as everything else.
   *
   * ## It never throws
   *
   * Not `viaBridge`, which re-throws so a failed read reaches the client as a
   * retryable error. That is right for the detail page, where the live figure IS
   * the answer. Here the answer is the list, the mirror can always supply it,
   * and an unreachable bridge must cost a stale balance rather than a screen
   * that will not open.
   */
  private async refreshOwnBalances(userId: number): Promise<void> {
    if (!this.bridge.isConfigured) return;

    const cutoff = new Date(Date.now() - BALANCE_REFRESH_AFTER_MS);

    const stale = await this.db
      .select({ login: tradingAccounts.login })
      .from(tradingAccounts)
      .where(
        and(
          eq(tradingAccounts.userId, userId),
          /* No login means no account on MT5 to ask about. */
          isNotNull(tradingAccounts.login),
          /*
           * Active only. A closed or suspended account's balance is not what
           * the client is coming to check, and spending the session lock on one
           * takes the budget from an account they are actually trading.
           */
          eq(tradingAccounts.status, 'active'),
          or(isNull(tradingAccounts.balanceSyncedAt), lt(tradingAccounts.balanceSyncedAt, cutoff)),
        ),
      )
      .limit(BALANCE_REFRESH_MAX);

    if (stale.length === 0) return;

    const deadline = Date.now() + BALANCE_REFRESH_BUDGET_MS;

    for (const row of stale) {
      if (Date.now() >= deadline) {
        /*
         * Debug rather than warn. Running out of budget is the guard working —
         * the bridge was busy and the client got their page — and a line per
         * page load on a busy bridge would be noise in the log that matters.
         */
        this.logger.debug(
          `Balance refresh budget spent for client ${userId}; the mirror answers for the rest.`,
        );
        return;
      }

      try {
        const snapshot = await this.bridge.getAccount(row.login as string);
        /* `readAt` AFTER the call, for the reason `snapshotMine` records: an
           understated read time would let this overwrite a fresher sweep. */
        const readAt = new Date();
        if (snapshot) {
          await this.accountSync.recordFromOperation(row.login as string, snapshot.balance, readAt);
        }
      } catch (error) {
        /*
         * Swallowed on purpose, and logged at debug for the same reason as the
         * budget line: the bridge being busy is the ordinary case this whole
         * method is designed around, not an incident.
         */
        this.logger.debug(
          `Could not refresh balance for login ${row.login}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * Tell the bridge this client is LOOKING at one of their accounts.
   *
   * ## What this buys, and what it replaces
   *
   * The account screen used to poll `/accounts/:id/live` every ten seconds, per
   * browser. Each of those crossed the bridge and took the single MT5 session
   * lock, so the cost scaled with viewers × poll rate — which is why that route
   * is capped at 12/min and why the interval could not simply be lowered to make
   * the screen livelier. Registering interest instead moves the reading onto the
   * bridge's own loop, where ten people watching one account cost ONE read
   * rather than ten, and the answers arrive over the socket the client already
   * holds for their notifications.
   *
   * ## It is a LEASE, so the caller has to keep asking
   *
   * Nothing tells the bridge a tab closed. The watch expires unless renewed
   * inside `ttlSeconds`, which is what stops an abandoned page costing MT5 reads
   * for ever — see `LiveWatchRegistry` on the bridge. The response carries the
   * bridge's own lease length rather than a constant repeated here, so the
   * portal paces its heartbeat off what is actually enforced.
   *
   * ## Every failure degrades to polling, and none of them throw
   *
   * `watching: false` is an ordinary answer with a reason, never an error, and
   * the caller's fallback is the same in all three cases: keep reading the live
   * route. That is what makes this safe to add to a screen that already works —
   * a bridge that is down, full, or missing entirely costs the client nothing
   * but the freshness they had before.
   *
   * This route deliberately does NOT take the session lock. It registers a name
   * and returns, so it is cheap enough to be called on a heartbeat by every open
   * account page — which is exactly what the throttle on it is sized for.
   */
  async watchMine(userId: number, accountId: string): Promise<AccountWatchDto> {
    const account = await this.findMine(userId, accountId);

    /*
     * A half-provisioned account. There is no login to watch, and this is not a
     * failure of anything — `snapshotMine` returns null for the same state, and
     * the screen already renders it as "not opened yet" rather than an error.
     */
    if (!account.login) return { watching: false, reason: 'no-login', ttlSeconds: null };

    if (!this.bridge.isConfigured) {
      return { watching: false, reason: 'unavailable', ttlSeconds: null };
    }

    try {
      const result = await this.bridge.watchLive([account.login]);
      return {
        /*
         * `accepted` rather than "not refused": the bridge caps how many
         * accounts one live round may cover, and past that cap it refuses NEW
         * logins so the viewers already being served keep being served. A
         * refused client has lost nothing — their screen keeps polling.
         */
        watching: result.accepted.includes(account.login),
        reason: result.accepted.includes(account.login) ? undefined : 'at-capacity',
        ttlSeconds: result.ttlSeconds,
      };
    } catch (error) {
      /*
       * Swallowed, unlike every other bridge call on this service.
       *
       * `viaBridge` re-throws so a client asking for a BALANCE is told the
       * server could not be reached — correct, because they asked for a figure
       * and there is none. Nobody asked for anything here: this is the screen
       * volunteering that it is open. Turning a bridge blip into an error toast
       * on a page whose figures are loading fine would report a failure the
       * client cannot act on and does not have.
       */
      this.logger.debug(
        `Could not register a live watch for trading account ${accountId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return { watching: false, reason: 'unavailable', ttlSeconds: null };
    }
  }

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
  async positionsMine(userId: number, accountId: string): Promise<AccountPositionDto[]> {
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
      side: positionSideLabel(position.action),
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
   * query. Two aggregates over one window could disagree with the list beside
   * them — a client reading totals computed over one set of rows while looking
   * at another is the failure this shape exists to make impossible.
   *
   * ## From `mt5_deals`, NOT from the trading server
   *
   * This read used to cross to MT5 on every view, and the reason recorded here
   * was that the ingested table "shows nothing whenever ingestion is behind".
   * That trade was the wrong way round for a client-facing statement screen:
   *
   * - **It is the same data.** Every row in `mt5_deals` came from MT5, by the
   *   ticket, unrounded — the bridge pushes each deal live AND a sweep re-reads
   *   a rolling 24-hour window every five minutes, so a deal has two chances to
   *   land before anybody looks at this screen. The lag is minutes, not days.
   * - **It reaches further back.** MT5 silently truncates a request wider than
   *   about a month, which is why the window here is capped. The table has no
   *   such limit — it holds every deal since ingestion began — so this is the
   *   only source that can ever answer a question about last quarter.
   * - **It survives the bridge being down.** A client checking what they traded
   *   yesterday no longer depends on a live session to a server we do not own,
   *   held behind a single lock that open positions and the balance snapshot are
   *   already queuing for. Those two must be live because they move on every
   *   tick. A closed deal does not move; it is history the moment it exists.
   *
   * The honest cost, stated because it is the one a client can notice: a deal
   * closed in the last few minutes may not be here yet, and an account traded
   * before this CRM ingested anything has no rows at all. The screen names its
   * window, which is what keeps that readable rather than alarming.
   *
   * ## The `positions` panel is where "right now" lives
   *
   * Nothing on this page is left without a live answer by the change. Open
   * positions and the balance snapshot still read through the bridge, and they
   * are the two things on the screen that are actually still moving.
   */
  async historyMine(
    userId: number,
    accountId: string,
    query: AccountHistoryQueryDto = {},
  ): Promise<AccountHistoryDto> {
    const account = await this.findMine(userId, accountId);
    const { from, to } = resolveWindow(query);

    const page = query.page ?? 1;
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;

    if (!account.login) {
      return { from, to, stats: emptyStats(), deals: [], total: 0, page, limit };
    }

    /*
     * By LOGIN, because that is what a deal names — `mt5_deals` deliberately
     * stores no user or account id, so that a deal arriving before its account
     * is linked is not orphaned forever. The join to a client happens here, at
     * read time, and `findMine` above has already proved this login is theirs.
     *
     * `mt5_deals_login_dealt_idx` covers exactly this filter and this order.
     *
     * The window is a closed interval on both ends. `resolveWindow` has already
     * pushed `to` to the end of its day for the reason recorded there, so the
     * inclusive comparison is what the client asked for rather than an off-by-a-
     * day.
     */

    /*
     * ── CLOSED TRADES ONLY, DECIDED IN SQL ───────────────────────────────────
     *
     * `closing` used to be computed per row in Node and filtered in the BROWSER,
     * which is affordable only while the whole window is in memory — and that is
     * exactly what stopped being true when this started paging. A page of 25
     * ingested deals might hold three closed trades, so filtering after the
     * slice returns short pages and a `total` nobody can page to.
     *
     * `isRealisedTrade` is still the definition; this is that predicate pushed
     * into the database, built from the same two code lists so the pair cannot
     * drift apart silently.
     */
    const windowFilter = and(
      eq(mt5Deals.login, account.login),
      gte(mt5Deals.dealtAt, from),
      lte(mt5Deals.dealtAt, to),
    );
    const closedFilter = and(
      windowFilter,
      inArray(mt5Deals.action, [...TRADE_ACTIONS]),
      inArray(mt5Deals.entry, [...CLOSING_ENTRIES]),
    );

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
      .where(closedFilter)
      /*
       * Newest first, and the index gives that ordering for free: this filter
       * and this sort are exactly `mt5_deals_login_dealt_idx`.
       *
       * The TIE-BREAK is deliberately not in the ORDER BY. Two deals can share a
       * timestamp at MT5's one-second resolution, and without a total order the
       * list reshuffles between two renders of identical data — but the ticket
       * is a VARCHAR, so breaking the tie in SQL means either a lexical order
       * that ranks '9' above '100' or a `::numeric` cast. The cast forces a sort
       * node over the whole window AND turns one unparseable ticket into a 500
       * on every client's account page. It is settled in Node instead, below.
       */
      .orderBy(desc(mt5Deals.dealtAt))
      /*
       * ONE PAGE, not the window. The `MOVEMENT_LIMIT + 1` that stood here was a
       * truncation the screen had to INFER from the array's length; an OFFSET
       * and a real `total` replace it.
       */
      .limit(limit)
      .offset((page - 1) * limit);

    const items: AccountDealDto[] = rows
      .map((row) => ({
        ticket: row.ticket,
        symbol: row.symbol,
        action: row.action,
        actionLabel: dealActionLabel(row.action),
        entry: row.entry,
        closing: isRealisedTrade(row),
        // NUMERIC columns arrive as decimal strings and leave as decimal strings
        // (§6.1). Nothing on this path parses one into a float.
        volume: row.volume,
        price: row.price,
        profit: row.profit,
        commission: row.commission,
        swap: row.swap,
        comment: row.comment || null,
        dealtAt: row.dealtAt,
      }))
      /*
       * The tie-break the ORDER BY left to us, and it is NUMERIC: ticket '9'
       * must not outrank '100'. Applied to the already-ordered array, so this is
       * a near-sorted pass rather than a real sort, and a ticket MT5 has never
       * issued in a non-numeric form degrades to "leave the SQL order alone"
       * instead of failing the request.
       */
      .sort(
        (a, b) => b.dealtAt.getTime() - a.dealtAt.getTime() || Number(b.ticket) - Number(a.ticket),
      );

    /*
     * The TOTALS, over the whole window rather than over this page.
     *
     * This is the half of paging that is easy to get wrong: summing the returned
     * array would make page 2 report "3 trades, best 12.40" about whichever rows
     * happened to be on screen, and a client paging through their month would
     * watch their net profit change under them.
     *
     * Every sum stays NUMERIC end to end. `SUM` over NUMERIC returns NUMERIC and
     * reaches Node as a decimal STRING, which is what §6.1 requires of money
     * leaving this service — the `computeStats` this replaces used decimal.js
     * for exactly that reason, and pushing the arithmetic into Postgres keeps
     * the property rather than trading it for floats.
     */
    const [totals] = await this.db
      .select({
        trades: sql<string>`count(*)`,
        wins: sql<string>`count(*) filter (where ${mt5Deals.profit} > 0)`,
        losses: sql<string>`count(*) filter (where ${mt5Deals.profit} < 0)`,
        volume: sql<string>`coalesce(sum(${mt5Deals.volume}), 0)`,
        netProfit: sql<string>`coalesce(sum(${mt5Deals.profit}), 0)`,
        grossProfit: sql<string>`coalesce(sum(${mt5Deals.profit}) filter (where ${mt5Deals.profit} > 0), 0)`,
        grossLoss: sql<string>`coalesce(sum(${mt5Deals.profit}) filter (where ${mt5Deals.profit} < 0), 0)`,
        commission: sql<string>`coalesce(sum(${mt5Deals.commission}), 0)`,
        swap: sql<string>`coalesce(sum(${mt5Deals.swap}), 0)`,
        /* NULL with no trades, never '0' — the DTO's own note: '0' beside a
           currency symbol claims there WAS a best trade and it broke even. */
        bestTrade: sql<string | null>`max(${mt5Deals.profit})`,
        worstTrade: sql<string | null>`min(${mt5Deals.profit})`,
      })
      .from(mt5Deals)
      .where(closedFilter);

    /*
     * The DATES span EVERY deal in the window, not only the realised ones —
     * unchanged from `computeStats`, and the reason is unchanged with it: "last
     * activity" is answered by the last thing that happened on the account, so a
     * client who funded an account without trading it has a real date rather
     * than a blank. That is why this reads `windowFilter` where the totals above
     * read `closedFilter`.
     */
    const [activity] = await this.db
      .select({
        /*
         * TYPED AS A STRING, and converted below.
         *
         * Drizzle's `sql<T>` is an ASSERTION, not a conversion: it tells the
         * compiler what to expect and the driver still hands back whatever
         * Postgres sent. A bare `min()`/`max()` over a timestamptz arrives as a
         * STRING — annotating it `Date` compiles happily and then fails at
         * runtime on `.toISOString()`, which is exactly how this was caught.
         *
         * The column reads elsewhere in this file get real `Date`s because
         * Drizzle maps a known column type; an aggregate expression has no
         * column behind it, so nothing maps it.
         */
        firstDealAt: sql<string | null>`min(${mt5Deals.dealtAt})`,
        lastDealAt: sql<string | null>`max(${mt5Deals.dealtAt})`,
      })
      .from(mt5Deals)
      .where(windowFilter);

    return {
      from,
      to,
      stats: statsFromTotals(totals, activity),
      /* `count(*)` over the CLOSED filter — the same set the page is a slice of
         and the same set the statistics describe, so `total` can never disagree
         with `trades`. */
      total: Number(totals?.trades ?? 0),
      deals: items,
      page,
      limit,
    };
  }

  /**
   * EVERY MOVEMENT OF MONEY ON THIS CLIENT'S MT5 ACCOUNTS THAT HAS NO POSITION
   * BEHIND IT — deposits, withdrawals, credits, corrections, bonuses.
   *
   * ## Why this read has to exist
   *
   * `deal-codes.ts` already stated the requirement, before this method did:
   * that set "is not the same list as the CRM's transfers, because **a dealer
   * can move an MT5 balance directly and the client should see that** rather
   * than a gap between two numbers they can both read."
   *
   * The dealer adjustment this was built for (`POST
   * /admin/trading-accounts/:id/balance`) was deliberately one-sided: it moved
   * money on MT5 with no wallet leg and no ledger entry, so it was never
   * written into `transactions` — and because every CRM money screen reads
   * that table, an admin could credit or DEBIT a client's trading account with
   * the client's own history showing nothing at all.
   *
   * ⚠️ THAT ROUTE IS GONE. `POST /admin/trading-accounts/:id/fund` replaced it
   * and records both directions, so a CRM-originated movement now has a
   * `transactions` row and a ledger entry like everything else.
   *
   * This read still matters, and for the ORIGINAL reason rather than that one:
   * `mt5_deals` also holds balance operations the CRM never originated — a swap
   * correction MT5 booked itself, or a movement made in the broker terminal
   * directly. Those have no `transactions` row and never will, so this remains
   * the only place they can be seen.
   *
   * The data was never missing. `mt5_deals` stores every deal the bridge
   * ingests, unfiltered — `isTradeAction` excludes balance deals from
   * COMMISSION, never from storage — and the only screen that read them was
   * removed in `1cfd673` along with the trade statistics it was built for.
   *
   * ## Balance movements ONLY, and that narrowness is the point
   *
   * Restoring the whole Activity card would bring back win rate, realised P/L
   * and volume, which were removed on purpose. A fix that quietly undoes a
   * deliberate decision is worse than the gap it closes. So: not a trade, not a
   * cancellation — expressed with the same two predicates the engine uses, so a
   * new MT5 action code cannot silently become a balance movement here while
   * meaning something else there.
   *
   * ## Across every account, because the client's question is not per-account
   *
   * `historyMine` answers "what happened on THIS account". A client looking at
   * their transaction history is asking "where did my money go", which does not
   * stop at an account boundary. Accounts with no MT5 login yet are skipped
   * rather than erroring: an account MetaTrader has not issued a login for
   * cannot have deals, and that is an ordinary state rather than a fault.
   */
  async balanceMovementsMine(
    userId: number,
    query: AccountHistoryQueryDto = {},
  ): Promise<{ from: Date; to: Date; items: BalanceMovementRow[]; truncated: boolean }> {
    const { from, to } = resolveMovementWindow(query);

    /*
     * ── LIVE ACCOUNTS ONLY, OR THIS LIST MIXES TWO KINDS OF MONEY ──────────
     *
     * This read every account the client holds, demo included. A demo account
     * is topped up with practice money through `fundOwnDemoAccount`, and MT5
     * records that as an ordinary balance operation — so a $10,000 practice
     * top-up landed in this list beside real deposits, in the same shape, with
     * nothing on the row saying which was which.
     *
     * The question this endpoint answers is "where did my money go", and
     * practice money is not an answer to it. Filtering the ACCOUNTS rather
     * than the deals is what keeps the fix in one place: every row here is
     * found by login, so an account excluded here cannot contribute one.
     */
    const accounts = await this.db
      .select({ id: tradingAccounts.id, login: tradingAccounts.login })
      .from(tradingAccounts)
      .where(
        and(
          eq(tradingAccounts.userId, userId),
          isNotNull(tradingAccounts.login),
          eq(tradingAccounts.environment, 'live'),
        ),
      );

    if (accounts.length === 0) return { from, to, items: [], truncated: false };

    const byLogin = new Map(accounts.map((a) => [a.login as string, a.id]));

    const rows = await this.db
      .select({
        ticket: mt5Deals.mt5DealId,
        login: mt5Deals.login,
        action: mt5Deals.action,
        profit: mt5Deals.profit,
        comment: mt5Deals.comment,
        dealtAt: mt5Deals.dealtAt,
      })
      .from(mt5Deals)
      .where(
        and(
          inArray(mt5Deals.login, [...byLogin.keys()]),
          gte(mt5Deals.dealtAt, from),
          lte(mt5Deals.dealtAt, to),
        ),
      )
      .orderBy(desc(mt5Deals.dealtAt));

    /*
     * Filtered HERE rather than in SQL, deliberately. The two predicates are the
     * single definition of what counts as a trade in this system, and a hand-
     * written `action NOT IN (...)` beside them is a second definition that
     * cannot be kept in step — the exact drift `isCancelledAction`'s own
     * docblock warns about for new action codes.
     *
     * Safe because the window is bounded and scoped to one client's logins.
     */
    /*
     * Bounded by ROWS, and the count is reported rather than silently applied.
     *
     * This project has shipped the other thing twice — a partner's client count
     * that was the length of what fitted, and a referred list capped at fifty
     * with nothing saying so. A list that is cut and does not say it is cut is
     * a number the reader will trust.
     *
     * `LIMIT n + 1` is how we know: one row past the cap proves there is more
     * without a second COUNT query, and it is dropped before the caller sees it.
     */
    const movements = rows.filter((r) => !isTradeAction(r.action) && !isCancelledAction(r.action));
    const truncated = movements.length > MOVEMENT_LIMIT;

    return {
      from,
      to,
      truncated,
      items: movements.slice(0, MOVEMENT_LIMIT).map((r) => ({
        ticket: String(r.ticket),
        accountId: byLogin.get(r.login) as string,
        login: r.login,
        action: r.action,
        actionLabel: dealActionLabel(r.action),
        /*
         * `profit` IS the amount for a balance deal — MT5 carries the money
         * there when there is no position. A string, like every other amount
         * that crosses this boundary (§6.1), and signed: a debit is negative
         * and the screen must be able to say so rather than showing a bare
         * figure a client cannot tell the direction of.
         */
        amount: r.profit,
        comment: r.comment,
        dealtAt: r.dealtAt,
      })),
    };
  }
}

/** One money movement on an MT5 account with no position behind it. */
export interface BalanceMovementRow {
  ticket: string;
  accountId: string;
  login: string;
  action: number;
  actionLabel: string;
  amount: string;
  comment: string | null;
  dealtAt: Date;
}

/** MT5's numeric position side, named. An unknown code is reported raw. */
/**
 * The window to read, with defaults and the ceiling applied.
 *
 * ## Thirty days by default, thirty-one at most
 *
 * The ceiling OUTLIVED its original reason and is kept on a new one, which is
 * worth stating rather than leaving as folklore.
 *
 * It was here because MT5 silently TRUNCATES a request for a larger range rather
 * than refusing it, so a client asking for a year would be shown a partial
 * history that looked complete. Reading from `mt5_deals` retires that: Postgres
 * returns every row in the range or none.
 *
 * What is left is the size of the ANSWER. Every deal in the window is
 * serialised to the client and summed in Node, and an active account can trade
 * hundreds a day — so the bound is now on the response and on the statistics
 * loop, not on a quirk of the trading server. Thirty-one days is what the portal
 * offers and comfortably more than it asks for.
 *
 * Raising it is now a real option in a way it never was before, and the shape it
 * needs is a PAGED deal list with the statistics aggregated in SQL. It is not a
 * matter of moving this constant: the whole window currently lands in one array
 * because that is what makes the totals and the list provably describe the same
 * rows.
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
      'A history window may cover at most 31 days. Ask for a shorter range — a wider one is ' +
        'returned whole or not at all, and a whole one is more than a single response can carry ' +
        'for an actively traded account.',
    );
  }

  return { from, to };
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
/** 31 whole days, plus the part-day the inclusive end adds. */
const MAX_WINDOW_MS = 32 * 24 * 60 * 60 * 1000;

/** The most balance movements one response carries. See `balanceMovementsMine`. */
const MOVEMENT_LIMIT = 500;

/**
 * The window for BALANCE MOVEMENTS — the same shape as `resolveWindow`, and
 * deliberately WITHOUT its 31-day cap.
 *
 * Sharing the semantics is the point: `startOfDay` / `endOfDay`, closed at both
 * ends, so a client asking for "the 10th" gets their own 10th on this list
 * exactly as they do on the account history. Two money lists in one product
 * that mean different things by "from" is a divergence noticed at the worst
 * possible moment.
 *
 * ⚠️ But the CAP does not transfer, and copying it because it sits next to the
 * semantics would have been the mistake. Its own message argues from trade
 * volume — *"a whole one is more than a single response can carry for an
 * actively traded account"* — and this list EXCLUDES trades. Dealer
 * adjustments are rare by nature: a client asking for a year of them might get
 * three rows, and a 31-day cap would make them ask twelve times to find that
 * out.
 *
 * What genuinely cannot be returned whole is a large number of ROWS, so that is
 * what `MOVEMENT_LIMIT` bounds — the thing that is actually unbounded rather
 * than a proxy for it. Raised by `crm-92` reviewing the design.
 */
function resolveMovementWindow(query: AccountHistoryQueryDto): { from: Date; to: Date } {
  const to = query.to ? endOfDay(query.to) : endOfDay(todayIso());
  const from = query.from ? startOfDay(query.from) : new Date(to.getTime() - THIRTY_DAYS_MS);

  if (from.getTime() > to.getTime()) {
    throw new ValidationError('The start of the range must not be after its end.');
  }

  return { from, to };
}

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
 * The statistics DTO, assembled from what Postgres already computed.
 *
 * ## Why this is not `computeStats` any more
 *
 * That function summed a decimal.js accumulator across the deals array, which
 * was correct precisely while the array WAS the window. Paging broke that: the
 * array is now one page, and totals derived from it would describe whichever
 * rows the client happened to be looking at.
 *
 * So the arithmetic moved into the query and this became a mapper. It does no
 * maths — every figure arrives from Postgres as a NUMERIC decimal string and is
 * passed through untouched (§6.1), which is the same guarantee the decimal.js
 * version gave and the reason neither ever used a float.
 *
 * `null` totals are impossible for the sums (`coalesce` floors them at 0) and
 * expected for `bestTrade`/`worstTrade`, where `MAX`/`MIN` over no rows is NULL
 * — which is the answer the DTO wants there.
 */
/** A nullable aggregate timestamp, as the `Date` the DTO promises. */
function toDate(value: string | null | undefined): Date | null {
  return value ? new Date(value) : null;
}

function statsFromTotals(
  totals:
    | {
        trades: string;
        wins: string;
        losses: string;
        volume: string;
        netProfit: string;
        grossProfit: string;
        grossLoss: string;
        commission: string;
        swap: string;
        bestTrade: string | null;
        worstTrade: string | null;
      }
    | undefined,
  activity: { firstDealAt: string | null; lastDealAt: string | null } | undefined,
): AccountStatsDto {
  /*
   * An aggregate over an empty table still returns ONE row, so `undefined` here
   * means the query itself returned nothing — which it cannot. Guarded anyway
   * rather than asserted, because the alternative on a money screen is a crash
   * where an empty panel would do.
   */
  if (!totals) return emptyStats();

  return {
    /* COUNTS are the one place a number is right: `count(*)` is a bigint, it
       arrives as a string, and it is a row count rather than an amount. */
    trades: Number(totals.trades),
    wins: Number(totals.wins),
    losses: Number(totals.losses),
    volume: totals.volume,
    netProfit: totals.netProfit,
    grossProfit: totals.grossProfit,
    grossLoss: totals.grossLoss,
    commission: totals.commission,
    swap: totals.swap,
    bestTrade: totals.bestTrade,
    worstTrade: totals.worstTrade,
    /* Back to a `Date`, which is what the DTO declares and what every other
       timestamp leaving this service is. See the aggregate's own note on why
       these arrive as strings in the first place. */
    firstDealAt: toDate(activity?.firstDealAt),
    lastDealAt: toDate(activity?.lastDealAt),
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
