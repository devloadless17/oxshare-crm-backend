import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { User } from '../../store/users.store';
import { TradingService } from './trading.service';
import { TradingAccountDto } from './dto/trading-account.dto';

@ApiTags('trading')
// The `version: '1'` argument this used to carry was inert — main.ts never
// called enableVersioning(). With setGlobalPrefix('v1') now in place it would be
// worse than inert: two version mechanisms declared, one of them fictional.
// R-2.1: do not leave both.
@Controller('trading')
export class TradingController {
  constructor(private readonly trading: TradingService) {}

  @Get('ping')
  @ApiOperation({ summary: 'Health ping for trading module' })
  ping() {
    return { module: 'trading', status: 'ready' };
  }

  /**
   * The signed-in client's own MT5 accounts, live and demo together.
   *
   * Guarded at the controller rather than globally, and the guard is
   * `JwtAuthGuard` alone — deliberately NOT `EmailVerifiedGuard` and not a KYC
   * check. Seeing which accounts you already hold is reading your own record;
   * the rules that matter are on the things that MOVE money, which is where
   * `PaymentsController` puts them. Gating this too would hide a client's own
   * account list from them for a reason that has nothing to do with reading it.
   *
   * Returns `[]` for a client with no accounts, and that is a real answer rather
   * than a 404: the question "which accounts do I have" is answerable for every
   * authenticated client, and none is a valid response to it. The portal renders
   * that as "no accounts yet", which is true, instead of as a failed request.
   */
  @Get('accounts')
  @UseGuards(JwtAuthGuard)
  @ApiCookieAuth()
  @ApiOperation({
    summary: "The signed-in client's MT5 trading accounts — live and demo, in one list",
  })
  @ApiOkResponse({ type: [TradingAccountDto] })
  myAccounts(@Req() req: Request & { user: User }) {
    return this.trading.listAccounts(req.user.id);
  }
}
