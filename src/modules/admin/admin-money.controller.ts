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
  Post,
  Put,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiCookieAuth, ApiHeader, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  IDEMPOTENCY_HEADER,
  IdempotencyInterceptor,
  Idempotent,
} from '../../common/security/idempotency.interceptor';
import { Request } from 'express';
import { AdminMoneyService } from './admin-money.service';
import { Admin } from '../../store/admins.store';
import {
  ProgramActiveDto,
  ProgramDto,
  SettleWithdrawalDto,
  WithdrawalRejectDto,
} from './dto/requests/money.dto';
import {
  IbProgramDto,
  LedgerListResponseDto,
  WithdrawalListResponseDto,
  WithdrawalRowDto,
} from './dto/responses.dto';
import { PermissionsGuard, RequirePermissions } from './guards/admin.guard';
import { ReconciliationService } from '../wallet/reconciliation.service';
import { UuidParam, enumQuery } from '../../common/query-params';
import { transactionStateEnum } from '../../database/schema';

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
  ) {}

  // ── Withdrawals (ADM-03 · §8.4) ───────────────────────────────────────────
  @Get('withdrawals')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('withdrawals.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Withdrawal requests with per-state counts (amounts are strings)',
  })
  @ApiOkResponse({ type: WithdrawalListResponseDto })
  listWithdrawals(
    @Query('state') state?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.money.listWithdrawals({
      // `transactions.service.ts` compared this against a Postgres enum column
      // behind a cast, so an unrecognised value came back as a 500 carrying a
      // database error. Checked against the schema's own value list instead.
      state: enumQuery(state, transactionStateEnum.enumValues, 'state'),
      page,
      limit,
      cursor,
    });
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
  approveWithdrawal(@Param('id', UuidParam) id: string, @Req() req: Request & { admin: Admin }) {
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
  rejectWithdrawal(
    @Param('id', UuidParam) id: string,
    @Body() dto: WithdrawalRejectDto,
    @Req() req: Request & { admin: Admin },
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
  @RequirePermissions('withdrawals.approve')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Mark an approved withdrawal paid — posts the debit and clears the hold',
  })
  @ApiOkResponse({ type: WithdrawalRowDto })
  settleWithdrawal(
    @Param('id', UuidParam) id: string,
    @Body() dto: SettleWithdrawalDto,
    @Req() req: Request & { admin: Admin },
  ) {
    return this.money.settleWithdrawal(id, req.admin, dto.providerRef);
  }

  // ── Ledger (ADM-13) ───────────────────────────────────────────────────────
  @Get('reconciliation')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('ledger.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Run reconciliation now and return the report (§12.2)',
    description:
      'The same check the hourly job runs: every wallet balance against the sum of its own ' +
      'ledger, and every confirmed accrual against the entry that should have credited it. ' +
      'Read-only — a discrepancy is reported, never repaired, because an automatic correction ' +
      'would write a compensating entry for a cause nobody has diagnosed.',
  })
  reconcile() {
    return this.reconciliation.run();
  }

  @Get('ledger')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('ledger.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Append-only ledger, filterable for reconciliation',
  })
  @ApiOkResponse({ type: LedgerListResponseDto })
  listLedger(
    @Query('userId') userId?: string,
    @Query('walletId') walletId?: string,
    @Query('entryType') entryType?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.money.listLedger({
      userId,
      walletId,
      entryType,
      page,
      limit,
      cursor,
    });
  }

  // ── Commission plans (ADM-10 · IB-06) ─────────────────────────────────────
  // Where the client configures the numbers ARCHITECTURE §12 leaves open:
  // L1/L2 shares (§12.2), rates and ladder (§12.3), settlement window (§12.6)
  // and rebate timing (§12.8). Nothing hardcoded, changeable without a deploy.
  @Get('commission-plans')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('commissions.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'IB programs / commission plans, ordered by ladder position',
  })
  @ApiOkResponse({ type: [IbProgramDto] })
  listPrograms() {
    return this.money.listPrograms();
  }

  @Post('commission-plans')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('commissions.manage')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Create a commission plan (validated: shares ≤ 100%, mode/value coherence)',
  })
  @ApiOkResponse({ type: IbProgramDto })
  createProgram(@Body() dto: ProgramDto, @Req() req: Request & { admin: Admin }) {
    return this.money.createProgram(dto, req.admin);
  }

  @Put('commission-plans/:id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('commissions.manage')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Update a commission plan — audited with before/after values',
  })
  @ApiOkResponse({ type: IbProgramDto })
  updateProgram(
    @Param('id') id: string,
    @Body() dto: ProgramDto,
    @Req() req: Request & { admin: Admin },
  ) {
    return this.money.updateProgram(id, dto, req.admin);
  }

  @Patch('commission-plans/:id/active')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('commissions.manage')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Activate or deactivate a plan — plans are never deleted, accruals reference them',
  })
  @ApiOkResponse({ type: IbProgramDto })
  setProgramActive(
    @Param('id') id: string,
    @Body() dto: ProgramActiveDto,
    @Req() req: Request & { admin: Admin },
  ) {
    return this.money.setProgramActive(id, dto.active, req.admin);
  }
}
