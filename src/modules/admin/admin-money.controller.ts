// Part of the `admin` controller surface, split by concern.
//
// admin.controller.ts had grown to 717 lines fronting six already well-separated
// services. Nest allows several controllers to share one @Controller prefix, so
// this split changes no route path — test/openapi-routes.spec.ts asserts the full
// 69-route inventory is byte-identical, which is what made the split safe to do.
//
// All guards here are per-route; there is no class-level @UseGuards to preserve.
// @ApiTags('admin') is repeated on each class so Swagger still groups them as one
// tag and the generated types.gen.ts is unchanged.

import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { WITHDRAWAL_SORT_COLUMNS } from '../payments/transactions.service';
import {
  IDEMPOTENCY_HEADER,
  IdempotencyInterceptor,
  Idempotent,
} from '../../common/security/idempotency.interceptor';
import { Request, Response } from 'express';
import { AdminMoneyService } from './admin-money.service';
import { AdminExportService } from './admin-export.service';
import { AdminAuditService } from './admin-audit.service';
import { exportFormat, streamCsv } from '../../common/export/export-response';
import { SettleWithdrawalDto, WithdrawalRejectDto } from './dto/requests/money.dto';
import {
  LedgerListResponseDto,
  WithdrawalListResponseDto,
  WithdrawalRowDto,
} from './dto/responses.dto';
import {
  MasterAdminGuard,
  PermissionsGuard,
  RequirePermissions,
  type AuthenticatedAdmin,
} from './guards/admin.guard';
import { ReconciliationService } from '../wallet/reconciliation.service';
import { UuidParam, enumQuery } from '../../common/query-params';
import { transactionStateEnum } from '../../database/schema';
import { NotClientScoped, ScopedToClients } from './guards/client-scope.decorator';
import { Audited } from './guards/audited.decorator';

/** Withdrawal lifecycle, the ADM-13 ledger view and IB commission plans. */
@ApiTags('admin')
@Controller('admin')
/*
 * R-5.2. The three withdrawal transitions below carry `@Idempotent()`, and for
 * as long as this line was missing that decorator did NOTHING: it sets metadata
 * that only IdempotencyInterceptor reads, and the interceptor was registered on
 * payments.controller.ts alone. A control that is declared but not wired is
 * worse than one that is absent, because a reader — and a reviewer — sees the
 * decorator and stops looking.
 *
 * The duplicate was still refused by the state machine underneath
 * (transactions.service.ts transitions with `WHERE id = ? AND state = ?` and
 * checks the rowcount), so this was never a double-payment. What was missing is
 * the REPLAY half: a retried approve got an error about the wrong state instead
 * of the original success, which is exactly the case the admin app generates a
 * key for.
 */
@UseInterceptors(IdempotencyInterceptor)
export class AdminMoneyController {
  constructor(
    private readonly money: AdminMoneyService,
    private readonly reconciliation: ReconciliationService,
    private readonly exports: AdminExportService,
    private readonly audit: AdminAuditService,
  ) {}

