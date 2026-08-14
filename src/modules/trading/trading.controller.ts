import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { EmailVerifiedGuard } from '../identity/guards/email-verified.guard';
import { User } from '../../store/users.store';
import { enumQuery } from '../../common/query-params';
import { positionStatusEnum } from '../../database/schema';
import { TradingService } from './trading.service';
import { TradingAccountDto } from './dto/trading-account.dto';
import { PositionDto } from './dto/position.dto';
import {
  AccountDealPageDto,
  AccountSnapshotDto,
  AccountStatsDto,
  ListAccountDealsQueryDto,
} from './dto/account-detail.dto';
import { OpenOwnAccountDto } from './dto/open-account.dto';
import { Mt5AccountsService } from './mt5/mt5-accounts.service';
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
   * ## The response carries the passwords, once
   *
   * MT5 returns them at creation and nothing stores them. The portal must show
   * them immediately; there is no second chance and no "resend".
   */
  @Post('accounts')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Open a trading account — live requires a verified identity, demo does not',
    description:
      "The MT5 group, leverage and currency are the broker's configuration, not the client's " +
      'choice. Returns the master and investor passwords once; they are never stored.',
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
    const group = await this.selfServiceGroups.resolve(req.user.id, dto.environment, dto.group);
    const leverage = await this.selfServiceGroups.resolveLeverage(dto.leverage);

    return await this.mt5Accounts.createOwnAccount({
      userId: req.user.id,
      environment: dto.environment,
      group,
      leverage,
      name: dto.name,
      startingBalance: dto.startingBalance,
    });
  }

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
  async selfService(@Req() req: Request & { user: { id: string } }) {
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

    const describe = async (environment: 'live' | 'demo') =>
      (await this.selfServiceGroups.offeredTo(req.user.id, environment)).map((option) => ({
        group: option.mt5Group,
        currency: known.get(option.mt5Group.toLowerCase()) ?? option.currency,
        product: option.productName,
      }));

    const [liveTypes, demoTypes] = await Promise.all([describe('live'), describe('demo')]);

    /*
     * The CAPS travel with the offer.
     *
     * The portal already knows how many accounts the client holds — it is
     * rendering them — so sending the limits lets it stop offering a button
     * that the create endpoint would refuse. Discovering a limit by pressing a
     * button and reading a refusal is a poor way to learn what you are allowed.
     *
     * `maxDemoDeposit` is here for the funding box's own hint and its `max`
     * attribute. It used to be a constant duplicated in the portal, which meant
     * the number the client was told and the number enforced could differ by a
     * deploy.
     */
    const terms = await this.selfServiceGroups.terms();

    return {
      // Derived from the offer rather than asked separately: "this client has
      // somewhere to open a live account" and "live account types exist for
      // this client" are the same fact, and two sources for it drift.
      live: liveTypes.length > 0,
      demo: demoTypes.length > 0,
      liveTypes,
      demoTypes,
      leverages: terms.leverages,
      maxLiveAccounts: terms.maxLiveAccounts,
      maxDemoAccounts: terms.maxDemoAccounts,
      maxDemoDeposit: terms.maxDemoDeposit,
    };
  }

  @Get('accounts')
  @ApiCookieAuth()
  @ApiOperation({
    summary: "The signed-in client's trading accounts, live first then demo",
    description:
      'The whole list, unpaginated — a client holds a handful of accounts rather than a growing ' +
      'log. Balances are decimal STRINGS (§6.1) and are the CRM-held figure, not MT5 equity: ' +
      'there is no bridge, so equity, margin and open positions are deliberately absent rather ' +
      'than fabricated.',
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

  @Get('accounts/:id/deals')
  @ApiCookieAuth()
  @ApiOperation({
    summary: "One account's deal history — trades and money movements, paged",
    description:
      'Every deal MT5 has reported for this account, newest first by the time MT5 says it ' +
      'happened. `kind=trades` narrows to market activity; `kind=balance` to deposits, ' +
      'withdrawals, credits, commissions and the rest. Absent returns everything.\n\n' +
      'These are CLOSED deals. Open positions are not here and are not anywhere: the bridge ' +
      'ingests deals, and nothing feeds the `positions` table.\n\n' +
      'An account with no MT5 login returns an empty page — deals are keyed by login, so it has ' +
      'none by definition rather than by a query that found nothing.',
  })
  @ApiOkResponse({ type: AccountDealPageDto })
  myAccountDeals(
    @Req() req: Request & { user: User },
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListAccountDealsQueryDto,
  ) {
    return this.trading.listDealsMine(req.user.id, id, query);
  }

  @Get('accounts/:id/stats')
  @ApiCookieAuth()
  @ApiOperation({
    summary: "One account's realised performance, summed in the database",
    description:
      'Closed round trips only — opening deals carry no realised result and counting them would ' +
      'drag every average toward zero. Balance operations are excluded: a deposit is not a ' +
      'winning trade.\n\n' +
      '`wins + losses` need NOT equal `trades`: a trade closing at exactly zero is neither. A win ' +
      'rate divides by `trades`.\n\n' +
      'Realised figures only. Floating P/L is on `/live`, because it belongs to MT5 and to this ' +
      'instant rather than to the history.',
  })
  @ApiOkResponse({ type: AccountStatsDto })
  myAccountStats(@Req() req: Request & { user: User }, @Param('id', ParseUUIDPipe) id: string) {
    return this.trading.statsMine(req.user.id, id);
  }
}
