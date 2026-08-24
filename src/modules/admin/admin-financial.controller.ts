// Part of the `admin` controller surface, split by concern — see the header of
// admin-money.controller.ts for why several controllers share one @Controller
// prefix and what test/openapi-routes.spec.ts asserts about the inventory.

import { Controller, Get, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import {
  ADMIN_TRANSACTION_SORT_COLUMNS,
  TRANSACTION_KINDS,
  type AdminMovementsFilter,
} from '../payments/transactions.service';
import { AdminMoneyService } from './admin-money.service';
import { AdminExportService } from './admin-export.service';
import { AdminAuditService } from './admin-audit.service';
import { exportFormat, streamCsv } from '../../common/export/export-response';
import { AdminTransactionListResponseDto, AdminTransactionsSummaryDto } from './dto/responses.dto';
import {
  PermissionsGuard,
  RequirePermissions,
  type AuthenticatedAdmin,
} from './guards/admin.guard';
import { dateQuery, enumQuery, searchQuery, uuidQuery } from '../../common/query-params';
import { transactionDirectionEnum, transactionStateEnum } from '../../database/schema';
import { ScopedToClients } from './guards/client-scope.decorator';
import { Audited } from './guards/audited.decorator';

/**
 * The Financial page — ADM's platform-wide money-movement surface.
 *
 * Every deposit, withdrawal and internal transfer, across every client, in one
 * list (`TransactionsService.movementsCte` is the union both this and the
 * client's own history read). Three routes, all READS: the desk that acts on
 * money stays admin-money.controller.ts — approving here would duplicate a
 * lifecycle that carries idempotency keys and a payment-platform leg.
 *
 * All three are gated on `transactions.view` — its own key, for the reasons
 * config/permissions.json states (neither `withdrawals.view` nor `ledger.view`
 * is the same power). No IdempotencyInterceptor: reads replay for free.
 */
@ApiTags('admin')
@Controller('admin')
export class AdminFinancialController {
  constructor(
    private readonly money: AdminMoneyService,
    private readonly exports: AdminExportService,
    private readonly audit: AdminAuditService,
  ) {}

  /**
   * One validation path for the filters all three routes share, so "which
   * values does `?state=` accept" cannot drift between the list, its tiles and
   * its file. Every enum is checked against its own source of truth — a bad
   * value is a 400 with a sentence, never a database error (R-2.1).
   */
  private static filters(raw: {
    direction?: string;
    kind?: string;
    state?: string;
    userId?: string;
    currency?: string;
    q?: string;
    from?: string;
    to?: string;
  }): Omit<AdminMovementsFilter, 'scope'> {
    return {
      direction: enumQuery(raw.direction, transactionDirectionEnum.enumValues, 'direction'),
      kind: enumQuery(raw.kind, TRANSACTION_KINDS, 'kind'),
      state: enumQuery(raw.state, transactionStateEnum.enumValues, 'state'),
      userId: uuidQuery(raw.userId, 'userId'),
      currency: raw.currency?.trim() || undefined,
      q: searchQuery(raw.q),
      from: dateQuery(raw.from, 'from'),
      to: dateQuery(raw.to, 'to'),
    };
  }

  /**
   * The filtered movement list as CSV — every matching row, not one page.
   * Amounts are the exact decimal strings the ledger holds (§6.1), and the
   * export carries the SAME permission as the list: a file must never be a way
   * around a screen.
   */
  @Get('transactions/export')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('transactions.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Export the filtered money-movement list as CSV',
    description:
      'The same filters as GET /admin/transactions, over every matching row rather than one ' +
      'page. Amounts are the exact decimal strings the ledger holds — never rounded, never ' +
      'locale-formatted (§6.1).',
  })
  @ApiOkResponse({
    description: 'A CSV file. `Content-Disposition` names it `transactions-<YYYY-MM-DD>.csv`.',
    content: { 'text/csv': { schema: { type: 'string', format: 'binary' } } },
  })
  @ApiQuery({ name: 'format', required: false, enum: ['csv'] })
  @ApiQuery({ name: 'direction', required: false, enum: transactionDirectionEnum.enumValues })
  @ApiQuery({ name: 'kind', required: false, enum: TRANSACTION_KINDS })
  @ApiQuery({ name: 'state', required: false, enum: transactionStateEnum.enumValues })
  @ApiQuery({ name: 'userId', required: false })
  @ApiQuery({ name: 'currency', required: false })
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'from', required: false, description: 'Inclusive, YYYY-MM-DD.' })
  @ApiQuery({ name: 'to', required: false, description: 'Inclusive, YYYY-MM-DD.' })
  @ScopedToClients(
    'AdminExportService.transactionBatch → TransactionsService.listAllForExport, the same per-arm clientScopePredicate the list applies inside the union.',
  )
  @Audited('export.transactions')
  async exportTransactions(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Res() res: Response,
    @Query('format') format?: string,
    @Query('direction') direction?: string,
    @Query('kind') kind?: string,
    @Query('state') state?: string,
    @Query('userId') userId?: string,
    @Query('currency') currency?: string,
    @Query('q') q?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const chosen = exportFormat(format);
    const query = AdminFinancialController.filters({
      direction,
      kind,
      state,
      userId,
      currency,
      q,
      from,
      to,
    });

    this.audit.record(req.admin.id, 'export.transactions', 'transaction_list', req.admin.id, {
      format: chosen,
      filters: query,
    });

    await streamCsv(res, 'transactions', chosen, this.exports.transactionColumns, (offset, limit) =>
      this.exports.transactionBatch(query, req.admin, offset, limit),
    );
  }

  /**
   * Server-computed totals for the page's tiles — per direction, kind, state
   * AND currency, because a sum across currencies is not a number. The page
   * renders these strings; it never adds decimal strings client-side.
   */
  @Get('transactions/summary')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('transactions.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Totals over the filtered movement list, grouped per currency (amounts are strings)',
  })
  @ApiOkResponse({ type: AdminTransactionsSummaryDto })
  @ApiQuery({ name: 'direction', required: false, enum: transactionDirectionEnum.enumValues })
  @ApiQuery({ name: 'kind', required: false, enum: TRANSACTION_KINDS })
  @ApiQuery({ name: 'state', required: false, enum: transactionStateEnum.enumValues })
  @ApiQuery({ name: 'userId', required: false })
  @ApiQuery({ name: 'currency', required: false })
  @ApiQuery({ name: 'q', required: false })
  @ApiQuery({ name: 'from', required: false, description: 'Inclusive, YYYY-MM-DD.' })
  @ApiQuery({ name: 'to', required: false, description: 'Inclusive, YYYY-MM-DD.' })
  @ScopedToClients(
    'TransactionsService.summarizeForAdmin aggregates over the same scoped union the list reads.',
  )
  transactionsSummary(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Query('direction') direction?: string,
    @Query('kind') kind?: string,
    @Query('state') state?: string,
    @Query('userId') userId?: string,
    @Query('currency') currency?: string,
    @Query('q') q?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.money.transactionsSummary(
      AdminFinancialController.filters({ direction, kind, state, userId, currency, q, from, to }),
      req.admin,
    );
  }

  // ── The list itself ───────────────────────────────────────────────────────
  @Get('transactions')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('transactions.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary:
      'Every money movement, platform-wide — deposits, withdrawals and transfers ' +
      '(amounts are strings)',
  })
  @ApiOkResponse({ type: AdminTransactionListResponseDto })
  /*
   * Declared OPTIONAL, explicitly — the listWithdrawals note: without these,
   * Swagger emits every `@Query()` as required and the frontends' generated
   * types then demand every parameter on a call that legitimately passes none.
   */
  @ApiQuery({ name: 'direction', required: false, enum: transactionDirectionEnum.enumValues })
  @ApiQuery({
    name: 'kind',
    required: false,
    enum: TRANSACTION_KINDS,
    description:
      'payment = crossed the platform boundary through a provider; transfer = wallet ⇄ ' +
      'trading account; commission_transfer = partner earnings to their main wallet.',
  })
  @ApiQuery({ name: 'state', required: false, enum: transactionStateEnum.enumValues })
  @ApiQuery({ name: 'userId', required: false, description: 'Narrow to one client (UUID).' })
  @ApiQuery({ name: 'currency', required: false })
  @ApiQuery({
    name: 'q',
    required: false,
    description:
      'Search the client’s email and name — the same columns every other queue searches.',
  })
  @ApiQuery({ name: 'from', required: false, description: 'Inclusive, YYYY-MM-DD.' })
  @ApiQuery({ name: 'to', required: false, description: 'Inclusive, YYYY-MM-DD.' })
  @ApiQuery({ name: 'page', required: false, description: 'Legacy offset paging. Prefer cursor.' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'cursor', required: false, description: 'Opaque keyset cursor (R-2.4).' })
  @ApiQuery({
    name: 'sort',
    required: false,
    enum: Object.keys(ADMIN_TRANSACTION_SORT_COLUMNS),
    description: 'amount sorts on the NUMERIC value in SQL — never cast, never in JS (§6).',
  })
  @ApiQuery({ name: 'order', required: false, enum: ['asc', 'desc'] })
  @ScopedToClients(
    'TransactionsService.adminMovements applies clientScopePredicate inside EACH ARM of the union, so out-of-scope rows also never reach the counts.',
  )
  listTransactions(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Query('direction') direction?: string,
    @Query('kind') kind?: string,
    @Query('state') state?: string,
    @Query('userId') userId?: string,
    @Query('currency') currency?: string,
    @Query('q') q?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('sort') sort?: string,
    @Query('order') order?: string,
  ) {
    return this.money.listTransactions(
      {
        ...AdminFinancialController.filters({
          direction,
          kind,
          state,
          userId,
          currency,
          q,
          from,
          to,
        }),
        page,
        limit,
        cursor,
        // Validated in the service against the allowlist, where the column
        // mapping lives — the listWithdrawals rule.
        sort,
        order,
      },
      req.admin,
    );
  }
}