  /**
   * The withdrawal queue as CSV — every row matching the state filter.
   *
   * ── Amounts are emitted as the STRING the database produced ────────────────
   *
   * ARCHITECTURE §6.1, and the reason this route is worth reading carefully. A
   * withdrawal amount is `NUMERIC(28,8)`; it reaches the exporter as a string
   * and is written to the file character-for-character. Nothing here calls
   * `Number`, `toFixed` or a locale formatter — a CSV is the output most likely
   * to be re-imported into a spreadsheet that does arithmetic on it, so a value
   * rounded on the way out becomes a wrong number in somebody's reconciliation.
   *
   * Unlike the client, KYC and IB exports, this one has no `withdrawals/:id`
   * GET to be shadowed by, so its position is not load-bearing. It is placed
   * first among the withdrawal routes anyway, to match the pattern the other
   * exports follow.
   */
  @Get('withdrawals/export')
  @UseGuards(PermissionsGuard)
  // The SAME permission as the list. An export must never be a way around one.
  @RequirePermissions('withdrawals.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Export the filtered withdrawal queue as CSV',
    description:
      'The same `state` filter as GET /admin/withdrawals, over every matching row rather than ' +
      'one page. Amounts are the exact decimal strings the ledger holds — never rounded, never ' +
      'locale-formatted (§6.1).',
  })
  @ApiOkResponse({
    description: 'A CSV file. `Content-Disposition` names it `withdrawals-<YYYY-MM-DD>.csv`.',
    content: { 'text/csv': { schema: { type: 'string', format: 'binary' } } },
  })
  @ApiQuery({ name: 'format', required: false, enum: ['csv'] })
  @ApiQuery({ name: 'state', required: false, enum: transactionStateEnum.enumValues })
  @ScopedToClients(
    'AdminExportService.withdrawalBatch → TransactionsService.listForExport, the same clientScopePredicate on transactions.user_id the queue applies.',
  )
  @Audited('export.withdrawals')
  async exportWithdrawals(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Res() res: Response,
    @Query('format') format?: string,
    @Query('state') state?: string,
  ) {
    const chosen = exportFormat(format);
    // Validated against the schema's own enum, exactly as the list route does,
    // so an unrecognised state is a 400 rather than a database error or a file
    // that is silently empty.
    const query = { state: enumQuery(state, transactionStateEnum.enumValues, 'state') };

    this.audit.record(req.admin.id, 'export.withdrawals', 'withdrawal_queue', req.admin.id, {
      format: chosen,
      filters: query,
    });

    await streamCsv(res, 'withdrawals', chosen, this.exports.withdrawalColumns, (offset, limit) =>
      this.exports.withdrawalBatch(query, req.admin, offset, limit),
    );
  }

  // ── Withdrawals (ADM-03 · §8.4) ───────────────────────────────────────────
  @Get('withdrawals')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('withdrawals.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Withdrawal requests with per-state counts (amounts are strings)',
  })
  @ApiOkResponse({ type: WithdrawalListResponseDto })
  /*
   * Declared OPTIONAL, explicitly — without these, Swagger emits every `@Query()`
   * as `required: true` and the frontends' generated types then demand all six
   * parameters on a call that legitimately passes none.
   */
  @ApiQuery({ name: 'state', required: false, enum: transactionStateEnum.enumValues })
  @ApiQuery({ name: 'page', required: false, description: 'Legacy offset paging. Prefer cursor.' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'cursor', required: false, description: 'Opaque keyset cursor (R-2.4).' })
  @ApiQuery({
    name: 'sort',
    required: false,
    enum: Object.keys(WITHDRAWAL_SORT_COLUMNS),
    description: 'amount sorts on the NUMERIC column in SQL — never cast, never in JS (§6).',
  })
  @ApiQuery({ name: 'order', required: false, enum: ['asc', 'desc'] })
  @ScopedToClients(
    'TransactionsService.listForAdmin applies the predicate to transactions.user_id.',
  )
  listWithdrawals(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Query('state') state?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('sort') sort?: string,
    @Query('order') order?: string,
  ) {
    return this.money.listWithdrawals(
      {
        // `transactions.service.ts` compared this against a Postgres enum column
        // behind a cast, so an unrecognised value came back as a 500 carrying a
        // database error. Checked against the schema's own value list instead.
        state: enumQuery(state, transactionStateEnum.enumValues, 'state'),
        page,
        limit,
        cursor,
        // `sort`/`order` are validated in the service against the allowlist,
        // which is where the column mapping lives. Validating here too would put
        // the allowlist in two places.
        sort,
        order,
      },
      req.admin,
    );
  }

  @Patch('withdrawals/:id/approve')
  @Idempotent()
  @ApiHeader({
    name: IDEMPOTENCY_HEADER,
    required: true,
    description:
      'A unique value per intended action, reused only when retrying that same one. The state ' +
      'guards below make a REPLAYED CAUSE a no-op; this makes a replayed REQUEST one too ' +
      '(PLATFORM-CONVENTIONS R-5.2).',
  })
  @UseGuards(PermissionsGuard)
  @RequirePermissions('withdrawals.approve')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Approve a pending withdrawal — funds stay on hold until settlement',
  })
  @ApiOkResponse({ type: WithdrawalRowDto })
  @ScopedToClients('Predicate joins the state-machine UPDATE ... WHERE id = ? AND state = ?.')
  @Audited('withdrawal.approve')
  approveWithdrawal(
    @Param('id', UuidParam) id: string,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    return this.money.approveWithdrawal(id, req.admin);
  }

  @Patch('withdrawals/:id/reject')
  @Idempotent()
  @ApiHeader({
    name: IDEMPOTENCY_HEADER,
    required: true,
    description:
      'A unique value per intended action, reused only when retrying that same one. The state ' +
      'guards below make a REPLAYED CAUSE a no-op; this makes a replayed REQUEST one too ' +
      '(PLATFORM-CONVENTIONS R-5.2).',
  })
  @UseGuards(PermissionsGuard)
  @RequirePermissions('withdrawals.approve')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Reject a pending withdrawal — releases the hold, emails the client',
  })
  @ApiOkResponse({ type: WithdrawalRowDto })
  @ScopedToClients('Predicate joins the state-machine UPDATE.')
  @Audited('withdrawal.reject')
  rejectWithdrawal(
    @Param('id', UuidParam) id: string,
    @Body() dto: WithdrawalRejectDto,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    return this.money.rejectWithdrawal(id, req.admin, dto.reason, dto.reasonId);
  }

  @Patch('withdrawals/:id/settle')
  @Idempotent()
  @ApiHeader({
    name: IDEMPOTENCY_HEADER,
    required: true,
    description:
      'A unique value per intended action, reused only when retrying that same one. The state ' +
      'guards below make a REPLAYED CAUSE a no-op; this makes a replayed REQUEST one too ' +
      '(PLATFORM-CONVENTIONS R-5.2).',
  })
  @UseGuards(PermissionsGuard)
  // R-5.4 — a DIFFERENT permission from approve, deliberately. Settlement is the
  // step that releases the money; approval only says it may be released. While
  // both required `withdrawals.approve`, "two people must be involved in a
  // payout" could not be expressed at all.
  @RequirePermissions('withdrawals.settle')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Mark an approved withdrawal paid — posts the debit and clears the hold',
    description:
      'Requires `withdrawals.settle`, which is separate from `withdrawals.approve` so the two ' +
      'steps can be granted to different people (separation of duties, R-5.4).',
  })
  @ApiOkResponse({ type: WithdrawalRowDto })
  @ScopedToClients('Predicate joins the state-machine UPDATE — the money-releasing step.')
  @Audited('withdrawal.settle')
  settleWithdrawal(
    @Param('id', UuidParam) id: string,
    @Body() dto: SettleWithdrawalDto,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    return this.money.settleWithdrawal(id, req.admin, dto.providerRef);
  }

  // ── Ledger (ADM-13) ───────────────────────────────────────────────────────
  /*
   * MASTER ADMIN ONLY — narrowed from `ledger.view` when client scoping landed.
   *
   * This report names clients (`WalletDiscrepancy.userId`) and there is no
   * correct way to scope it. Restricting it to a sub-admin's territory would
   * produce a reconciliation that reports "balanced" over a subset, which is
   * the exact opposite of what a reconciliation is for — an operator would read
   * a clean report and conclude the ledger agrees, having been shown a slice.
   * Leaving it unscoped would hand a scoped sub-admin the ids of clients they
   * were specifically denied.
   *
   * So it is neither scoped nor left open: it moves to the one role that is
   * unrestricted by definition, and the answer stays whole.
   *
   * CONSEQUENCE, stated because it is a removal: any sub-admin who held
   * `ledger.view` could reach this and no longer can. `GET /admin/ledger` is
   * unaffected — that one IS scoped, and a filtered ledger is a coherent thing
   * to look at in a way a filtered reconciliation is not.
   */
  @Get('reconciliation')
  @UseGuards(MasterAdminGuard)
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Run reconciliation now and return the report (§12.2)',
    description:
      'The same check the hourly job runs: every wallet balance against the sum of its own ' +
      'ledger, and every confirmed accrual against the entry that should have credited it. ' +
      'Read-only — a discrepancy is reported, never repaired, because an automatic correction ' +
      'would write a compensating entry for a cause nobody has diagnosed.',
  })
  @NotClientScoped(
    'MasterAdminGuard only, and a master admin is unrestricted by definition. Deliberately not narrowed: a reconciliation reporting "balanced" over a subset of clients is the opposite of what a reconciliation is for.',
  )
  reconcile() {
    return this.reconciliation.run();
  }

  @Get('ledger')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('withdrawals.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Append-only ledger, filterable for reconciliation',
  })
  @ApiOkResponse({ type: LedgerListResponseDto })
  @ScopedToClients('WalletService.listEntries applies the predicate to wallets.user_id.')
  listLedger(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Query('userId') userId?: string,
    @Query('walletId') walletId?: string,
    @Query('entryType') entryType?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.money.listLedger(
      {
        userId,
        walletId,
        entryType,
        page,
        limit,
        cursor,
      },
      req.admin,
    );
  }

  /*
   * The four `/admin/commission-plans` routes were HERE and went with the
   * engine that read them. They configured the numbers ARCHITECTURE §12 leaves
   * open — L1/L2 shares, the ladder, the settlement window — and they return
   * with the MT5 bridge. `/admin/ib-levels` covers the placement half today.
   */
}
