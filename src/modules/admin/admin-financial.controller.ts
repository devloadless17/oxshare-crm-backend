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
import { enumListQuery, enumQuery, searchQuery, uuidQuery } from '../../common/query-params';
import { MOVEMENT_TYPES } from '../payments/movement-type';
import { ApiDateRangeQueries, dateRangeQuery } from '../../common/date-range';
import { ClientRefPipe } from '../../common/client-ref.pipe';
import {
  transactionDirectionEnum,
  transactionStateEnum,
  transferOriginEnum,
} from '../../database/schema';
import { ScopedToClients } from './guards/client-scope.decorator';
import { Audited } from './guards/audited.decorator';

/**
 * The 9 filter parameters all three routes accept, declared ONCE.
 *
 * Swagger reads these decorators, and the frontends' `types.gen.ts` is
 * generated from what Swagger says — so three hand-maintained copies of this
 * inventory is three chances for one route to silently advertise a different
 * filter set than its siblings honour. A ninth filter is added here and in
 * `filters()` below, and every route carries it or none does.
 */
function FinancialFilterQueries() {
  return applyDecorators(
    ApiQuery({
      name: 'settledFrom',
      required: false,
      description:
        'The SETTLED period (audit R4-1, month-end): only movements whose settled_at falls in ' +
        '[settledFrom, settledTo]. A date or an instant, like from/to. Read live.',
    }),
    ApiQuery({ name: 'settledTo', required: false, description: 'End of the settled period.' }),
    ApiQuery({ name: 'direction', required: false, enum: transactionDirectionEnum.enumValues }),
    ApiQuery({
      name: 'kind',
      required: false,
      enum: TRANSACTION_KINDS,
      description:
        'payment = crossed the platform boundary through a provider; transfer = wallet ⇄ ' +
        'trading account; commission_transfer = partner earnings to their main wallet.',
    }),
    ApiQuery({
      name: 'type',
      required: false,
      description:
        'Accounting types, comma-separated: ' +
        MOVEMENT_TYPES.join(', ') +
        '. A desk credit or debit is the desk’s own money (route manual:adjustment), never a ' +
        'client’s deposit or withdrawal; the three transfer types never leave the platform.',
    }),
    ApiQuery({
      name: 'origin',
      required: false,
      description:
        'Where a transfer’s money came from, comma-separated: ' +
        transferOriginEnum.enumValues.join(', ') +
        '. Only transfers carry one, so a payment never matches.',
    }),
    ApiQuery({
      name: 'account',
      required: false,
      description:
        'One trading account’s transfers: its id or its MT5 login. An unknown or out-of-territory ' +
        'account answers an empty list, never "not found".',
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
    ApiDateRangeQueries(),
    ApiQuery({
      name: 'attention',
      required: false,
      enum: ['true'],
      description: 'Only payments flagged for a person to reconcile. Omit for every movement.',
    }),
    ApiQuery({
      name: 'id',
      required: false,
      description:
        'One movement by its row uuid (a deposit’s transaction, a transfer’s transfer) — where a ' +
        "notification deep link lands. AND-ed with every other filter and the reader's scope, so " +
        'a record outside it answers an empty result. No state is implied.',
    }),
    ApiQuery({
      name: 'method',
      required: false,
      description:
        'Payment method keys, comma-separated — deposit or withdrawal methods. Only payments ' +
        'have a method, so a transfer never matches. At most 50.',
    }),
    ApiQuery({
      name: 'decidedBy',
      required: false,
      enum: ['desk'],
      description:
        'Only movements a person decides: deposits paid outside the platform and every ' +
        'withdrawal. A deposit on a provider’s hosted page is settled by the provider. (0168)',
    }),
  );
}

/** The Transfers routes' filters: the Financial ones a transfer can match. */
function TransferFilterQueries() {
  return applyDecorators(
    ApiQuery({
      name: 'settledFrom',
      required: false,
      description:
        'The SETTLED period (audit R4-1, month-end): only movements whose settled_at falls in ' +
        '[settledFrom, settledTo]. A date or an instant, like from/to. Read live.',
    }),
    ApiQuery({ name: 'settledTo', required: false, description: 'End of the settled period.' }),
    ApiQuery({
      name: 'direction',
      required: false,
      enum: transactionDirectionEnum.enumValues,
      description:
        'Wallet-side, like Financial: withdrawal = wallet → trading account, deposit = into the ' +
        'wallet (from an account, or commission → main wallet).',
    }),
    ApiQuery({ name: 'state', required: false, enum: transactionStateEnum.enumValues }),
    ApiQuery({ name: 'userId', required: false, description: 'Narrow to one client.' }),
    ApiQuery({ name: 'currency', required: false, description: 'A currency code.' }),
    ApiQuery({
      name: 'q',
      required: false,
      description: 'A Portal ID (exact) or free text over the client’s email, name or phone.',
    }),
    ApiDateRangeQueries(),
    ApiQuery({
      name: 'origin',
      required: false,
      description:
        'Where the money came from, comma-separated: ' + transferOriginEnum.enumValues.join(', '),
    }),
    ApiQuery({
      name: 'account',
      required: false,
      description:
        'One trading account: its id or MT5 login. Unknown or out of territory is an empty list.',
    }),
    ApiQuery({ name: 'id', required: false, description: 'One transfer by its uuid.' }),
  );
}

const METHOD_KEY = /^[A-Za-z0-9_.-]{1,100}$/;

/** `?method=a,b` → the keys, or a 400 naming the parameter. */
function methodKeysQuery(raw: string | undefined): string[] | undefined {
  const keys = [
    ...new Set(
      (raw ?? '')
        .split(',')
        .map((k) => k.trim())
        .filter(Boolean),
    ),
  ];
  if (keys.length === 0) return undefined;
  if (keys.length > 50 || !keys.every((k) => METHOD_KEY.test(k))) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: ['method must be up to 50 comma-separated payment method keys'],
      fields: { method: 'must be up to 50 comma-separated payment method keys' },
    });
  }
  return keys;
}

