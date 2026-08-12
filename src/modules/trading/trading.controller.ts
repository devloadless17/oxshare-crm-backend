import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
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

    // Resolved BEFORE the bridge call, so an environment the broker has not
    // switched on is refused without touching MT5.
    const group = this.selfServiceGroups.resolve(dto.environment);

    return await this.mt5Accounts.createOwnAccount({
      userId: req.user.id,
      environment: dto.environment,
      group,
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
  @ApiOperation({ summary: 'Whether a client may open live and demo accounts themselves' })
  selfService() {
    return {
      live: this.selfServiceGroups.isEnabled('live'),
      demo: this.selfServiceGroups.isEnabled('demo'),
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
}
