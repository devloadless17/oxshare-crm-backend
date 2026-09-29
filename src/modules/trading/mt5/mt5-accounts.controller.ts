import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { ParseUUIDPipe } from '@nestjs/common';
import { Mt5AccountsService } from './mt5-accounts.service';
import {
  CreateMt5AccountDto,
  CreatedMt5AccountDto,
  LinkedMt5AccountDto,
  LinkMt5AccountDto,
  Mt5AccountLookupDto,
  Mt5AccountsSyncRunDto,
  SetTradingAccountProductDto,
  TradingAccountProductDto,
} from './dto/mt5-account.dto';
import {
  PermissionsGuard,
  RequirePermissions,
  type AuthenticatedAdmin,
} from '../../admin/guards/admin.guard';
import { NotClientScoped, ScopedToClients } from '../../admin/guards/client-scope.decorator';
import { Audited } from '../../admin/guards/audited.decorator';
import { Mt5AccountDirectoryScheduler } from './mt5-account-directory.scheduler';
import { AdminAuditService } from '../../admin/admin-audit.service';

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
  constructor(
    private readonly accounts: Mt5AccountsService,
    private readonly directory: Mt5AccountDirectoryScheduler,
    private readonly audit: AdminAuditService,
  ) {}

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
  @NotClientScoped('Reads MT5 server configuration. No client rows are involved.')
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
  @ApiOkResponse({ type: CreatedMt5AccountDto })
  create(@Req() req: Request & { admin: AuthenticatedAdmin }, @Body() dto: CreateMt5AccountDto) {
    return this.accounts.createAccount(
      {
        userId: dto.userId,
        group: dto.group,
        productId: dto.productId,
        environment: dto.environment,
        leverage: dto.leverage,
      },
      req.admin,
    );
  }

  /*
   * ── Linking an EXISTING MT5 account to a client (owner, 29 Sep 2026) ───────
   *
   * Search the client, look the login up, see both side by side, link, choose
   * the product. `trading.create`: linking gives a client an account exactly as
   * opening one does, and pays commission on it from the next run.
   */

  /** One MT5 login, for the link screen — MT5's account and holder, and its options. */
  @Get('mt5/accounts/:login')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('trading.create')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Look up an MT5 login to link it to a client',
    description:
      "MT5's snapshot and holder name/email, the products that sell its group, whether the CRM " +
      'already owns the login (the owner is named only inside your territory), and how many of ' +
      'its deals are waiting to accrue. Read-only.',
  })
  @ApiOkResponse({ type: Mt5AccountLookupDto })
  @NotClientScoped(
    'The path names an MT5 login, not a client. When the CRM already owns the login, the owner ' +
      'is resolved with clientScopePredicate and named only inside the reader territory.',
  )
  lookup(@Req() req: Request & { admin: AuthenticatedAdmin }, @Param('login') login: string) {
    return this.accounts.lookupMt5Account(login, req.admin);
  }

  /** Link a login MT5 already has to a client, with its product. */
  @Post('trading-accounts/link')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('trading.create')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Link an existing MT5 account to a client',
    description:
      'Records the login under the client with its product; its waiting deals accrue on the next ' +
      'commission run. Refuses a login the CRM already has (409), one MT5 does not have (404), a ' +
      'currency the platform does not hold, and a product that does not sell the group.',
  })
  @ScopedToClients(
    'Mt5AccountsService.linkMt5Account reads the target client with clientScopePredicate; a ' +
      'client outside the territory is 404, like one that does not exist.',
  )
  @Audited('trading.account_link')
  @ApiOkResponse({ type: LinkedMt5AccountDto })
  link(@Req() req: Request & { admin: AuthenticatedAdmin }, @Body() dto: LinkMt5AccountDto) {
    return this.accounts.linkMt5Account(
      { userId: dto.userId, login: dto.login, productId: dto.productId },
      req.admin,
    );
  }

  /**
   * "Sync now": bring MT5's accounts into the CRM (owner, 29 Sep 2026). A login
   * the CRM has no account for is recorded with NO client, for an operator to
   * assign. A batch of 50 inside half a minute; the scheduled runs, every ten
   * minutes, take the rest.
   */
  @Post('trading-accounts/sync')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('trading.create')
  @ApiCookieAuth()
  @ApiOperation({
    summary: "Sync MT5's accounts into the CRM",
    description:
      'Records every MT5 login the CRM has no account for, with no client; they list under ' +
      'GET /admin/trading-accounts?client=unassigned. 409 while another sync runs.',
  })
  @NotClientScoped(
    'Reads the MT5 login list and records accounts with NO client; nothing is read or written ' +
      'about any existing client. The rows it writes are listed only to readers who see every client.',
  )
  @Audited('trading.accounts_sync')
  @ApiOkResponse({ type: Mt5AccountsSyncRunDto })
  async syncAccounts(@Req() req: Request & { admin: AuthenticatedAdmin }) {
    const run = await this.directory.syncNow();
    this.audit.record(req.admin.id, 'trading.accounts_sync', 'trading_account_list', req.admin.id, {
      onServer: run.onServer,
      added: run.added,
      remaining: run.remaining,
      removed: run.removed,
    });
    return run;
  }

  /** Set, change or clear the product a trading account's trades pay under. */
  @Patch('trading-accounts/:id/product')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('trading.create')
  @ApiCookieAuth()
  @ApiOperation({
    summary: "Set a trading account's product",
    description:
      "The product must sell the account's MT5 group. Applies to trades not yet decided; " +
      'accruals already written keep the terms that priced them.',
  })
  @ScopedToClients(
    "Mt5AccountsService.setAccountProduct joins the account's owner under clientScopePredicate; " +
      'an account of a client outside the territory is 404.',
  )
  @Audited('trading.account_product')
  @ApiOkResponse({ type: TradingAccountProductDto })
  setProduct(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: SetTradingAccountProductDto,
  ) {
    return this.accounts.setAccountProduct(id, dto.productId, req.admin);
  }

  /*
   * `POST trading-accounts/:id/balance` USED TO BE HERE, and its removal is the
   * point of `AdminMoneyService.fundTradingAccount`.
   *
   * It was a DEALER operation: it moved the MT5 balance with no wallet leg and
   * no ledger entry, for corrections, bonuses and manual settlement. The
   * reasoning was sound in isolation — money the broker gives or takes is not a
   * client deposit — and it survived a long time on that argument.
   *
   * WHAT KILLED IT WAS THE CONSOLE, not the accounting. The trading-accounts
   * page ended up with two row actions that both moved money on the same MT5
   * account and differed only in whether anything was written down. An operator
   * choosing between "Adjust balance on MT5" and "Add funds" is not making an
   * accounting decision, and the owner's verdict was blunt: they are the same
   * act, so there should be one control, and it should be the one that records.
   *
   * The cost of the wrong pick was asymmetric and invisible. Money moved through
   * this route appeared in NO client statement, NO ledger entry and NO financial
   * report — a debit especially, which took money off a client's account with no
   * record anywhere in the CRM. The portal grew a whole panel to surface these,
   * and that panel then double-showed real transfers under a heading claiming
   * the wallet was untouched. Two defects, both descended from this route
   * existing.
   *
   * So every console money movement is now recorded: a bonus arrives as a real
   * deposit on the client's statement, which is the more honest answer anyway.
   * `POST /admin/trading-accounts/:id/fund` carries both directions.
   *
   * Nothing else called this. `fundOwnDemoAccount` below is the CLIENT's own
   * demo top-up and is untouched — it is the reason demo accounts need no
   * operator balance control at all.
   */

  /*
   * `POST trading-accounts/live-balances` USED TO BE HERE, and its removal is
   * the point of the balance mirror.
   *
   * It read one bridge call per account, sequentially, for every row on the
   * page. Every MT5 call is serialised behind the bridge's single session lock,
   * so a page load queued twenty-five acquisitions — and the connection
   * supervisor needs that same lock to rebuild a dropped session. The screen
   * showing the estate was the reason the estate could not reconnect, and it
   * fired whether or not anybody cared about any of those numbers.
   *
   * `trading_accounts.balance` is now a mirror the bridge refreshes on its sweep
   * (migration 0081), and the list reads it with `balanceSyncedAt` beside it so
   * the age is visible rather than implied.
   *
   * The SINGLE-account live read below stays, and always was going to: it is one
   * call, asked for deliberately, on the screen where somebody is looking at one
   * account — and it carries equity, margin and free margin, which are
   * deliberately not mirrored because they move on every tick.
   */

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
