import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { EmailVerifiedGuard } from '../identity/guards/email-verified.guard';
import { User } from '../../store/users.store';
import { DashboardService } from './dashboard.service';
import { DashboardDto } from './dto/dashboard.dto';

/**
 * The client's landing page.
 *
 * `JwtAuthGuard` plus `EmailVerifiedGuard`, matching wallet, payments, KYC, IB
 * and trading: this response carries balances, transaction history and MT5
 * logins, and until the address is proved "the signed-in client" is a claim
 * nobody has checked.
 *
 * The owner comes from the session. There is no `:userId` and there must never
 * be one — this route is authenticated but not permission-gated, so a
 * caller-supplied owner is the whole distance between "my dashboard" and
 * "anybody's".
 */
@ApiTags('trading')
@UseGuards(JwtAuthGuard, EmailVerifiedGuard)
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  @ApiCookieAuth()
  @ApiOperation({
    summary: "Everything the client's landing page renders, in one request",
    description:
      'Wallets, recent transactions, trading accounts, open positions and five counts.\n\n' +
      'ONE request rather than six because these are read in a single glance: a balance from one ' +
      'instant beside a transaction list from another is a screen that contradicts itself, and ' +
      'six requests give the portal six ways to half-fail.\n\n' +
      'Every figure is counted from a table. The screen this replaces carried hardcoded zeros for ' +
      '"trading accounts" and "pending transactions" with no endpoint behind either, so a client ' +
      'holding three accounts read 0.\n\n' +
      '`openPositions` is empty for everyone until an MT5 bridge writes to `positions` — but the ' +
      'query is real, so that emptiness is a database answer rather than a frontend assumption.',
  })
  @ApiOkResponse({ type: DashboardDto })
  myDashboard(@Req() req: Request & { user: User }) {
    return this.dashboard.forUser(req.user.id);
  }
}
