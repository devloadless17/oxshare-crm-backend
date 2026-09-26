import { Body, Controller, Get, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { EmailVerifiedGuard } from '../identity/guards/email-verified.guard';
import { User } from '../../store/users.store';
import { WalletService } from './wallet.service';
import { LedgerListResponseDto, StatementDto, WalletDto } from './dto/wallet-response.dto';
import { OpenWalletDto } from './dto/open-wallet.dto';
import { StatementService } from './statement.service';
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
  constructor(
    private readonly wallets: WalletService,
    private readonly statements: StatementService,
  ) {}

  @Get()
  @ApiCookieAuth()
  @ApiOperation({
    summary: "The signed-in client's wallets — balance, on_hold and available, all as strings",
  })
  @ApiOkResponse({ type: [WalletDto] })
  myWallets(@Req() req: Request & { user: User }) {
    return this.wallets.listWallets(req.user.id);
  }

  /**
   * Open a wallet in an offered currency — the portal's "Open wallet" card.
   *
   * Adding a currency opens no wallets (a write per client does not scale);
   * the client opens the one they want. Idempotent, so a double click returns
   * the same wallet. Throttled loosely: it writes one row, but nothing should
   * be able to hammer it.
   */
  @Post()
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Open a wallet in an offered currency for the signed-in client',
    description:
      'Refused for a currency that does not exist or is disabled. Opening one the client ' +
      'already holds returns it unchanged.',
  })
  @ApiCreatedResponse({ type: WalletDto })
  openWallet(@Req() req: Request & { user: User }, @Body() dto: OpenWalletDto) {
    return this.wallets.openOwnWallet(req.user.id, dto.currency);
  }

  /**
   * One wallet's account statement for a period — opening balance, every line
   * with its running balance, closing balance. See `statement.service.ts`.
   *
   * The wallet must be the caller's own; anyone else's answers 404.
   */
  @Get('statement')
  @ApiCookieAuth()
  @ApiOperation({ summary: "An account statement for one of the signed-in client's wallets" })
  @ApiOkResponse({ type: StatementDto })
  statement(
    @Req() req: Request & { user: User },
    @Query('walletId', new ParseUUIDPipe()) walletId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    return this.statements.forWallet(req.user.id, walletId, from ?? '', to ?? '');
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
