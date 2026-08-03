import {
  Controller, Post, Get, Patch, Put, Delete, Body, Param, Query,
  UseGuards, Req, Res, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiCookieAuth, ApiOkResponse, ApiExtraModels } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { IsEmail, IsString, MinLength, IsArray, IsOptional, IsIn, IsBoolean, IsInt, IsNumberString, IsNotEmpty, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { AdminService } from './admin.service';
import {
  AdminGuard,
  MasterAdminGuard,
  PermissionsGuard,
  RequirePermissions,
} from './guards/admin.guard';
import { Admin } from '../../store/admins.store';
import { KycStepConfig } from '../../store/kyc-config.store';
import { RejectionContext } from '../../store/rejection-reasons.store';
import {
  AdminLoginResponseDto,
  AdminProfileDto,
  AuditListResponseDto,
  ClientListResponseDto,
  InviteResponseDto,
  KycListResponseDto,
  KycSubmissionDto,
  MessageResponseDto,
  PermissionModuleDto,
  RejectionReasonResponseDto,
  RoleResponseDto,
  LedgerListResponseDto,
  WithdrawalListResponseDto,
  WithdrawalRowDto,
  IbProgramDto,
} from './dto/responses.dto';

class AdminLoginDto {
  @IsEmail() email: string;
  @IsString() password: string;
}
class InviteDto {
  @IsEmail() email: string;
  @IsString() name: string;
  @IsString() @IsOptional() roleId?: string;
  @IsArray() @IsOptional() permissions?: string[];
}
class AcceptInviteDto {
  @IsString() token: string;
  @IsString() @MinLength(8) password: string;
}
class RejectDto {
  @IsString() @IsOptional() reason?: string;
  @IsString() @IsOptional() reasonId?: string;
  @IsArray() @IsOptional() rejectedFields?: string[];
}
class RoleDto {
  @IsString() name: string;
  @IsString() @IsOptional() description?: string;
  @IsArray() permissions: string[];
}
class UpdateRoleDto {
  @IsString() @IsOptional() name?: string;
  @IsString() @IsOptional() description?: string;
  @IsArray() @IsOptional() permissions?: string[];
}
class UpdateAdminDto {
  @IsString() @IsOptional() name?: string;
  @IsString() @IsOptional() roleId?: string;
  @IsArray() @IsOptional() permissions?: string[];
}
class WithdrawalRejectDto {
  @IsString() @IsOptional() reason?: string;
  @IsString() @IsOptional() reasonId?: string;
}
class SettleWithdrawalDto {
  @IsString() providerRef: string;
}
class RejectionReasonDto {
  @IsString() context: RejectionContext;
  @IsString() label: string;
}
class ProgramDto {
  @IsString() name: string;
  @IsString() @IsOptional() description?: string;
  @IsInt() @IsOptional() position?: number;
  @IsIn(['commission', 'rebate', 'hybrid']) mode: 'commission' | 'rebate' | 'hybrid';
  @IsIn(['spread_share', 'per_lot', 'fixed_per_deal'])
  method: 'spread_share' | 'per_lot' | 'fixed_per_deal';
  // Money and percentages arrive as STRINGS and stay strings (§6.1).
  @IsNumberString() commissionValue: string;
  @IsNumberString() @IsOptional() rebateValue?: string;
  @IsNumberString() l1Share: string;
  @IsNumberString() l2Share: string;
  @IsInt() @Min(0) @IsOptional() settlementWindowHours?: number;
  @IsBoolean() @IsOptional() rebateOnClose?: boolean;
  @IsBoolean() @IsOptional() selectable?: boolean;
  @IsBoolean() @IsOptional() active?: boolean;
}
class ProgramActiveDto {
  @IsBoolean() active: boolean;
}
class KycFieldDto {
  @IsString() id: string;
  @IsString() @IsNotEmpty() name: string;
  @IsString() @IsNotEmpty() label: string;
  @IsIn(['text', 'date', 'phone', 'select', 'file', 'camera', 'checkbox'])
  type: 'text' | 'date' | 'phone' | 'select' | 'file' | 'camera' | 'checkbox';
  @IsBoolean() required: boolean;
  @IsArray() @IsString({ each: true }) @IsOptional() options?: string[];
  @IsString() @IsOptional() hint?: string;
}
class KycStepDto {
  @IsString() @IsOptional() id?: string;
  @IsInt() @IsOptional() stepNumber?: number;
  @IsString() @IsNotEmpty() slug: string;
  @IsString() @IsNotEmpty() title: string;
  @IsString() @IsOptional() description?: string;
  @IsString() @IsOptional() icon?: string;
  @IsBoolean() @IsOptional() enabled?: boolean;
  @IsArray() @ValidateNested({ each: true }) @Type(() => KycFieldDto) fields: KycFieldDto[];
}
class KycConfigDto {
  @IsArray() @ValidateNested({ each: true }) @Type(() => KycStepDto) steps: KycStepDto[];
}
class ClientStatusDto {
  @IsIn(['active', 'suspended']) status: 'active' | 'suspended';
}

@ApiTags('admin')
@ApiExtraModels(PermissionModuleDto)
@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  // ── Auth ──────────────────────────────────────────────────────────────────
  @Post('auth/login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Admin login' })
  @ApiOkResponse({ type: AdminLoginResponseDto })
  login(@Body() dto: AdminLoginDto, @Res({ passthrough: true }) res: Response) {
    return this.adminService.login(dto.email, dto.password, res);
  }

  @Post('auth/refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Admin refresh token' })
  @ApiOkResponse({ type: AdminLoginResponseDto })
  refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.adminService.refresh(req, res);
  }

  @Post('auth/logout')
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.OK)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Admin logout' })
  @ApiOkResponse({ type: MessageResponseDto })
  logout(@Req() req: Request & { admin: Admin }, @Res({ passthrough: true }) res: Response) {
    return this.adminService.logout(req.admin.id, res);
  }

  @Get('auth/me')
  @UseGuards(AdminGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Get current admin' })
  @ApiOkResponse({ type: AdminProfileDto })
  me(@Req() req: Request & { admin: Admin }) {
    return this.adminService.me(req.admin);
  }

  // ── Invite ────────────────────────────────────────────────────────────────
  @Post('invite')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('users.create')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Invite a new sub-admin with a role or explicit permissions (requires users.create)' })
  @ApiOkResponse({ type: InviteResponseDto })
  invite(@Body() dto: InviteDto, @Req() req: Request & { admin: Admin }) {
    return this.adminService.createInvite(dto.email, dto.name, req.admin, dto.roleId, dto.permissions);
  }

  @Get('invite/validate')
  @ApiOperation({ summary: 'Validate invite token — returns email and name for pre-fill' })
  validateInvite(@Query('token') token: string) {
    return this.adminService.validateInviteToken(token);
  }

  @Post('invite/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Accept invite and set password — logs admin in immediately' })
  acceptInvite(@Body() dto: AcceptInviteDto, @Res({ passthrough: true }) res: Response) {
    return this.adminService.acceptInvite(dto.token, dto.password, res);
  }

  // ── KYC Review — requires the kyc:review permission (RBAC-02/03) ──────────
  @Get('kyc')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('kyc.review')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'List all KYC submissions, optionally filtered by status' })
  @ApiOkResponse({ type: KycListResponseDto })
  listKyc(
    @Query('status') status?: string,
    @Query('q') q?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.adminService.listKyc({ status, q, page, limit });
  }

  @Get('kyc/:userId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('kyc.review')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Get full KYC submission for a user' })
  @ApiOkResponse({ type: KycSubmissionDto })
  getKyc(@Param('userId') userId: string) {
    return this.adminService.getKyc(userId);
  }

  @Patch('kyc/:userId/claim')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('kyc.review')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Claim a submitted KYC for review (sets under_review)' })
  @ApiOkResponse({ type: KycSubmissionDto })
  claimKyc(@Param('userId') userId: string, @Req() req: Request & { admin: Admin }) {
    return this.adminService.claimKyc(userId, req.admin.id);
  }

  @Patch('kyc/:userId/approve')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('kyc.review')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Approve KYC — bumps user verificationLevel to 1; returns the updated submission' })
  @ApiOkResponse({ type: KycSubmissionDto })
  approveKyc(@Param('userId') userId: string, @Req() req: Request & { admin: Admin }) {
    return this.adminService.approveKyc(userId, req.admin.id);
  }

  @Patch('kyc/:userId/reject')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('kyc.review')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Reject KYC with a reason (free text or a configured reasonId); returns the updated submission' })
  @ApiOkResponse({ type: KycSubmissionDto })
  rejectKyc(
    @Param('userId') userId: string,
    @Body() dto: RejectDto,
    @Req() req: Request & { admin: Admin },
  ) {
    return this.adminService.rejectKyc(userId, req.admin.id, dto.reason, dto.rejectedFields, dto.reasonId);
  }

  // ── Clients (ADM-01 / ADM-14) ─────────────────────────────────────────────
  @Get('clients')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('users.view')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Paginated, filterable client list' })
  @ApiOkResponse({ type: ClientListResponseDto })
  listClients(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('q') q?: string,
    @Query('type') type?: string,
    @Query('status') status?: string,
    @Query('level') level?: string,
  ) {
    return this.adminService.listClients({ page, limit, q, type, status, level });
  }

  @Patch('clients/:id/status')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('users.suspend')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Suspend or reactivate a client account (requires users.suspend)' })
  setClientStatus(
    @Param('id') id: string,
    @Body() dto: ClientStatusDto,
    @Req() req: Request & { admin: Admin },
  ) {
    return this.adminService.setClientStatus(id, dto.status, req.admin);
  }

  // ── Rejection reasons (FR-ADM-03 configurable list) ───────────────────────
  @Get('rejection-reasons')
  @UseGuards(AdminGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'List configurable rejection reasons, optionally by context (kyc | withdrawal)' })
  @ApiOkResponse({ type: [RejectionReasonResponseDto] })
  listRejectionReasons(@Query('context') context?: RejectionContext) {
    return this.adminService.listRejectionReasons(context);
  }

  @Post('rejection-reasons')
  @UseGuards(MasterAdminGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Add a rejection reason (master admin only)' })
  @ApiOkResponse({ type: RejectionReasonResponseDto })
  createRejectionReason(@Body() dto: RejectionReasonDto) {
    return this.adminService.createRejectionReason(dto.context, dto.label);
  }

  @Put('rejection-reasons/:id')
  @UseGuards(MasterAdminGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Rename a rejection reason (master admin only)' })
  @ApiOkResponse({ type: RejectionReasonResponseDto })
  updateRejectionReason(@Param('id') id: string, @Body('label') label: string) {
    return this.adminService.updateRejectionReason(id, label);
  }

  @Delete('rejection-reasons/:id')
  @UseGuards(MasterAdminGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Delete a rejection reason (master admin only)' })
  @ApiOkResponse({ type: MessageResponseDto })
  deleteRejectionReason(@Param('id') id: string) {
    return this.adminService.deleteRejectionReason(id);
  }


  // ── Withdrawals (ADM-03 · §8.4) ───────────────────────────────────────────
  @Get('withdrawals')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('withdrawals.view')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Withdrawal requests with per-state counts (amounts are strings)' })
  @ApiOkResponse({ type: WithdrawalListResponseDto })
  listWithdrawals(
    @Query('state') state?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.adminService.listWithdrawals({ state, page, limit });
  }

  @Patch('withdrawals/:id/approve')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('withdrawals.approve')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Approve a pending withdrawal — funds stay on hold until settlement' })
  @ApiOkResponse({ type: WithdrawalRowDto })
  approveWithdrawal(@Param('id') id: string, @Req() req: Request & { admin: Admin }) {
    return this.adminService.approveWithdrawal(id, req.admin);
  }

  @Patch('withdrawals/:id/reject')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('withdrawals.approve')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Reject a pending withdrawal — releases the hold, emails the client' })
  @ApiOkResponse({ type: WithdrawalRowDto })
  rejectWithdrawal(
    @Param('id') id: string,
    @Body() dto: WithdrawalRejectDto,
    @Req() req: Request & { admin: Admin },
  ) {
    return this.adminService.rejectWithdrawal(id, req.admin, dto.reason, dto.reasonId);
  }

  @Patch('withdrawals/:id/settle')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('withdrawals.approve')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Mark an approved withdrawal paid — posts the debit and clears the hold' })
  @ApiOkResponse({ type: WithdrawalRowDto })
  settleWithdrawal(
    @Param('id') id: string,
    @Body() dto: SettleWithdrawalDto,
    @Req() req: Request & { admin: Admin },
  ) {
    return this.adminService.settleWithdrawal(id, req.admin, dto.providerRef);
  }

  // ── Ledger (ADM-13) ───────────────────────────────────────────────────────
  @Get('ledger')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('ledger.view')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Append-only ledger, filterable for reconciliation' })
  @ApiOkResponse({ type: LedgerListResponseDto })
  listLedger(
    @Query('userId') userId?: string,
    @Query('walletId') walletId?: string,
    @Query('entryType') entryType?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.adminService.listLedger({ userId, walletId, entryType, page, limit });
  }


  // ── Commission plans (ADM-10 · IB-06) ─────────────────────────────────────
  // Where the client configures the numbers ARCHITECTURE §12 leaves open:
  // L1/L2 shares (§12.2), rates and ladder (§12.3), settlement window (§12.6)
  // and rebate timing (§12.8). Nothing hardcoded, changeable without a deploy.
  @Get('commission-plans')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('commissions.view')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'IB programs / commission plans, ordered by ladder position' })
  @ApiOkResponse({ type: [IbProgramDto] })
  listPrograms() {
    return this.adminService.listPrograms();
  }

  @Post('commission-plans')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('commissions.manage')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Create a commission plan (validated: shares ≤ 100%, mode/value coherence)' })
  @ApiOkResponse({ type: IbProgramDto })
  createProgram(@Body() dto: ProgramDto, @Req() req: Request & { admin: Admin }) {
    return this.adminService.createProgram(dto, req.admin);
  }

  @Put('commission-plans/:id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('commissions.manage')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Update a commission plan — audited with before/after values' })
  @ApiOkResponse({ type: IbProgramDto })
  updateProgram(
    @Param('id') id: string,
    @Body() dto: ProgramDto,
    @Req() req: Request & { admin: Admin },
  ) {
    return this.adminService.updateProgram(id, dto, req.admin);
  }

  @Patch('commission-plans/:id/active')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('commissions.manage')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Activate or deactivate a plan — plans are never deleted, accruals reference them' })
  @ApiOkResponse({ type: IbProgramDto })
  setProgramActive(
    @Param('id') id: string,
    @Body() dto: ProgramActiveDto,
    @Req() req: Request & { admin: Admin },
  ) {
    return this.adminService.setProgramActive(id, dto.active, req.admin);
  }

  // ── RBAC: permission catalog, roles, admin directory (RBAC-02/07) ─────────
  @Get('permissions')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('roles.view', 'users.view')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Permission catalog grouped by module (requires roles.view or users.view)' })
  @ApiOkResponse({ schema: { type: 'object', additionalProperties: { $ref: '#/components/schemas/PermissionModuleDto' } } })
  getPermissions() {
    return this.adminService.getPermissionsCatalog();
  }

  @Get('roles')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('roles.view', 'users.view')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'List RBAC roles (requires roles.view or users.view)' })
  @ApiOkResponse({ type: [RoleResponseDto] })
  listRoles() {
    return this.adminService.listRoles();
  }

  @Post('roles')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('roles.manage')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Create a custom role (requires roles.manage)' })
  @ApiOkResponse({ type: RoleResponseDto })
  createRole(@Body() dto: RoleDto, @Req() req: Request & { admin: Admin }) {
    return this.adminService.createRole(dto.name, dto.description, dto.permissions, req.admin);
  }

  @Put('roles/:id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('roles.manage')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Update a custom role (requires roles.manage)' })
  @ApiOkResponse({ type: RoleResponseDto })
  updateRole(@Param('id') id: string, @Body() dto: UpdateRoleDto, @Req() req: Request & { admin: Admin }) {
    return this.adminService.updateRole(id, dto, req.admin);
  }

  @Delete('roles/:id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('roles.manage')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Delete a custom role (requires roles.manage)' })
  @ApiOkResponse({ type: MessageResponseDto })
  deleteRole(@Param('id') id: string, @Req() req: Request & { admin: Admin }) {
    return this.adminService.deleteRole(id, req.admin.id);
  }

  @Get('users')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('users.view')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'List admin accounts (requires users.view)' })
  @ApiOkResponse({ type: [AdminProfileDto] })
  listAdmins() {
    return this.adminService.listAdmins();
  }

  @Patch('users/:id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('users.edit')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Update an admin’s name, role, or permissions (requires users.edit)' })
  @ApiOkResponse({ type: AdminProfileDto })
  updateAdmin(@Param('id') id: string, @Body() dto: UpdateAdminDto, @Req() req: Request & { admin: Admin }) {
    return this.adminService.updateAdmin(id, dto, req.admin);
  }

  @Get('audit-log')
  @UseGuards(MasterAdminGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Append-only admin action log (master admin only)' })
  @ApiOkResponse({ type: AuditListResponseDto })
  listAuditLog(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('action') action?: string,
    @Query('subjectType') subjectType?: string,
  ) {
    return this.adminService.listAuditLog({ page, limit, action, subjectType });
  }

  // ── KYC Step Configurator ──────────────────────────────────────────────────
  @Get('kyc-config')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('kyc.view')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Get current KYC onboarding steps configuration' })
  getKycConfig() {
    return this.adminService.getKycConfig();
  }

  @Put('kyc-config')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('kyc.edit')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Update entire KYC onboarding steps configuration' })
  updateKycConfig(@Body() dto: KycConfigDto) {
    return this.adminService.updateKycConfig(dto.steps as unknown as KycStepConfig[]);
  }

  @Post('kyc-config/steps')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('kyc.create')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Add a new KYC step' })
  addKycStep(@Body() dto: KycStepDto) {
    return this.adminService.addKycStep(dto as unknown as Omit<KycStepConfig, 'id' | 'stepNumber'>);
  }

  @Put('kyc-config/steps/:id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('kyc.edit')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Update a specific KYC step' })
  updateKycStep(@Param('id') id: string, @Body() dto: KycStepDto) {
    return this.adminService.updateKycStep(id, dto);
  }

  @Delete('kyc-config/steps/:id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('kyc.delete')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Delete a KYC step' })
  deleteKycStep(@Param('id') id: string) {
    return this.adminService.deleteKycStep(id);
  }

  @Post('kyc-config/reset')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('kyc.edit')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Reset KYC steps to default' })
  resetKycConfig() {
    return this.adminService.resetKycConfig();
  }
}
