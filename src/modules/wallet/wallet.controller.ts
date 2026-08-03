import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { User } from '../../store/users.store';
import { WalletService } from './wallet.service';

@ApiTags('wallet')
@UseGuards(JwtAuthGuard)
@Controller('wallet')
export class WalletController {
  constructor(private readonly wallets: WalletService) {}

  @Get()
  @ApiCookieAuth()
  @ApiOperation({
    summary: "The signed-in client's wallets — balance, on_hold and available, all as strings",
  })
  myWallets(@Req() req: Request & { user: User }) {
    return this.wallets.listWallets(req.user.id);
  }

  @Get('ledger')
  @ApiCookieAuth()
  @ApiOperation({ summary: "The signed-in client's own ledger entries" })
  myLedger(@Req() req: Request & { user: User }) {
    return this.wallets.listEntries({ userId: req.user.id, limit: 100 });
  }
}
