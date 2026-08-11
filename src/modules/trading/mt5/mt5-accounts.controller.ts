import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { ParseUUIDPipe } from '@nestjs/common';
import { Mt5AccountsService } from './mt5-accounts.service';
import { CreateMt5AccountDto, Mt5BalanceDto, Mt5LiveBalancesDto } from './dto/mt5-account.dto';
import {
  PermissionsGuard,
  RequirePermissions,
  type AuthenticatedAdmin,
} from '../../admin/guards/admin.guard';
import { ScopedToClients } from '../../admin/guards/client-scope.decorator';
import { Audited, NotAudited } from '../../admin/guards/audited.decorator';

/**
 * The back office's write surface onto MT5: open an account, move its balance.
 *
 * ## Why these live on the `admin` prefix but not in the admin module
 *
 * The routes belong to the admin surface and are gated by its guards, but the
 * behaviour belongs to trading — it talks to the bridge, understands MT5 groups
 * and knows what a dealer operation is. Putting the controller here keeps that
 * knowledge next to the service and the bridge client; Nest is happy for
 * several modules to contribute routes under one prefix, which
 * `admin-holdings.controller.ts` already relies on.
 *
 * ## Reads stay where they were
 *
 * `GET /admin/trading-accounts` is still served by `AdminHoldingsController`
 * off our own table. Only the calls that CROSS to MT5 are here, and the split
 * is the same one the service documents: one side is a database query, the
 * other is a network call to a server we do not own.
 */
@ApiTags('admin')
@Controller('admin')
export class Mt5AccountsController {
  constructor(private readonly accounts: Mt5AccountsService) {}

  /**
   * The groups an account may be opened in.
   *
   * Gated on `trading.create` rather than `trading.view`: the only reason to
   * read this list is to open an account with it, and it exposes the broker's
   * internal group structure — leverage tiers, commission plans, which
   * segments exist — to anyone who can see the accounts screen otherwise.
   */
  @Get('mt5/groups')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('trading.create')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'MT5 groups an account may be opened in, read live from the server' })
  @ScopedToClients('Reads MT5 server configuration. No client rows are involved.')
  listGroups(@Req() req: Request & { admin: AuthenticatedAdmin }) {
    return this.accounts.listGroups(req.admin);
  }

  /**
   * Open an account on MT5 for a client.
   *
   * The response carries the master and investor passwords, ONCE. They are not
   * stored and cannot be re-read — the same contract as an API key, for the
   * same reason. A console that does not show them immediately has lost them.
   */
  @Post('trading-accounts')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('trading.create')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Open an MT5 trading account for a client',
    description:
      'Creates the account on the MT5 server FIRST and records it locally second, so a bridge ' +
      'failure leaves no row pointing at an account that does not exist. Returns the master and ' +
      'investor passwords once; they are never stored.',
  })
  @ScopedToClients(
    'Mt5AccountsService.createAccount reads the target client by id. A scoped admin must not ' +
      'open accounts for clients outside their territory.',
  )
  @Audited('trading.account_create')
  create(@Req() req: Request & { admin: AuthenticatedAdmin }, @Body() dto: CreateMt5AccountDto) {
    return this.accounts.createAccount(
      {
        userId: dto.userId,
        group: dto.group,
        environment: dto.environment,
        leverage: dto.leverage,
      },
      req.admin,
    );
  }

  /**
   * Credit or debit a trading account on MT5.
   *
   * ## One route, two permissions
   *
   * `direction` decides which of `trading.deposit` and `trading.withdraw` is
   * required, and the service checks it — not this decorator, which can only
   * name a fixed key. `@RequirePermissions('trading.view')` here is the FLOOR:
   * it stops an admin with no trading access at all reaching the handler, and
   * the real gate is `assertActorCan` inside.
   *
   * Splitting into two routes would let the decorator carry it, and was
   * rejected: the two operations differ by a sign on one field, and two nearly
   * identical handlers is how the sign ends up wrong in one of them.
   */
  @Post('trading-accounts/:id/balance')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('trading.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Credit or debit a trading account directly on MT5',
    description:
      'A DEALER operation with no wallet leg — for corrections, bonuses and manual settlement. ' +
      'Funding an account from a client wallet is a transfer (POST /transfers), which holds and ' +
      'posts both sides. Requires trading.deposit or trading.withdraw depending on direction.',
  })
  @ScopedToClients(
    'Moves money on one client trading account. A scoped admin must not fund accounts outside ' +
      'their territory.',
  )
  @Audited('trading.deposit')
  balance(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: Mt5BalanceDto,
  ) {
    return this.accounts.adjustBalance(
      { accountId: id, amount: dto.amount, direction: dto.direction, comment: dto.comment },
      req.admin,
    );
  }

  /**
   * Live balances for a page of accounts, keyed by account id.
   *
   * POST rather than GET, and that is not REST pedantry: the ids are a list of
   * up to twenty-five UUIDs, which is roughly 900 characters of query string —
   * inside most limits and not all of them, and truncation here would silently
   * refresh some rows and not others.
   */
  @Post('trading-accounts/live-balances')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('trading.view')
  @HttpCode(HttpStatus.OK)
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Live MT5 balances for the accounts on one page',
    description:
      'One bridge call per account, so the list is capped. An account MT5 will not answer for ' +
      'is simply absent from the result and the console falls back to its cached figure.',
  })
  @ScopedToClients('Reads balances for client trading accounts the caller can already list.')
  @NotAudited(
    'A READ of balances the caller can already see on the list endpoint, refreshed. Recording ' +
      'it would add a row per page load of a screen operators leave open.',
  )
  liveBalances(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Body() dto: Mt5LiveBalancesDto,
  ) {
    return this.accounts.liveBalances(dto.accountIds, req.admin);
  }

  /**
   * What MT5 says this account holds right now.
   *
   * Distinct from the `balance` column on the list endpoint, which is a cache
   * that goes stale the moment the client opens a position. Any screen showing
   * money should be explicit about which of the two it is displaying.
   */
  @Get('trading-accounts/:id/live')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('trading.view')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Live balance and margin for one account, read from MT5' })
  @ApiOkResponse({ description: 'Null when the account has no MT5 login yet.' })
  @ScopedToClients('Reads one client trading account.')
  live(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.accounts.liveSnapshot(id, req.admin);
  }
}