/** The deposit desk's filters — its rows are fixed (deposits a person decides). */
function DeskDepositQueries() {
  return applyDecorators(
    ApiQuery({ name: 'state', required: false, enum: transactionStateEnum.enumValues }),
    ApiQuery({
      name: 'q',
      required: false,
      description:
        'A Portal ID, a phone, a name or an email — or a detail the client gave with the receipt.',
    }),
    ApiDateRangeQueries(),
  );
}

/** The raw strings the routes hand to `filters()` — one name per query param. */
interface RawFilterParams {
  /** The SETTLED period (audit R4-1): what settled between these dates, for month-end. */
  settledFrom?: string;
  settledTo?: string;
  direction?: string;
  kind?: string;
  /** Accounting types, comma-separated (movement-type.ts). */
  type?: string;
  /** Transfer origins, comma-separated (0226). */
  origin?: string;
  /** One trading account: its id or its MT5 login. */
  account?: string;
  state?: string;
  userId?: number;
  currency?: string;
  q?: string;
  from?: string;
  to?: string;
  attention?: string;
  decidedBy?: string;
  method?: string;
  id?: string;
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
      kinds: enumListQuery(raw.kind, TRANSACTION_KINDS, 'kind'),
      types: enumListQuery(raw.type, MOVEMENT_TYPES, 'type'),
      origins: enumListQuery(raw.origin, transferOriginEnum.enumValues, 'origin'),
      // Resolved to an id here; an unknown login is an ordinary empty list, never "not found".
      tradingAccountId: await this.money.accountFilterId(raw.account),
      state: enumQuery(raw.state, transactionStateEnum.enumValues, 'state'),
      userId: raw.userId,
      currency,
      q: searchQuery(raw.q),
      ...dateRangeQuery(raw.from, raw.to),
      settled: dateRangeQuery(raw.settledFrom, raw.settledTo, {
        from: 'settledFrom',
        to: 'settledTo',
      }),
      // `true` or absent — anything else is a 400, like every enum filter here.
      attention: enumQuery(raw.attention, ['true'] as const, 'attention') ? true : undefined,
      deskDecided: enumQuery(raw.decidedBy, ['desk'] as const, 'decidedBy') ? true : undefined,
      methods: methodKeysQuery(raw.method),
      id: uuidQuery(raw.id, 'id'),
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
    @Query('settledFrom') settledFrom?: string,
    @Query('settledTo') settledTo?: string,
    @Query('attention') attention?: string,
    @Query('decidedBy') decidedBy?: string,
    @Query('method') method?: string,
    @Query('id') id?: string,
    @Query('type') type?: string,
    @Query('origin') origin?: string,
    @Query('account') account?: string,
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
      settledFrom,
      settledTo,
      attention,
      decidedBy,
      method,
      id,
      type,
      origin,
      account,
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
    @Query('settledFrom') settledFrom?: string,
    @Query('settledTo') settledTo?: string,
    @Query('attention') attention?: string,
    @Query('decidedBy') decidedBy?: string,
    @Query('method') method?: string,
    @Query('id') id?: string,
    @Query('type') type?: string,
    @Query('origin') origin?: string,
    @Query('account') account?: string,
  ) {
    return this.money.transactionsSummary(
      await this.filters({
        direction,
        kind,
        state,
        userId,
        currency,
        q,
        from,
        to,
        settledFrom,
        settledTo,
        attention,
        decidedBy,
        method,
        id,
        type,
        origin,
        account,
      }),
      req.admin,
    );
  }

  // ── The Transfers page (`/transfers`) — on its OWN key (16 Oct 2026) ─────
  /*
   * Every move between a client's own accounts — wallet ⇄ trading account, commission wallet →
   * main wallet — with where its money came from (0226). `transfers.view` is what a transfers
   * reader is given; the platform-wide `transactions.view` also admits. The kinds are FORCED to the
   * transfer kinds in the SERVICE (and the export batch), never trusted from the query: that is the
   * wall between a transfers reader and every payment on the platform.
   */
  @Get('transfers/export')
  @Throttle({ default: { ttl: 60_000, limit: EXPORT_RATE_LIMIT } })
  @UseGuards(PermissionsGuard)
  @RequirePermissions('transfers.view', 'transactions.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Export the filtered transfers as CSV',
    description:
      'The same filters as GET /admin/transfers, over every matching row. Amounts are the exact ' +
      'decimal strings the ledger holds (§6.1).',
  })
  @ApiOkResponse({
    description: 'A CSV file. `Content-Disposition` names it `transfers-<YYYY-MM-DD>.csv`.',
    content: { 'text/csv': { schema: { type: 'string', format: 'binary' } } },
  })
  @ApiQuery({ name: 'format', required: false, enum: ['csv'] })
  @TransferFilterQueries()
  @ScopedToClients(
    'AdminExportService.transferBatch → TransactionsService.listAllForExport, the same per-arm clientScopePredicate the list applies.',
  )
  @Audited('export.transfers')
  async exportTransfers(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Res() res: Response,
    @Query('format') format?: string,
    @Query('direction') direction?: string,
    @Query('state') state?: string,
    @Query('userId', ClientRefPipe) userId?: number,
    @Query('currency') currency?: string,
    @Query('q') q?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('settledFrom') settledFrom?: string,
    @Query('settledTo') settledTo?: string,
    @Query('origin') origin?: string,
    @Query('account') account?: string,
    @Query('id') id?: string,
  ) {
    const chosen = exportFormat(format);
    const query = await this.filters({
      direction,
      state,
      userId,
      currency,
      q,
      from,
      to,
      settledFrom,
      settledTo,
      origin,
      account,
      id,
    });
    this.audit.record(req.admin.id, 'export.transfers', 'transfer_list', req.admin.id, {
      format: chosen,
      filters: query,
    });
    // Keyset-chained under one snapshot instant — see `exportTransactions`.
    const startedAt = new Date();
    let after: { createdAt: string; id: string } | undefined;
    await streamCsv(
      res,
      'transfers',
      chosen,
      this.exports.transactionColumns,
      async (_offset, limit) => {
        const rows = await this.exports.transferBatch(query, req.admin, limit, startedAt, after);
        const last = rows[rows.length - 1];
        if (last) after = { createdAt: last.cursorCreatedAt, id: last.id };
        return rows;
      },
    );
  }

  @Get('transfers/summary')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('transfers.view', 'transactions.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Totals over the filtered transfers, per currency, type and settlement (strings)',
  })
  @ApiOkResponse({ type: AdminTransactionsSummaryDto })
  @TransferFilterQueries()
  @ScopedToClients(
    'TransactionsService.summarizeForAdmin aggregates over the same scoped union, kinds forced.',
  )
  async transfersSummary(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Query('direction') direction?: string,
    @Query('state') state?: string,
    @Query('userId', ClientRefPipe) userId?: number,
    @Query('currency') currency?: string,
    @Query('q') q?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('settledFrom') settledFrom?: string,
    @Query('settledTo') settledTo?: string,
    @Query('origin') origin?: string,
    @Query('account') account?: string,
    @Query('id') id?: string,
  ) {
    return this.money.transfersSummary(
      await this.filters({
        direction,
        state,
        userId,
        currency,
        q,
        from,
        to,
        settledFrom,
        settledTo,
        origin,
        account,
        id,
      }),
      req.admin,
    );
  }

  @Get('transfers')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('transfers.view', 'transactions.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary:
      'Every transfer between a client’s own accounts, with where its money came from ' +
      '(amounts are strings)',
  })
  @ApiOkResponse({ type: AdminTransactionListResponseDto })
  @TransferFilterQueries()
  @ApiQuery({ name: 'page', required: false, description: 'Legacy offset paging. Prefer cursor.' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'cursor', required: false, description: 'Opaque keyset cursor (R-2.4).' })
  @ApiQuery({
    name: 'dir',
    required: false,
    enum: ['next', 'prev', 'last'],
    description: 'prev: the page before ?cursor. last: the final page (no cursor).',
  })
  @ApiQuery({ name: 'sort', required: false, enum: Object.keys(ADMIN_TRANSACTION_SORT_COLUMNS) })
  @ApiQuery({ name: 'order', required: false, enum: ['asc', 'desc'] })
  @ApiQuery({ name: 'facet', required: false, enum: ['direction', 'type'] })
  @ScopedToClients(
    'AdminMoneyService.listTransfers → TransactionsService.listAllForAdmin, the per-arm clientScopePredicate the Financial list applies; kinds forced.',
  )
  async listTransfers(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Query('direction') direction?: string,
    @Query('state') state?: string,
    @Query('userId', ClientRefPipe) userId?: number,
    @Query('currency') currency?: string,
    @Query('q') q?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('settledFrom') settledFrom?: string,
    @Query('settledTo') settledTo?: string,
    @Query('origin') origin?: string,
    @Query('account') account?: string,
    @Query('id') id?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('dir') dir?: string,
    @Query('sort') sort?: string,
    @Query('order') order?: string,
    @Query('facet') facet?: string,
  ) {
    return this.money.listTransfers(
      {
        ...(await this.filters({
          direction,
          state,
          userId,
          currency,
          q,
          from,
          to,
          settledFrom,
          settledTo,
          origin,
          account,
          id,
        })),
        page,
        limit,
        cursor,
        dir,
        sort,
        order,
        facet: enumQuery(facet, ['direction', 'type'] as const, 'facet'),
      },
      req.admin,
    );
  }

  // ── The deposit desk (`/approvals/deposits`) — on its OWN key ────────────
  /*
   * Deposits a PERSON decides (0168): offline payments a client declared with a
   * receipt. A deposit clerk holds `deposits.view` and must not be handed every
   * movement on the platform (`transactions.view`) — config/permissions.json,
   * "deposits". The desk read through `/admin/transactions` until 6 Oct 2026, so
   * a clerk set up exactly as the catalogue says loaded nothing, and had no file
   * at all. Either key admits; the rows are forced to the desk's in the service.
   */
  @Get('deposits/export')
  @Throttle({ default: { ttl: 60_000, limit: EXPORT_RATE_LIMIT } })
  @UseGuards(PermissionsGuard)
  @RequirePermissions('deposits.view', 'transactions.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Export the deposit desk as CSV',
    description:
      'The same filters as GET /admin/deposits, over every matching row. Amounts are the exact ' +
      "decimal strings the ledger holds (§6.1); the client's deposit details are a column.",
  })
  @ApiOkResponse({
    description: 'A CSV file. `Content-Disposition` names it `deposits-<YYYY-MM-DD>.csv`.',
    content: { 'text/csv': { schema: { type: 'string', format: 'binary' } } },
  })
  @ApiQuery({ name: 'format', required: false, enum: ['csv'] })
  @DeskDepositQueries()
  @ScopedToClients(
    'AdminExportService.deskDepositBatch → TransactionsService.listAllForExport, the same per-arm clientScopePredicate the list applies inside the union.',
  )
  @Audited('export.deposits')
  async exportDeskDeposits(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Res() res: Response,
    @Query('format') format?: string,
    @Query('state') state?: string,
    @Query('q') q?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('settledFrom') settledFrom?: string,
    @Query('settledTo') settledTo?: string,
  ) {
    const chosen = exportFormat(format);
    const query = await this.filters({
      direction: 'deposit',
      decidedBy: 'desk',
      state,
      q,
      from,
      to,
      settledFrom,
      settledTo,
    });
    this.audit.record(req.admin.id, 'export.deposits', 'transaction_list', req.admin.id, {
      format: chosen,
      filters: query,
    });
    // Keyset-chained under one snapshot instant — see `exportTransactions`.
    const startedAt = new Date();
    let after: { createdAt: string; id: string } | undefined;
    await streamCsv(res, 'deposits', chosen, this.exports.transactionColumns, async (_o, limit) => {
      const rows = await this.exports.deskDepositBatch(query, req.admin, limit, startedAt, after);
      const last = rows[rows.length - 1];
      if (last) after = { createdAt: last.cursorCreatedAt, id: last.id };
      return rows;
    });
  }

  @Get('deposits')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('deposits.view', 'transactions.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'The deposit desk — deposits a person decides (amounts are strings)',
  })
  @ApiOkResponse({ type: AdminTransactionListResponseDto })
  @DeskDepositQueries()
  @ApiQuery({ name: 'page', required: false, description: 'Legacy offset paging. Prefer cursor.' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'cursor', required: false, description: 'Opaque keyset cursor (R-2.4).' })
  @ApiQuery({
    name: 'dir',
    required: false,
    enum: ['next', 'prev', 'last'],
    description: 'prev: the page before ?cursor. last: the final page (no cursor).',
  })
  @ApiQuery({ name: 'sort', required: false, enum: Object.keys(ADMIN_TRANSACTION_SORT_COLUMNS) })
  @ApiQuery({ name: 'order', required: false, enum: ['asc', 'desc'] })
  @ApiQuery({
    name: 'id',
    required: false,
    description: 'One deposit by its uuid — where a notification lands. No state is implied.',
  })
  @ScopedToClients(
    'AdminMoneyService.listDeskDeposits → TransactionsService.listAllForAdmin, the per-arm clientScopePredicate the Financial list applies.',
  )
  async listDeskDeposits(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Query('state') state?: string,
    @Query('q') q?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('settledFrom') settledFrom?: string,
    @Query('settledTo') settledTo?: string,
    @Query('id') id?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('dir') dir?: string,
    @Query('sort') sort?: string,
    @Query('order') order?: string,
  ) {
    return this.money.listDeskDeposits(
      {
        ...(await this.filters({
          direction: 'deposit',
          decidedBy: 'desk',
          state,
          q,
          from,
          to,
          settledFrom,
          settledTo,
          id,
        })),
        page,
        limit,
        cursor,
        dir,
        sort,
        order,
      },
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
    name: 'dir',
    required: false,
    enum: ['next', 'prev', 'last'],
    description: 'prev: the page before ?cursor. last: the final page (no cursor).',
  })
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
    @Query('settledFrom') settledFrom?: string,
    @Query('settledTo') settledTo?: string,
    @Query('attention') attention?: string,
    @Query('decidedBy') decidedBy?: string,
    @Query('method') method?: string,
    @Query('id') id?: string,
    @Query('type') type?: string,
    @Query('origin') origin?: string,
    @Query('account') account?: string,
    @Query('facet') facet?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('dir') dir?: string,
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
          settledFrom,
          settledTo,
          attention,
          decidedBy,
          method,
          id,
          type,
          origin,
          account,
        })),
        page,
        limit,
        cursor,
        dir,
        // Validated in the service against the allowlist, where the column
        // mapping lives — the listWithdrawals rule.
        sort,
        order,
        facet: enumQuery(facet, ['direction', 'type'] as const, 'facet'),
      },
      req.admin,
    );
  }
}
