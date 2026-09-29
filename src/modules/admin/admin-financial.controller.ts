import { Throttle } from '@nestjs/throttler';
// Part of the `admin` controller surface, split by concern — see the header of
// admin-money.controller.ts for why several controllers share one @Controller
// prefix and what test/openapi-routes.spec.ts asserts about the inventory.

import {
  applyDecorators,
  BadRequestException,
  Controller,
  Get,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
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
import { CurrenciesService } from '../currencies/currencies.service';
import { exportFormat, streamCsv, EXPORT_RATE_LIMIT } from '../../common/export/export-response';
import { AdminTransactionListResponseDto, AdminTransactionsSummaryDto } from './dto/responses.dto';
import {
  PermissionsGuard,
  RequirePermissions,
  type AuthenticatedAdmin,
} from './guards/admin.guard';
import { dateQuery, enumQuery, searchQuery } from '../../common/query-params';
import { ClientRefPipe } from '../../common/client-ref.pipe';
import { transactionDirectionEnum, transactionStateEnum } from '../../database/schema';
import { ScopedToClients } from './guards/client-scope.decorator';
import { Audited } from './guards/audited.decorator';

/**
 * The 8 filter parameters all three routes accept, declared ONCE.
 *
 * Swagger reads these decorators, and the frontends' `types.gen.ts` is
 * generated from what Swagger says — so three hand-maintained copies of this
 * inventory is three chances for one route to silently advertise a different
 * filter set than its siblings honour. A ninth filter is added here and in
 * `filters()` below, and every route carries it or none does.
 */
function FinancialFilterQueries() {
  return applyDecorators(
    ApiQuery({ name: 'direction', required: false, enum: transactionDirectionEnum.enumValues }),
    ApiQuery({
      name: 'kind',
      required: false,
      enum: TRANSACTION_KINDS,
      description:
        'payment = crossed the platform boundary through a provider; transfer = wallet ⇄ ' +
        'trading account; commission_transfer = partner earnings to their main wallet.',
    }),
    ApiQuery({ name: 'state', required: false, enum: transactionStateEnum.enumValues }),
    ApiQuery({ name: 'userId', required: false, description: 'Narrow to one client (UUID).' }),
    ApiQuery({
      name: 'currency',
      required: false,
      description: 'A currency code the platform holds. Case-insensitive; unknown codes are 400.',
    }),
    ApiQuery({
      name: 'q',
      required: false,
      description:
        'A Portal ID (digits, matched exactly) or free text over the client’s email and name — ' +
        'the one client search every queue shares.',
    }),
    ApiQuery({ name: 'from', required: false, description: 'Inclusive, YYYY-MM-DD.' }),
    ApiQuery({ name: 'to', required: false, description: 'Inclusive, YYYY-MM-DD.' }),
    ApiQuery({
      name: 'attention',
      required: false,
      enum: ['true'],
      description: 'Only payments flagged for a person to reconcile. Omit for every movement.',
    }),
  );
}

/** The raw strings the routes hand to `filters()` — one name per query param. */
interface RawFilterParams {
  direction?: string;
  kind?: string;
  state?: string;
  userId?: number;
  currency?: string;
  q?: string;
  from?: string;
  to?: string;
  attention?: string;
}

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
    private readonly currencies: CurrenciesService,
  ) {}

  /**
   * One validation path for the filters all three routes share, so "which
   * values does `?state=` accept" cannot drift between the list, its tiles and
   * its file. Every value is checked against its own source of truth — a bad
   * value is a 400 with a sentence, never a database error and NEVER a
   * silently empty result (R-2.1/R-2.5).
   *
   * `currency` is resolved against the currencies table rather than merely
   * trimmed: codes are operator DATA, so no enum can close the set — but
   * `?currency=usd` answering an empty list with a 200 is the report-shaped
   * failure the other validators exist to prevent (an operator exporting "all
   * usd movements" would read the empty file as "there were none"). The
   * lookup is case-insensitive and returns the STORED code, so the SQL
   * equality below it compares like with like; a DISABLED currency still
   * resolves, because its historical movements remain real and filterable.
   */
  private async filters(raw: RawFilterParams): Promise<Omit<AdminMovementsFilter, 'scope'>> {
    let currency: string | undefined;
    if (raw.currency?.trim()) {
      const row = await this.currencies.findOne(raw.currency);
      if (!row) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: ['currency must be a currency code the platform holds'],
          fields: { currency: 'must be a currency code the platform holds' },
        });
      }
      currency = row.code;
    }

    return {
      direction: enumQuery(raw.direction, transactionDirectionEnum.enumValues, 'direction'),
      kind: enumQuery(raw.kind, TRANSACTION_KINDS, 'kind'),
      state: enumQuery(raw.state, transactionStateEnum.enumValues, 'state'),
      userId: raw.userId,
      currency,
      q: searchQuery(raw.q),
      from: dateQuery(raw.from, 'from'),
      to: dateQuery(raw.to, 'to'),
      // `true` or absent — anything else is a 400, like every enum filter here.
      attention: enumQuery(raw.attention, ['true'] as const, 'attention') ? true : undefined,
    };
  }

  /**
   * The filtered movement list as CSV — every matching row, not one page.
   * Amounts are the exact decimal strings the ledger holds (§6.1), and the
   * export carries the SAME permission as the list: a file must never be a way
   * around a screen.
   *
   * Batches are KEYSET-chained under a snapshot bound (`startedAt` +
   * `after`): the result set is frozen at the moment the export began, so a
   * deposit settling mid-export can neither duplicate a boundary row into the
   * file nor shift rows between batches — see `listAllForExport`.
   */
  @Get('transactions/export')
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
  @FinancialFilterQueries()
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
    @Query('userId', ClientRefPipe) userId?: number,
    @Query('currency') currency?: string,
    @Query('q') q?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('attention') attention?: string,
  ) {
    const chosen = exportFormat(format);
    const query = await this.filters({
      direction,
      kind,
      state,
      userId,
      currency,
      q,
      from,
      to,
      attention,
    });

    this.audit.record(req.admin.id, 'export.transactions', 'transaction_list', req.admin.id, {
      format: chosen,
      filters: query,
    });

    /*
     * The keyset state lives in this closure: `streamCsv` calls the batch
     * function sequentially, and each batch's last row names where the next
     * one starts. The offset `streamCsv` passes is ignored on purpose — an
     * OFFSET over a set the platform keeps writing to is how a boundary row
     * lands in the file twice.
     */
    const startedAt = new Date();
    let after: { createdAt: string; id: string } | undefined;
    await streamCsv(
      res,
      'transactions',
      chosen,
      this.exports.transactionColumns,
      async (_offset, limit) => {
        const rows = await this.exports.transactionBatch(query, req.admin, limit, startedAt, after);
        const last = rows[rows.length - 1];
        if (last) after = { createdAt: last.cursorCreatedAt, id: last.id };
        return rows;
      },
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
  @FinancialFilterQueries()
  @ScopedToClients(
    'TransactionsService.summarizeForAdmin aggregates over the same scoped union the list reads.',
  )
  async transactionsSummary(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Query('direction') direction?: string,
    @Query('kind') kind?: string,
    @Query('state') state?: string,
    @Query('userId', ClientRefPipe) userId?: number,
    @Query('currency') currency?: string,
    @Query('q') q?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('attention') attention?: string,
  ) {
    return this.money.transactionsSummary(
      await this.filters({ direction, kind, state, userId, currency, q, from, to, attention }),
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
   * Declared OPTIONAL, explicitly (inside FinancialFilterQueries) — the
   * listWithdrawals note: without that, Swagger emits every `@Query()` as
   * required and the frontends' generated types then demand every parameter
   * on a call that legitimately passes none.
   */
  @FinancialFilterQueries()
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
  async listTransactions(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Query('direction') direction?: string,
    @Query('kind') kind?: string,
    @Query('state') state?: string,
    @Query('userId', ClientRefPipe) userId?: number,
    @Query('currency') currency?: string,
    @Query('q') q?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('attention') attention?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('sort') sort?: string,
    @Query('order') order?: string,
  ) {
    return this.money.listTransactions(
      {
        ...(await this.filters({
          direction,
          kind,
          state,
          userId,
          currency,
          q,
          from,
          to,
          attention,
        })),
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
