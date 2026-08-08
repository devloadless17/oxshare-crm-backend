import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
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
  constructor(private readonly trading: TradingService) {}

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
