import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { enumQuery } from '../../common/query-params';
import { positionStatusEnum } from '../../database/schema';
import { PositionDto } from './dto/position.dto';
import { Request } from 'express';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { EmailVerifiedGuard } from '../identity/guards/email-verified.guard';
import { User } from '../../store/users.store';
import { TradingService } from './trading.service';
import { TradingAccountDto } from './dto/trading-account.dto';
import { SelfServiceOfferDto } from './dto/self-service.dto';
import {
  AccountHistoryDto,
  AccountHistoryQueryDto,
  AccountPositionDto,
  AccountSnapshotDto,
  AccountWatchDto,
  BalanceMovementPageDto,
} from './dto/account-detail.dto';
import { OpenOwnAccountDto } from './dto/open-account.dto';
import { RenameOwnAccountDto } from './dto/rename-account.dto';
import { FundDemoAccountDto } from './dto/fund-demo-account.dto';
import { Mt5AccountsService } from './mt5/mt5-accounts.service';
import { Mt5OwnAccountsService } from './mt5/mt5-own-accounts.service';
import { SelfServiceGroups } from './mt5/self-service-groups';
import { UsersStore } from '../../store/users.store';
import { KycNotVerifiedError } from '../../common/errors/domain-errors';

/**
 * The client's own trading accounts.
 *
 * ## Why this route did not exist until now
 *
 * The portal's `/accounts` screen has been a `BackendPending` placeholder,
 * and its file comment records why that placeholder was the CORRECT state: the
 * version before it rendered a fixed "No Active Trading Accounts" empty state
 * for everyone, with no request behind it, so a client holding three live
 * accounts was told they had none. Every row this endpoint returns has always
 * been in the database and reachable by an ADMIN — it was only the owner who
 * could not look.
 *
 * ## The guards, and why both
 *
 * `JwtAuthGuard` plus `EmailVerifiedGuard`, matching KYC, IB, payments and
 * wallet. The address is the account's recovery channel, so until it is proved
 * "the signed-in client" is a claim nobody has checked — and these rows name
 * the client's money and their MT5 logins.
 *
 * ## No `:userId`, ever
 *
 * The owner is read from the session. This route is authenticated but NOT
 * permission-gated, so a caller-supplied owner is the entire distance between
 * "my accounts" and "anybody's accounts" — see the note in `TradingService`.
 */
@ApiTags('trading')
@UseGuards(JwtAuthGuard, EmailVerifiedGuard)
@Controller('trading')
export class TradingController {
  constructor(
    private readonly trading: TradingService,
    private readonly mt5Accounts: Mt5AccountsService,
    private readonly ownAccounts: Mt5OwnAccountsService,
    private readonly selfServiceGroups: SelfServiceGroups,
    private readonly users: UsersStore,
  ) {}

