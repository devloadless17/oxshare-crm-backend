import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { EmailVerifiedGuard } from '../identity/guards/email-verified.guard';
import { User } from '../../store/users.store';
import { TradingService } from './trading.service';
import { TradingAccountDto } from './dto/trading-account.dto';

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
}
