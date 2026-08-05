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
  Delete,
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
import { AdminComplianceService } from './admin-compliance.service';
import { Admin } from '../../store/admins.store';
import { KycStepConfig } from '../../store/kyc-config.store';
import { RejectionContext } from '../../store/rejection-reasons.store';
import {
  KycConfigDto,
  KycStepDto,
  RejectDto,
  RejectionReasonDto,
} from './dto/requests/compliance.dto';
import {
  KycListResponseDto,
  KycSubmissionDto,
  MessageResponseDto,
  RejectionReasonResponseDto,
} from './dto/responses.dto';
import {
  AnyAdmin,
  AdminGuard,
  MasterAdminGuard,
  PermissionsGuard,
  RequirePermissions,
} from './guards/admin.guard';
import { UuidParam, enumQuery, searchQuery } from '../../common/query-params';
import { kycStatusEnum } from '../../database/schema';

/** KYC review queue, configurable rejection reasons and the KYC step configurator. */
@ApiTags('admin')
@Controller('admin')
export class AdminComplianceController {
  constructor(private readonly compliance: AdminComplianceService) {}

  // ── KYC Review — requires the kyc.review permission (RBAC-02/03) ──────────
  @Get('kyc')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('kyc.review')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'List all KYC submissions, optionally filtered by status',
  })
  @ApiOkResponse({ type: KycListResponseDto })
  listKyc(
    @Query('status') status?: string,
    @Query('q') q?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.compliance.listKyc({
      // `kyc_status` is a Postgres enum, so an unrecognised value errored in the
      // database rather than at the edge.
      status: enumQuery(status, kycStatusEnum.enumValues, 'status'),
      q: searchQuery(q),
      page,
      limit,
    });
  }

  @Get('kyc/:userId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('kyc.review')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Get full KYC submission for a user' })
  @ApiOkResponse({ type: KycSubmissionDto })
  getKyc(@Param('userId', UuidParam) userId: string) {
    return this.compliance.getKyc(userId);
  }

  @Patch('kyc/:userId/claim')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('kyc.review')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Claim a submitted KYC for review (sets under_review)',
  })
  @ApiOkResponse({ type: KycSubmissionDto })
  claimKyc(@Param('userId', UuidParam) userId: string, @Req() req: Request & { admin: Admin }) {
    return this.compliance.claimKyc(userId, req.admin);
  }

  @Patch('kyc/:userId/approve')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('kyc.review')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Approve KYC — bumps user verificationLevel to 1; returns the updated submission',
  })
  @ApiOkResponse({ type: KycSubmissionDto })
  approveKyc(@Param('userId', UuidParam) userId: string, @Req() req: Request & { admin: Admin }) {
    return this.compliance.approveKyc(userId, req.admin);
  }

  @Patch('kyc/:userId/reject')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('kyc.review')
  @ApiCookieAuth()
  @ApiOperation({
    summary:
      'Reject KYC with a reason (free text or a configured reasonId); returns the updated submission',
  })
  @ApiOkResponse({ type: KycSubmissionDto })
  rejectKyc(
    @Param('userId', UuidParam) userId: string,
    @Body() dto: RejectDto,
    @Req() req: Request & { admin: Admin },
  ) {
    return this.compliance.rejectKyc(
      userId,
      req.admin,
      dto.reason,
      dto.rejectedFields,
      dto.reasonId,
    );
  }

  // ── Rejection reasons (FR-ADM-03 configurable list) ───────────────────────
  @AnyAdmin(
    'A shared reference list of configured reasons, shown beside the reject button on both the ' +
      'KYC and withdrawal queues. Reading it reveals no client data; WRITING it is master-only.',
  )
  @Get('rejection-reasons')
  @UseGuards(AdminGuard)
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'List configurable rejection reasons, optionally by context (kyc | withdrawal)',
  })
  @ApiOkResponse({ type: [RejectionReasonResponseDto] })
  listRejectionReasons(@Query('context') context?: RejectionContext) {
    return this.compliance.listRejectionReasons(context);
  }

  @Post('rejection-reasons')
  @UseGuards(MasterAdminGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Add a rejection reason (master admin only)' })
  @ApiOkResponse({ type: RejectionReasonResponseDto })
  createRejectionReason(@Body() dto: RejectionReasonDto) {
    return this.compliance.createRejectionReason(dto.context, dto.label);
  }

  @Put('rejection-reasons/:id')
  @UseGuards(MasterAdminGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Rename a rejection reason (master admin only)' })
  @ApiOkResponse({ type: RejectionReasonResponseDto })
  updateRejectionReason(@Param('id', UuidParam) id: string, @Body('label') label: string) {
    return this.compliance.updateRejectionReason(id, label);
  }

  @Delete('rejection-reasons/:id')
  @UseGuards(MasterAdminGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Delete a rejection reason (master admin only)' })
  @ApiOkResponse({ type: MessageResponseDto })
  deleteRejectionReason(@Param('id', UuidParam) id: string) {
    return this.compliance.deleteRejectionReason(id);
  }

  // ── KYC Step Configurator ──────────────────────────────────────────────────
  @Get('kyc-config')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('kyc.view')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Get current KYC onboarding steps configuration' })
  getKycConfig() {
    return this.compliance.getKycConfig();
  }

  @Put('kyc-config')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('kyc.edit')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Update entire KYC onboarding steps configuration' })
  updateKycConfig(@Body() dto: KycConfigDto) {
    return this.compliance.updateKycConfig(dto.steps as unknown as KycStepConfig[]);
  }

  @Post('kyc-config/steps')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('kyc.create')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Add a new KYC step' })
  addKycStep(@Body() dto: KycStepDto) {
    return this.compliance.addKycStep(dto as unknown as Omit<KycStepConfig, 'id' | 'stepNumber'>);
  }

  @Put('kyc-config/steps/:id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('kyc.edit')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Update a specific KYC step' })
  updateKycStep(@Param('id', UuidParam) id: string, @Body() dto: KycStepDto) {
    return this.compliance.updateKycStep(id, dto);
  }

  @Delete('kyc-config/steps/:id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('kyc.delete')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Delete a KYC step' })
  deleteKycStep(@Param('id', UuidParam) id: string) {
    return this.compliance.deleteKycStep(id);
  }

  @Post('kyc-config/reset')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('kyc.edit')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Reset KYC steps to default' })
  resetKycConfig() {
    return this.compliance.resetKycConfig();
  }
}
