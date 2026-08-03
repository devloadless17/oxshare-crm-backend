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
} from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
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

/** Withdrawal lifecycle, the ADM-13 ledger view and IB commission plans. */
@ApiTags('admin')
@Controller('admin')
export class AdminMoneyController {
  constructor(private readonly money: AdminMoneyService) {}

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
  ) {
    return this.money.listWithdrawals({ state, page, limit });
  }

  @Patch('withdrawals/:id/approve')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('withdrawals.approve')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Approve a pending withdrawal — funds stay on hold until settlement',
  })
  @ApiOkResponse({ type: WithdrawalRowDto })
  approveWithdrawal(@Param('id') id: string, @Req() req: Request & { admin: Admin }) {
    return this.money.approveWithdrawal(id, req.admin);
  }

  @Patch('withdrawals/:id/reject')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('withdrawals.approve')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Reject a pending withdrawal — releases the hold, emails the client',
  })
  @ApiOkResponse({ type: WithdrawalRowDto })
  rejectWithdrawal(
    @Param('id') id: string,
    @Body() dto: WithdrawalRejectDto,
    @Req() req: Request & { admin: Admin },
  ) {
    return this.money.rejectWithdrawal(id, req.admin, dto.reason, dto.reasonId);
  }

  @Patch('withdrawals/:id/settle')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('withdrawals.approve')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Mark an approved withdrawal paid — posts the debit and clears the hold',
  })
  @ApiOkResponse({ type: WithdrawalRowDto })
  settleWithdrawal(
    @Param('id') id: string,
    @Body() dto: SettleWithdrawalDto,
    @Req() req: Request & { admin: Admin },
  ) {
    return this.money.settleWithdrawal(id, req.admin, dto.providerRef);
  }

  // ── Ledger (ADM-13) ───────────────────────────────────────────────────────
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
  ) {
    return this.money.listLedger({
      userId,
      walletId,
      entryType,
      page,
      limit,
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