  /**
   * Open a trading account for the signed-in client.
   *
   * ## Why this is not behind KycVerifiedGuard
   *
   * The guard is all-or-nothing and this route is not: a LIVE account holds
   * real money and needs a verified client, a DEMO account holds practice money
   * and is how somebody decides whether verification is worth their time.
   * Gating both would put the paperwork before the reason to do it, and gating
   * neither would open real accounts to unverified strangers.
   *
   * So the check happens below, on the environment, and the refusal reuses the
   * guard's own error type — the portal already branches on that code to show
   * the verification prompt, and inventing a second shape here would mean it
   * silently did not.
   *
   * ## The passwords go to the client's MAILBOX, not into this response
   *
   * MT5 returns them once and nothing stores them, and they are deliberately
   * absent from the response body — the browser making this call is not
   * necessarily the client's. What comes back is where they were sent.
   *
   * There IS a second chance now: `POST accounts/:id/password` below rotates
   * both and emails the new pair.
   */
  @Post('accounts')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Open a trading account — live requires a verified identity, demo does not',
    description:
      "The MT5 group, leverage and currency are the broker's configuration, not the client's " +
      "choice. Credentials are emailed to the client's registered address, never returned here.",
  })
  async openAccount(@Body() dto: OpenOwnAccountDto, @Req() req: Request & { user: User }) {
    if (dto.environment === 'live') {
      const user = await this.users.findById(req.user.id);
      if ((user?.verificationLevel ?? 0) < 1) {
        throw new KycNotVerifiedError(
          'Your identity must be verified before you can open a live account. ' +
            'You can open a demo account now and verify later.',
        );
      }
    }

    /*
     * Both resolved BEFORE the bridge call, and both VALIDATE rather than
     * merely default. `group` arrives from a browser: unchecked, a client could
     * name any group the catalogue knows — including one belonging to another
     * partner's agency. Resolved for THIS client, so what they are allowed to
     * open is decided by their own introducing broker and not by the request.
     */
    const { mt5Group: group, productId } = await this.selfServiceGroups.resolve(
      req.user.id,
      dto.environment,
      dto.group,
      dto.productId,
    );
    const leverage = await this.selfServiceGroups.resolveLeverage(dto.leverage);

    return await this.ownAccounts.createOwnAccount({
      userId: req.user.id,
      environment: dto.environment,
      group,
      productId,
      leverage,
      name: dto.name,
      startingBalance: dto.startingBalance,
    });
  }

  /**
   * Reset BOTH passwords on one of the caller's own trading accounts.
   *
   * ## Throttled hard, and per client rather than per account
   *
   * Each call rotates real credentials and sends a real email, so an unbounded
   * one is both a mailbox flood and a way to lock somebody out of their own
   * account repeatedly. Five an hour is generous for the honest case — a client
   * resets once and reads their mail — and useless as an attack.
   *
   * The limit deliberately does NOT scale with the number of accounts held: the
   * thing being protected is the client's mailbox and MT5's patience, neither of
   * which cares which account the requests name.
   *
   * ## Ownership is checked in the service, not here
   *
   * `resetOwnAccountPassword` matches the account id against the caller's own
   * user id in the same query that reads it, so an id belonging to somebody else
   * answers 404. Doing it there rather than in the controller keeps the check in
   * the same place as the read it guards.
   */
  @Post('accounts/:id/password')
  @Throttle({ default: { ttl: 3_600_000, limit: 5 } })
  @ApiCookieAuth()
  @ApiOperation({
    summary: "Reset a trading account's master and investor passwords",
    description:
      'Rotates BOTH passwords on MT5 and emails the new pair to the client’s registered ' +
      'address. They are never returned in the response — the browser asking is not ' +
      'necessarily the client’s. Not idempotent: each call invalidates the previous pair.',
  })
  async resetAccountPassword(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request & { user: User },
  ) {
    return await this.ownAccounts.resetOwnAccountPassword({
      userId: req.user.id,
      accountId: id,
    });
  }

  /**
   * Rename one of the caller's own trading accounts.
   *
   * PATCH rather than PUT: the body carries the one field a client may change,
   * not a whole account, and the MT5 write underneath is a read-modify-write
   * that preserves everything it does not name.
   *
   * Throttled far more loosely than the reset above — renaming sends no mail and
   * invalidates no credential, so the only thing worth bounding is chatter at
   * the trading server.
   */
  @Patch('accounts/:id')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Rename a trading account',
    description:
      "Changes the account holder's name as MT5 records it, so it updates what the client " +
      'sees in their terminal and on statements. Nothing is stored CRM-side.',
  })
  async renameAccount(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RenameOwnAccountDto,
    @Req() req: Request & { user: User },
  ) {
    return await this.ownAccounts.renameOwnAccount({
      userId: req.user.id,
      accountId: id,
      name: dto.name,
    });
  }

  /**
   * Add practice money to one of the caller's own DEMO accounts.
   *
   * A demo balance is consumed by practising, which is the point of it. Until
   * this existed the only funding a demo account ever got was its starting
   * balance, so a client who traded theirs down had one remedy — open another
   * account — which costs an MT5 login per mistake and loses the history they
   * were practising against.
   *
   * ⚠️ DEMO ONLY, refused in the service on the account's own `environment`
   * rather than trusted from the caller. A live balance is real money that
   * arrives through a deposit or a transfer, both of which post a wallet leg and
   * a ledger entry; crediting one here would mint money on the trading server
   * with no counterpart anywhere in the CRM.
   *
   * Throttled like a write that reaches the broker, and more tightly than the
   * rename beside it: this one moves a balance. It is deliberately NOT
   * idempotent — a client may legitimately top up the same amount twice — so the
   * throttle and the portal's in-flight disable are what stand between a
   * double-click and two credits.
   */
  @Post('accounts/:id/fund')
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Top up a demo trading account with practice money',
    description:
      'Demo accounts only — a live account is funded by transferring from a wallet, which posts ' +
      'both sides of the movement. Any positive amount with up to two decimal places.',
  })
  async fundDemoAccount(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: FundDemoAccountDto,
    @Req() req: Request & { user: User },
  ) {
    return await this.ownAccounts.fundOwnDemoAccount({
      userId: req.user.id,
      accountId: id,
      amount: dto.amount,
    });
  }

  @Get('positions')
  @ApiCookieAuth()
  @ApiOperation({
    summary: "The signed-in client's positions — open by default",
    description:
      'IMPORTANT: this returns an EMPTY LIST for everyone today, and that is a real answer rather ' +
      'than a stub. Nothing writes to `positions` because there is no MT5 bridge, so the table ' +
      'exists and the query is genuine — "no open positions" is something the database said.\n\n' +
      'The table is created ahead of the feed deliberately: a screen rendering a hardcoded empty ' +
      'state is indistinguishable from one whose query found nothing, and that confusion has ' +
      'already told a client holding three live accounts that they had none.\n\n' +
      'Prices and volumes are decimal STRINGS (§6.1). `profit` is the REALISED result and is null ' +
      'while a position is open — floating P/L is deliberately absent, because it changes on ' +
      'every tick and a stored copy is stale the moment it is written.',
  })
  @ApiQuery({ name: 'status', required: false, enum: positionStatusEnum.enumValues })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiOkResponse({ type: [PositionDto] })
  myPositions(
    @Req() req: Request & { user: User },
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    return this.trading.listPositions(req.user.id, {
      // Checked against the schema's own enum, never cast: `?status=nonsense`
      // compared against a Postgres enum surfaces as a 500 carrying a database
      // error, where R-2.5 wants a 400 naming what IS allowed.
      status: enumQuery(status, positionStatusEnum.enumValues, 'status'),
      limit: limit ? Number.parseInt(limit, 10) : undefined,
    });
  }

  /*
   * ── The `accounts/:id` family ──────────────────────────────────────────────
   *
   * DECLARED AFTER `accounts/self-service` and `accounts/transferable`, and that
   * ordering is load-bearing. Nest matches routes in declaration order, so a
   * `:id` parameter registered above them would swallow both literals and send
   * `self-service` into `ParseUUIDPipe` as an account id — a 400 on a route that
   * exists, which reads as a client bug rather than a routing one.
   *
   * Every handler here takes the account id from the URL and the OWNER from the
   * session. `TradingService.findMine` is what reconciles them, and it is the
   * only thing standing between "my account" and "any account" on four routes
   * that are authenticated but not permission-gated.
   */

  /**
   * Which environments this deployment lets a client open unaided.
   *
   * The portal needs it to decide whether to draw the buttons at all. Without
   * it the only way to discover that live accounts are switched off is to press
   * the button and read the refusal, which is a poor way to learn that a
   * feature is not for you.
   */
  @Get('accounts/self-service')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'What THIS client may open: account types, currencies and leverages',
    description:
      'Per-client, not per-deployment. A client introduced by a partner is offered that ' +
      'partner’s agency’s products; a client who came in directly is offered every enabled ' +
      'product. Currencies are read live from MT5, so the portal shows what an account will ' +
      'actually be denominated in. An environment with no types is switched off and the portal ' +
      'hides it.',
  })
  @ApiOkResponse({ type: SelfServiceOfferDto })
  async selfService(@Req() req: Request & { user: { id: number } }): Promise<SelfServiceOfferDto> {
    /*
     * Currencies come from MT5 rather than from the catalogue.
     *
     * `trading_product_groups.currency` is a cache for the admin picker, and a
     * group's currency is set on the server where it can change without telling
     * us. Trusting the cached copy would eventually show a client USD on an
     * account that opens in EUR — and they would find out from their first
     * deposit.
     *
     * A group MT5 will not describe is still OFFERED, with the cached currency
     * as the fallback: an operator put it in a product deliberately, and hiding
     * it because one lookup failed would silently withdraw a product.
     */
    const known = new Map<string, string>();
    try {
      for (const group of await this.mt5Accounts.listGroupsForClients()) {
        known.set(group.name.toLowerCase(), group.currency);
      }
    } catch {
      // The bridge is down. Types are still listed, on cached currencies, so
      // the page renders and the choice is still the broker's.
    }

    /*
     * The CAPS travel with the offer, per product (0201): the server counts
     * what the client holds under each, by the same rule the create endpoint
     * refuses on, so the portal never offers a product it would refuse and never
     * has to count the accounts itself.
     */
    const held = await this.selfServiceGroups.accountsHeld(req.user.id);

    const describe = async (environment: 'live' | 'demo') =>
      (await this.selfServiceGroups.offeredTo(req.user.id, environment)).map((option) => ({
        group: option.mt5Group,
        currency: known.get(option.mt5Group.toLowerCase()) ?? option.currency,
        product: option.productName,
        // The product's name in Arabic (0179); null = untranslated, show `product`.
        productAr: option.productNameAr,
        // Sent back on create (0142): a group may back several products, so
        // the product is what identifies which offer the client picked.
        productId: option.productId,
        maxAccounts: option.maxAccountsPerClient,
        heldAccounts: held.get(option.productId) ?? 0,
        minDeposit: option.minDeposit,
      }));

    const [liveTypes, demoTypes] = await Promise.all([describe('live'), describe('demo')]);

    return {
      // Derived from the offer rather than asked separately: "this client has
      // somewhere to open a live account" and "live account types exist for
      // this client" are the same fact, and two sources for it drift.
      live: liveTypes.length > 0,
      demo: demoTypes.length > 0,
      liveTypes,
      demoTypes,
      // From the ladder TABLE, not the settings row — see migration 0067.
      leverages: await this.selfServiceGroups.leverages(),
    };
  }

  @Get('accounts')
  @ApiCookieAuth()
  @ApiOperation({
    summary: "The signed-in client's trading accounts, live first then demo",
    description:
      'The whole list, unpaginated — a client holds a handful of accounts rather than a growing ' +
      'log. Balances are decimal STRINGS (§6.1) and are the CRM mirror of MT5, kept by the ' +
      "bridge's push and sweep. Equity, margin and open positions are LIVE figures and are read " +
      'from the bridge per account (`accounts/:id/live`, `accounts/:id/positions`), never stored.',
  })
  @ApiOkResponse({ type: [TradingAccountDto] })
  myAccounts(@Req() req: Request & { user: User }) {
    return this.trading.listMine(req.user.id);
  }

  @Get('accounts/transferable')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'The accounts a transfer from the wallet may credit — live and active only',
    description:
      'Narrows what the transfer screen OFFERS. It does not become the check: `TransfersService` ' +
      'still refuses a demo, suspended or closed destination, because a second opinion about the ' +
      'same question is a second thing to drift.',
  })
  @ApiOkResponse({ type: [TradingAccountDto] })
  myTransferableAccounts(@Req() req: Request & { user: User }) {
    return this.trading.listTransferable(req.user.id);
  }

  /*
   * ── The `accounts/:id` family ──────────────────────────────────────────────
   *
   * DECLARED AFTER `accounts/self-service` and `accounts/transferable`, and that
   * ordering is load-bearing. Nest matches routes in declaration order, so a
   * `:id` parameter registered above them would swallow both literals and send
   * `self-service` into `ParseUUIDPipe` as an account id — a 400 on a route that
   * exists, which reads as a client bug rather than a routing one.
   *
   * Every handler here takes the account id from the URL and the OWNER from the
   * session. `TradingService.findMine` is what reconciles them, and it is the
   * only thing standing between "my account" and "any account" on four routes
   * that are authenticated but not permission-gated.
   */

  @Get('accounts/:id')
  @ApiCookieAuth()
  @ApiOperation({
    summary: "One of the signed-in client's trading accounts",
    description:
      '404 when the account does not exist OR belongs to somebody else — the two are the same ' +
      'answer on purpose, because distinguishing them tells a caller which ids are real.\n\n' +
      '`balance` here is the CRM-held figure, as on the list. For what MT5 holds right now, ' +
      'including equity and floating P/L, call `/trading/accounts/:id/live`.',
  })
  @ApiOkResponse({ type: TradingAccountDto })
  myAccount(@Req() req: Request & { user: User }, @Param('id', ParseUUIDPipe) id: string) {
    return this.trading.findMine(req.user.id, id);
  }

  @Get('accounts/:id/live')
  /*
   * ── EVERY CALL HERE TAKES THE MT5 SESSION LOCK ─────────────────────────
   *
   * The bridge serialises every MT5 call behind ONE lock, and
   * `Mt5ConnectionSupervisor` needs that same lock to rebuild a dropped
   * session. That is not a theory: the admin account list used to read balances
   * live, one call per row, and the screen that displayed the estate became the
   * reason the estate could not reconnect.
   *
   * This route is the client-side shape of the same risk. It is one account per
   * call rather than twenty-five, but it is reachable by every client on the
   * platform and it sits behind a REFRESH BUTTON — the one control users press
   * repeatedly when a number looks wrong.
   *
   * The global limit is 120/min, sized for a person browsing. Twelve a minute is
   * still far more than a human reading a balance needs, and it turns
   * refresh-mashing from a queue of MT5 calls into a 429 that costs nothing.
   *
   * Per CLIENT, not per account: the cost is the lock, and the lock does not
   * care which login is being read. Throttling per account would let one client
   * with ten accounts take ten times the budget.
   */
  @Throttle({ default: { ttl: 60_000, limit: 12 } })
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Balance, equity, margin and floating P/L for one account, read live from MT5',
    description:
      'The AUTHORITATIVE figures, read through the bridge to the MT5 server. Distinct from the ' +
      '`balance` column on the list endpoint, which is what a transfer credited and goes stale ' +
      'the moment the client opens a position.\n\n' +
      '`floating` is equity minus balance minus credit — the unrealised total across every open ' +
      'position. It is the ONLY floating figure this system can state: the bridge exposes no ' +
      'open-position feed, so a PER-TRADE floating number would have to be invented.\n\n' +
      'NULL when the account has no MT5 login yet, which is a different state from the bridge ' +
      'being unreachable — that raises EXTERNAL_SERVICE_ERROR. A screen must not render both as ' +
      'the same sentence.',
  })
  @ApiOkResponse({ type: AccountSnapshotDto })
  myAccountLive(@Req() req: Request & { user: User }, @Param('id', ParseUUIDPipe) id: string) {
    return this.trading.snapshotMine(req.user.id, id);
  }

  @Post('accounts/:id/watch')
  @HttpCode(HttpStatus.OK)
  /*
   * ── THE ONE LIVE ROUTE THAT DOES NOT TAKE THE MT5 LOCK ─────────────────
   *
   * `:id/live` and `:id/positions` above are capped at 12/min because every
   * call reaches MT5 through a single session lock. This one registers a name
   * in a dictionary on the bridge and returns; the reading happens on the
   * bridge's own loop, where ten viewers of one account cost ONE read instead
   * of ten. So the reason for the tight cap does not apply, and applying it
   * anyway would be worse than useless: a heartbeat is four calls a minute per
   * open screen, and a client with three tabs would be throttled out of the
   * live path and back into the polling this exists to replace.
   *
   * 60/min still bounds it. A screen heartbeating every fifteen seconds needs
   * four, so this leaves room for several tabs, a reconnect storm and a retry
   * without ever being reached by ordinary use.
   */
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Say this client is looking at the account, so live figures are pushed to them',
    description:
      'Registers a LEASE on the bridge: while it holds, the bridge reads this account on its ' +
      'own loop and pushes each reading to the socket as `account.live`. Nothing tells the ' +
      'bridge a browser tab closed, so the caller MUST re-register inside `ttlSeconds` or the ' +
      'watch expires — which is what stops an abandoned page costing MT5 reads for ever.\n\n' +
      '`watching: false` is an ordinary answer, never an error, and the fallback is the same ' +
      'for every reason it carries: keep polling `/accounts/:id/live`. A bridge that is down, ' +
      'full, or not configured costs the client nothing but the freshness they already had.\n\n' +
      'This route does NOT read MT5 and does not take the session lock, which is why it is ' +
      'throttled far more loosely than the two live reads beside it.',
  })
  @ApiOkResponse({ type: AccountWatchDto })
  myAccountWatch(@Req() req: Request & { user: User }, @Param('id', ParseUUIDPipe) id: string) {
    return this.trading.watchMine(req.user.id, id);
  }

  @Get('accounts/:id/positions')
  // Same lock, same reasoning as `:id/live` above — and this one is worse to
  // leave open, because open positions are what a client watches while the
  // market moves, which is exactly when they refresh hardest.
  @Throttle({ default: { ttl: 60_000, limit: 12 } })
  @ApiCookieAuth()
  @ApiOperation({
    summary: "One account's OPEN positions, read live from MT5",
    description:
      'Live, and never stored. `profit` is the FLOATING result on each position and moves on ' +
      'every tick, so a persisted copy would be stale the moment it was written — the CRM keeps ' +
      'a `positions` table that nothing writes to, and that must stay true.\n\n' +
      'An empty array means the account has nothing open. It is a real answer from the trading ' +
      'server, not an unbuilt feature: an account with no MT5 login returns the same, because ' +
      'there is nothing to ask about.\n\n' +
      '`stopLoss` and `takeProfit` are NULL when unset — MT5 stores an absent stop as the price ' +
      '0, and rendering that as 0.00 reads as an order to close at zero.',
  })
  @ApiOkResponse({ type: [AccountPositionDto] })
  myAccountPositions(@Req() req: Request & { user: User }, @Param('id', ParseUUIDPipe) id: string) {
    return this.trading.positionsMine(req.user.id, id);
  }

  @Get('accounts/:id/history')
  @ApiCookieAuth()
  @ApiOperation({
    summary: "One account's deals and statistics over a window, from the CRM's own record",
    description:
      'The deals AND the statistics computed from exactly those deals, in one response. They ' +
      'come together because they are two views of one read, and splitting them would let a ' +
      'total describe a different set of rows from the list beside it.\n\n' +
      'Served from the ingested `mt5_deals` table, NOT read live from the trading server. Every ' +
      'row there came from MT5 by ticket — pushed live by the bridge and re-swept on a rolling ' +
      '24-hour window — so it is the same data, it reaches further back than MT5 will answer ' +
      'for in one request, and it keeps working while the bridge is down. The cost, stated ' +
      'because a client can notice it: a deal that closed in the last few minutes may not be ' +
      'here yet, and an account traded before this CRM ingested anything has no rows at all.\n\n' +
      '`/live` and `/positions` are still read through the bridge, because a balance and an ' +
      'open position move while the client is looking at them. A closed deal does not.\n\n' +
      'The window defaults to the last 30 days and is CAPPED at 31 — now a bound on the size of ' +
      'the response and of the statistics loop, since the whole window comes back in one array ' +
      'rather than paged. Dates are inclusive at both ends.\n\n' +
      'Every figure describes THE WINDOW, not all time; `from` and `to` are echoed back so the ' +
      'screen can say so.',
  })
  @ApiOkResponse({ type: AccountHistoryDto })
  myAccountHistory(
    @Req() req: Request & { user: User },
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: AccountHistoryQueryDto,
  ) {
    return this.trading.historyMine(req.user.id, id, query);
  }

  /**
   * Money that moved on this client's MT5 accounts with no position behind it.
   *
   * ## The gap this closed, and what it is for NOW
   *
   * It was built for the DEALER ADJUSTMENT, which moved money on MT5 with no
   * wallet leg and no ledger entry: every CRM money screen reads
   * `transactions`, so that movement appeared on none of them and an admin
   * could credit — or DEBIT — a client's trading account with the client's own
   * history showing nothing.
   *
   * ⚠️ THAT ROUTE IS GONE. Console money movements now go through
   * `POST /admin/trading-accounts/:id/fund`, which posts a wallet leg and a
   * ledger entry both ways, so the hole this was reporting on no longer exists.
   *
   * This endpoint STAYS, for the reason `deal-codes.ts` gave before either of
   * them existed: `mt5_deals` holds every balance operation the bridge ingests,
   * including ones the CRM did not originate — a swap correction MT5 booked
   * itself, or a movement made directly in the broker terminal. Those are still
   * real money on a client's account with no `transactions` row, and this is
   * still the only place they can be read.
   *
   * What changed is that it is now a RECONCILIATION read rather than the
   * client's missing statement. The portal panel that rendered it was removed:
   * it could not tell a CRM transfer from a terminal adjustment and double-
   * showed the former under a heading claiming the wallet was untouched.
   *
   * ## Not a parameter, from the session
   *
   * The client id comes from the SESSION and is never a query parameter — the
   * same rule `GET /payments/transactions` carries, and for the same reason: a
   * `userId` here would be an oracle for anybody else's money.
   */
  @Get('balance-movements')
  @ApiCookieAuth()
  @ApiOperation({
    summary: "Money moved on the client's MT5 accounts with no trade behind it",
    description:
      'Deposits, withdrawals, credits, corrections and bonuses across EVERY account the ' +
      'client holds — the movements MT5 records and the CRM ledger does not, because a ' +
      'dealer adjustment has no wallet leg by design.\n\n' +
      'Balance movements ONLY: trades and dealer cancellations are excluded, using the same ' +
      'two predicates the commission engine uses, so a new MT5 action code cannot mean one ' +
      'thing here and another there. It carries NO trade statistics — win rate and realised ' +
      'P/L were removed from the portal deliberately and this does not bring them back.\n\n' +
      'Served from the ingested `mt5_deals` table, so it keeps working while the bridge is ' +
      'down, and a movement from the last few minutes may not have arrived yet. Amounts are ' +
      'SIGNED strings — negative is money leaving. The window defaults to 30 days, is capped ' +
      'at 31, and is inclusive at both ends, exactly as `/accounts/:id/history` is: two money ' +
      'lists in one product must not mean different things by "from".',
  })
  @ApiOkResponse({ type: BalanceMovementPageDto })
  myBalanceMovements(@Req() req: Request & { user: User }, @Query() query: AccountHistoryQueryDto) {
    return this.trading.balanceMovementsMine(req.user.id, query);
  }
}
