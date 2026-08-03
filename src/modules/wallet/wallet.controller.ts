import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { User } from '../../store/users.store';
import { WalletService } from './wallet.service';
import { LedgerListResponseDto, WalletDto } from './dto/wallet-response.dto';

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
  @ApiOkResponse({ type: [WalletDto] })
  myWallets(@Req() req: Request & { user: User }) {
    return this.wallets.listWallets(req.user.id);
  }

  @Get('ledger')
  @ApiCookieAuth()
  @ApiOperation({ summary: "The signed-in client's own ledger entries" })
  // Paginated, unlike GET /wallet. The portal hand-wrote this as a bare array.
  @ApiOkResponse({ type: LedgerListResponseDto })
  myLedger(@Req() req: Request & { user: User }) {
    return this.wallets.listEntries({ userId: req.user.id, limit: 100 });
  }
}
