import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { EmailVerifiedGuard } from '../identity/guards/email-verified.guard';
import { User } from '../../store/users.store';
import { WalletService } from './wallet.service';
import { LedgerListResponseDto, WalletDto } from './dto/wallet-response.dto';
import { decodeCursor } from '../../common/pagination';
import { enumQuery } from '../../common/query-params';
import { ledgerEntryTypeEnum } from '../../database/schema';

/**
 * `EmailVerifiedGuard` alongside the auth guard, matching KYC, IB and payments.
 *
 * It was missing here, and this controller is the one that reads MONEY — wallet
 * balances and the client's own ledger. Authentication alone was never the
 * intended bar on the client surface: the address is the account's recovery
 * channel, so until it is proved, "the signed-in client" is a claim nobody has
 * checked. Every other client-facing controller already said so; this one
 * simply never got the guard.
 *
 * `auth.controller.ts` is the deliberate exception — sign-in, verification and
 * resend must all be reachable by an unverified caller, or there is no way to
 * become verified.
 */
@ApiTags('wallet')
@UseGuards(JwtAuthGuard, EmailVerifiedGuard)
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
  myLedger(
    @Req() req: Request & { user: User },
    @Query('entryType') entryType?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    /*
     * The service has always accepted paging; this handler discarded it and
     * hardcoded `limit: 100`, so a client with more than 100 ledger rows could
     * not reach their own older entries by any means. The ledger is append-only
     * and never stops growing, so every funded account crosses that line
     * eventually — and the party with the strongest incentive to spot an error
     * in it was the one who could not look.
     *
     * `userId` stays derived from the session and is NOT a parameter. It is the
     * only thing standing between this endpoint and any client reading another
     * client's ledger, so it must not be something a caller can supply — the
     * admin ledger takes a `userId` filter precisely because that route is
     * permission-gated and this one is not.
     *
     * Keyset only, no `page`: R-2.4, and it matters more here than on any other
     * list. Offset paging over a set being appended to skips rows, and a client
     * checking their own history against their own records must not be shown a
     * page that quietly omits a transaction.
     */
    return this.wallets.listEntries({
      userId: req.user.id,
      entryType: enumQuery(entryType, ledgerEntryTypeEnum.enumValues, 'entryType'),
      limit,
      cursor: cursor ? decodeCursor(cursor) : undefined,
    });
  }
}
