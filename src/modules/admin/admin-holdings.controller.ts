import { Throttle } from '@nestjs/throttler';
// Part of the `admin` controller surface, split by concern — the same shape as
// admin-clients.controller.ts and admin-money.controller.ts. Nest allows several
// controllers to share one @Controller prefix, so these routes sit alongside the
// rest of /admin without a new segment.
//
// @ApiTags('admin') is repeated here so Swagger groups them as one tag and the
// generated types.gen.ts stays one coherent surface.

import { Controller, Get, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { AdminHoldingsService } from './admin-holdings.service';
import { TRADING_ACCOUNT_SORT_COLUMNS, WALLET_SORT_COLUMNS } from './admin-holdings.service';
import { AdminExportService } from './admin-export.service';
import { AdminAuditService } from './admin-audit.service';
import { exportFormat, streamCsv, EXPORT_RATE_LIMIT } from '../../common/export/export-response';
import {
  ClientClosedPositionsPageDto,
  ClientTransactionsPageDto,
  TradingAccountListResponseDto,
  WalletListResponseDto,
} from './dto/responses.dto';
import {
  PermissionsGuard,
  RequirePermissions,
  type AuthenticatedAdmin,
} from './guards/admin.guard';
import { enumQuery, uuidQuery } from '../../common/query-params';
import { ClientRefPipe } from '../../common/client-ref.pipe';
import { tradingAccountStatusEnum, tradingEnvironmentEnum } from '../../database/schema';
import { ScopedToClients } from './guards/client-scope.decorator';
import { Audited } from './guards/audited.decorator';

/**
 * What clients HOLD: wallet balances, and trading accounts.
 *
 * Both screens rendered an honest `BackendPending` placeholder in the admin app
 * because neither endpoint existed — a balance table showing `$0.00` for want of
 * an endpoint is indistinguishable from a client who genuinely holds nothing,
 * and a fabricated trading account is one an operator believes exists. These are
 * the two routes those placeholders named.
 *
 * ── Permissions, and why these two keys ─────────────────────────────────────
 *
 * `withdrawals.view` for wallets. A wallet balance IS money data, and that key
 * already gates the two other screens showing the same numbers — the withdrawal
 * queue (which displays the amount leaving a wallet) and `GET /admin/ledger`
 * (which displays every movement through one, with `balance_after`). Gating the
 * balances themselves on something weaker would make the list a way to read
 * money data without the money permission. `withdrawals` is also the catalog
 * module whose description is about paying clients, which is what a balance is
 * a claim on.
 *
 * `users.view` for trading accounts. Not money-first: the columns are a login,
 * an MT5 group, a leverage, a tier and a status — client account configuration,
 * the same material `GET /admin/clients/:id` already serves under `users.view`
 * in its `tradingAccounts` section. Requiring `withdrawals.view` here would deny
 * the standalone list to admins who can already see the identical rows on the
 * client profile, which is a permission model disagreeing with itself.
 *
 * The `balance` column is the awkward part of that reasoning and is worth
 * stating rather than glossing: it is money, and it is served under a non-money
 * key. It is a CRM-owned placeholder until the MT5 bridge lands (see the schema
 * comment on the column), it is already exposed on the client profile under this
 * same key, and it is not a claim the platform will pay out — unlike a wallet
 * balance. If it ever becomes authoritative, this route should move to a money
 * key with it.
 *
 * ── Client scope ────────────────────────────────────────────────────────────
 *
 * Both are client-owned records, so both apply `clientScopePredicate` in the
 * WHERE clause. A scoped admin's out-of-scope row never enters the result set,
 * which is also why it cannot enter the `total` or the cursor.
 */
@ApiTags('admin')
@Controller('admin')
export class AdminHoldingsController {
  constructor(
    private readonly holdings: AdminHoldingsService,
    private readonly exports: AdminExportService,
    private readonly audit: AdminAuditService,
  ) {}

  // ── Wallets ───────────────────────────────────────────────────────────────

  /**
   * The wallet list as a CSV file — every row matching the filters, not a page.
   *
   * ── DECLARED BEFORE the list, matching the other exports ───────────────────
   *
   * There is no `wallets/:id` GET for this to be shadowed by, so unlike
   * `clients/export` its position is not load-bearing. It is placed first anyway
   * so every export route in this repo sits in the same place relative to its
   * list — a reader looking for one knows where to look, and the next person to
   * add a `wallets/:id` route does not create the trap.
   */
  @Get('wallets/export')
  /*
   * A ceiling on a STREAMING read of the whole client base.
   *
   * Every export here is batched over the full filtered set and held open for
   * the length of the download, and none carried anything but the global
   * 120/min — which is sized for a person clicking around a console, not for
   * 120 concurrent full-table CSV streams. The limit is per route per IP, so a
   * desk exporting clients and then withdrawals is unaffected; what it bounds is
   * one caller pulling the same export in a loop.
   *
   * Six a minute: far above any human use of an Export button, far below what
   * it takes to hurt the database.
   */
  @Throttle({ default: { ttl: 60_000, limit: EXPORT_RATE_LIMIT } })
  @UseGuards(PermissionsGuard)
  // The SAME permission as the list. An export must never be a way around one.
  @RequirePermissions('wallets.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Export the filtered wallet list as CSV',
    description:
      'The same `userId` and `currency` filters as GET /admin/wallets, over every matching row ' +
      'rather than one page. Balances are the exact decimal strings the column holds — never ' +
      'rounded, never locale-formatted (§6.1). Client scope applies exactly as it does to the ' +
      'list.',
  })
  @ApiOkResponse({
    description: 'A CSV file. `Content-Disposition` names it `wallets-<YYYY-MM-DD>.csv`.',
    content: { 'text/csv': { schema: { type: 'string', format: 'binary' } } },
  })
  // `required: false` on every one: without it Swagger marks each as required
  // and the generated frontend types demand filters an "export everything" call
  // legitimately omits.
  @ApiQuery({ name: 'format', required: false, enum: ['csv'] })
  @ApiQuery({ name: 'userId', required: false, description: 'Wallets of one client.' })
  @ApiQuery({ name: 'currency', required: false, description: 'Exact match on the wallet code.' })
  @ScopedToClients(
    'AdminExportService.walletBatch → AdminHoldingsService.walletExportBatch, the same clientScopePredicate on wallets.user_id the list applies.',
  )
  /*
   * AUDITED, though it is a GET — the exception argued in audit-actions.catalog.
   * A page of balances on a screen and a file of every client's money on a
   * laptop are different acts, and only one of them needs to be attributable
   * afterwards.
   */
  @Audited('export.wallets')
  async exportWallets(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Res() res: Response,
    @Query('format') format?: string,
    @Query('userId', ClientRefPipe) userId?: string,
    @Query('currency') currency?: string,
  ) {
    const chosen = exportFormat(format);
    // Shape-checked, so a typo is a 400 here and on the list alike.
    const query = { userId: uuidQuery(userId, 'userId'), currency };

    this.audit.record(req.admin.id, 'export.wallets', 'wallet_list', req.admin.id, {
      format: chosen,
      filters: query,
    });

    /*
     * ONE instant for the whole run. The batches page by OFFSET and the ordering
     * is `created_at DESC`, so without this a row inserted mid-export shifts
     * every later offset and writes a boundary row to the file twice.
     */
    const startedAt = new Date();
    await streamCsv(res, 'wallets', chosen, this.exports.walletColumns, (offset, limit) =>
      this.exports.walletBatch(query, req.admin, offset, limit, startedAt),
    );
  }

  @Get('wallets')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('wallets.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Every client wallet, with its owner (balances are strings)',
    description:
      '`balance` and `onHold` are NUMERIC(28,8) and cross this boundary as STRINGS. Do not ' +
      'coerce them: Number() on a value of this width loses precision before formatting even ' +
      'starts (§6.1).',
  })
  @ApiOkResponse({ type: WalletListResponseDto })
  /*
   * Declared OPTIONAL, explicitly — without these, Swagger emits every `@Query()`
   * as `required: true` and the frontends' generated types then demand all eight
   * parameters on a call that legitimately passes none of them.
   */
  @ApiQuery({ name: 'userId', required: false, description: 'Wallets of one client.' })
  @ApiQuery({ name: 'currency', required: false, description: 'Exact match on the wallet code.' })
  @ApiQuery({
    name: 'q',
    required: false,
    description:
      'A wallet number or the OWNER’s Portal ID (both matched exactly), or free text over the ' +
      'owner’s email and name — the identifiers this screen actually displays. ' +
      'Before this existed the only client filter was `userId`, a uuid shown nowhere on the ' +
      'page, so an operator had to fetch it from /clients first.',
  })
  @ApiQuery({ name: 'page', required: false, description: 'Legacy offset paging. Prefer cursor.' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'cursor', required: false, description: 'Opaque keyset cursor (R-2.4).' })
  @ApiQuery({ name: 'withTotal', required: false, description: 'Counting is a full scan.' })
  @ApiQuery({
    name: 'sort',
    required: false,
    enum: Object.keys(WALLET_SORT_COLUMNS),
    description: 'balance sorts on the NUMERIC column in SQL — never cast, never in JS (§6).',
  })
  @ApiQuery({ name: 'order', required: false, enum: ['asc', 'desc'] })
  @ScopedToClients(
    'AdminHoldingsService.listWallets applies clientScopePredicate to wallets.user_id, in the WHERE clause.',
  )
  listWallets(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Query('userId', ClientRefPipe) userId?: string,
    @Query('currency') currency?: string,
    @Query('q') q?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('withTotal') withTotal?: string,
    @Query('sort') sort?: string,
    @Query('order') order?: string,
  ) {
    return this.holdings.listWallets(
      {
        /*
         * SHAPE-CHECKED AT THE EDGE, so the refusal names the parameter.
         *
         * ⚠️ Not a 500 fix — `AllExceptionsFilter` already maps Postgres `22P02`
         * to a 400. What it cannot do is say WHICH value was wrong, because by
         * then all it has is a cast error. On a route taking several ids that
         * matters, and the database paid for a round trip to produce it.
         */
        userId: uuidQuery(userId, 'userId'),
        currency,
        q,
        page,
        limit,
        cursor,
        withTotal,
        // `sort`/`order` are validated in the service against the allowlist,
        // which is where the column mapping lives. Validating here too would put
        // the allowlist in two places.
        sort,
        order,
      },
      req.admin,
    );
  }

  // ── Trading accounts ──────────────────────────────────────────────────────

  @Get('trading-accounts/export')
  /*
   * A ceiling on a STREAMING read of the whole client base.
   *
   * Every export here is batched over the full filtered set and held open for
   * the length of the download, and none carried anything but the global
   * 120/min — which is sized for a person clicking around a console, not for
   * 120 concurrent full-table CSV streams. The limit is per route per IP, so a
   * desk exporting clients and then withdrawals is unaffected; what it bounds is
   * one caller pulling the same export in a loop.
   *
   * Six a minute: far above any human use of an Export button, far below what
   * it takes to hurt the database.
   */
  @Throttle({ default: { ttl: 60_000, limit: EXPORT_RATE_LIMIT } })
  @UseGuards(PermissionsGuard)
  @RequirePermissions('trading.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Export the filtered trading-account list as CSV',
    description:
      'The same filters as GET /admin/trading-accounts, over every matching row rather than one ' +
      'page. Balances are the exact decimal strings the column holds. Client scope applies ' +
      'exactly as it does to the list.',
  })
  @ApiOkResponse({
    description: 'A CSV file. `Content-Disposition` names it `trading-accounts-<YYYY-MM-DD>.csv`.',
    content: { 'text/csv': { schema: { type: 'string', format: 'binary' } } },
  })
  @ApiQuery({ name: 'format', required: false, enum: ['csv'] })
  @ApiQuery({ name: 'userId', required: false, description: 'Accounts of one client.' })
  @ApiQuery({ name: 'environment', required: false, enum: tradingEnvironmentEnum.enumValues })
  @ApiQuery({ name: 'status', required: false, enum: tradingAccountStatusEnum.enumValues })
  @ScopedToClients(
    'AdminExportService.tradingAccountBatch → AdminHoldingsService.tradingAccountExportBatch, the same clientScopePredicate on trading_accounts.user_id the list applies.',
  )
  @Audited('export.trading_accounts')
  async exportTradingAccounts(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Res() res: Response,
    @Query('format') format?: string,
    @Query('userId', ClientRefPipe) userId?: string,
    @Query('environment') environment?: string,
    @Query('status') status?: string,
  ) {
    const chosen = exportFormat(format);
    // Validated identically to the list route, so an unrecognised value is the
    // same 400 there and here rather than a silently empty file.
    const query = {
      userId: uuidQuery(userId, 'userId'),
      environment: enumQuery(environment, tradingEnvironmentEnum.enumValues, 'environment'),
      status: enumQuery(status, tradingAccountStatusEnum.enumValues, 'status'),
    };

    this.audit.record(
      req.admin.id,
      'export.trading_accounts',
      'trading_account_list',
      req.admin.id,
      { format: chosen, filters: query },
    );

    // Same snapshot bound as the wallet export above.
    const startedAt = new Date();
    await streamCsv(
      res,
      'trading-accounts',
      chosen,
      this.exports.tradingAccountColumns,
      (offset, limit) =>
        this.exports.tradingAccountBatch(query, req.admin, offset, limit, startedAt),
    );
  }

  @Get('trading-accounts')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('trading.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Every client trading account, with its owner (balances are strings)',
    description:
      '`balance` is CRM-owned until the MT5 bridge lands and crosses this boundary as a STRING. ' +
      '`login` is NULL until MT5 issues one, and is a string rather than a number because ' +
      'leading zeros are significant to the bridge.',
  })
  @ApiOkResponse({ type: TradingAccountListResponseDto })
  @ApiQuery({ name: 'userId', required: false, description: 'Accounts of one client.' })
  @ApiQuery({
    name: 'referredBy',
    required: false,
    description:
      'Accounts of every client this partner introduced, by the partner’s Portal ID ' +
      '(users.referred_by_ib_user_id). Scoped like every other filter.',
  })
  @ApiQuery({
    name: 'q',
    required: false,
    description:
      'A number matches the MT5 login OR the owner’s Portal ID — both exact, because an ' +
      'operator holding one cannot tell which it is. Anything else searches the OWNER by email ' +
      'or name — the identifiers the Owner column displays.',
  })
  @ApiQuery({ name: 'environment', required: false, enum: tradingEnvironmentEnum.enumValues })
  @ApiQuery({ name: 'status', required: false, enum: tradingAccountStatusEnum.enumValues })
  @ApiQuery({ name: 'page', required: false, description: 'Legacy offset paging. Prefer cursor.' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'cursor', required: false, description: 'Opaque keyset cursor (R-2.4).' })
  @ApiQuery({ name: 'withTotal', required: false, description: 'Counting is a full scan.' })
  @ApiQuery({
    name: 'sort',
    required: false,
    enum: Object.keys(TRADING_ACCOUNT_SORT_COLUMNS),
    description: 'login is nullable and pins NULLS LAST in both directions.',
  })
  @ApiQuery({ name: 'order', required: false, enum: ['asc', 'desc'] })
  @ScopedToClients(
    'AdminHoldingsService.listTradingAccounts applies clientScopePredicate to trading_accounts.user_id, in the WHERE clause.',
  )
  listTradingAccounts(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Query('userId', ClientRefPipe) userId?: string,
    @Query('referredBy', ClientRefPipe) referredBy?: string,
    @Query('q') q?: string,
    @Query('environment') environment?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('withTotal') withTotal?: string,
    @Query('sort') sort?: string,
    @Query('order') order?: string,
  ) {
    return this.holdings.listTradingAccounts(
      {
        /*
         * SHAPE-CHECKED AT THE EDGE, so the refusal names the parameter.
         *
         * ⚠️ Not a 500 fix — `AllExceptionsFilter` already maps Postgres `22P02`
         * to a 400. What it cannot do is say WHICH value was wrong, because by
         * then all it has is a cast error. On a route taking several ids that
         * matters, and the database paid for a round trip to produce it.
         */
        userId: uuidQuery(userId, 'userId'),
        referredBy: uuidQuery(referredBy, 'referredBy'),
        q,
        // Both are Postgres enum columns compared behind a cast in the service,
        // so an unrecognised value surfaced as a 500 carrying a database error
        // rather than the 400 R-2.5 asks for. Validated in the service, which is
        // where the schema enums are already imported.
        environment,
        status,
        page,
        limit,
        cursor,
        withTotal,
        sort,
        order,
      },
      req.admin,
    );
  }

  // ── One client's trading activity ─────────────────────────────────────────

  /**
   * A client's CLOSED positions — the profile's Positions tab.
   *
   * Built from the ingested MT5 deals, the same rows the portal's account
   * history and the commission engine read. The `positions` table this used to
   * read is never written on the live path, so the tab was always empty. Open
   * positions are not listed (owner, 26 Sep 2026).
   */
  @Get('clients/:id/closed-positions')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('trading.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'One client’s closed positions, from the ingested MT5 deals',
    description:
      'One row per closing deal on any of the client’s accounts, newest first. The opening ' +
      'deal supplies the open price, open time and side when it was ingested; they are null ' +
      'otherwise, except the side. Commission is the opening and closing deal together. ' +
      'Prices and money are strings (§6.1).',
  })
  @ApiOkResponse({ type: ClientClosedPositionsPageDto })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ScopedToClients(
    'AdminHoldingsService.listClientClosedPositions applies clientScopePredicate to trading_accounts.user_id, in the WHERE clause.',
  )
  listClientClosedPositions(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Param('id', ClientRefPipe) id: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.holdings.listClientClosedPositions({
      userId: id,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
      scope: req.admin.clientScope,
    });
  }

  /**
   * A client's transactions — every movement of their money, newest first.
   *
   * All directions in ONE list. Deposits, withdrawals and transfers are a
   * single history from the operator's side, and splitting them would make
   * "what happened to this balance" a question answered by merging three lists
   * by eye.
   */
  @Get('clients/:id/transactions')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('wallets.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'One client’s money movements, all directions',
    description: '`amount` is a decimal string (§6.1), never a number.',
  })
  @ApiOkResponse({ type: ClientTransactionsPageDto })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ScopedToClients(
    'AdminHoldingsService.listClientTransactions applies clientScopePredicate to transactions.user_id, in the WHERE clause.',
  )
  listClientTransactions(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Param('id', ClientRefPipe) id: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.holdings.listClientTransactions({
      userId: id,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
      scope: req.admin.clientScope,
    });
  }
}
