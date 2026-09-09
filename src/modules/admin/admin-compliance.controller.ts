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
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { AdminComplianceService } from './admin-compliance.service';
import { AdminExportService } from './admin-export.service';
import { AdminAuditService } from './admin-audit.service';
import { exportFormat, streamCsv } from '../../common/export/export-response';
import { KYC_SORT_COLUMNS } from '../../store/kyc.store';
import { KycStepConfig } from '../../store/kyc-config.store';
import { DOCUMENT_CATALOGUE } from '../../common/kyc/document-catalogue';
import { KycDocumentTypeDto } from '../compliance/dto/kyc-response.dto';
import { RejectionContext } from '../../store/rejection-reasons.store';
import {
  KycConfigDto,
  KycStepDto,
  RejectDto,
  RejectionReasonDto,
} from './dto/requests/compliance.dto';
import {
  KycAttemptDto,
  KycListResponseDto,
  KycSubmissionDto,
  MessageResponseDto,
  RejectionReasonResponseDto,
} from './dto/responses.dto';
import {
  AnyAdmin,
  AdminGuard,
  PermissionsGuard,
  RequirePermissions,
  type AuthenticatedAdmin,
} from './guards/admin.guard';
import { UuidParam, enumQuery, searchQuery } from '../../common/query-params';
import { NEEDS_REVIEW } from '../../store/kyc.store';
import { kycStatusEnum } from '../../database/schema';
import { NotClientScoped, ScopedToClients } from './guards/client-scope.decorator';
import { Audited } from './guards/audited.decorator';
import { AnnouncesChange } from '../../common/realtime/announces-change.decorator';

/** KYC review queue, configurable rejection reasons and the KYC step configurator. */
@ApiTags('admin')
@Controller('admin')
export class AdminComplianceController {
  constructor(
    private readonly compliance: AdminComplianceService,
    private readonly exports: AdminExportService,
    private readonly audit: AdminAuditService,
  ) {}

  // ── KYC Review — requires the kyc.review permission (RBAC-02/03) ──────────
  @Get('kyc')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('kyc.view', 'kyc.review')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'List all KYC submissions, optionally filtered by status',
  })
  @ApiOkResponse({ type: KycListResponseDto })
  /*
   * Declared OPTIONAL, explicitly — otherwise Swagger emits every `@Query()` as
   * `required: true` and the generated frontend types demand all six on a call
   * that legitimately passes none.
   */
  @ApiQuery({ name: 'status', required: false, enum: kycStatusEnum.enumValues })
  @ApiQuery({ name: 'q', required: false, description: 'Search applicant email and name.' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'sort', required: false, enum: Object.keys(KYC_SORT_COLUMNS) })
  @ApiQuery({ name: 'order', required: false, enum: ['asc', 'desc'] })
  @ScopedToClients('KycStore.findPageWithUsers applies the predicate to kyc_submissions.user_id.')
  listKyc(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Query('status') status?: string,
    @Query('q') q?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('sort') sort?: string,
    @Query('order') order?: string,
  ) {
    return this.compliance.listKyc(
      {
        /*
         * `kyc_status` is a Postgres enum, so an unrecognised value errored in
         * the database rather than at the edge. `needs_review` is the one
         * value that is NOT a column value: it means submitted + under_review,
         * the set the dashboard tile and the sidebar badge already count. They
         * used to link to `submitted` alone, so a badge reading 17 opened a
         * list of 12.
         */
        status: enumQuery(status, [...kycStatusEnum.enumValues, NEEDS_REVIEW], 'status'),
        q: searchQuery(q),
        page,
        limit,
        // Validated in the service against KYC_SORT_COLUMNS — the one place the
        // column mapping lives.
        sort,
        order,
      },
      req.admin,
    );
  }

  /**
   * The KYC review queue as CSV.
   *
   * ── Declared before `kyc/:userId`, which is load-bearing ──────────────────
   *
   * Express matches in registration order, so with the parameterised route
   * first `/admin/kyc/export` would bind `userId = 'export'` and 400 on
   * `UuidParam`.
   *
   * ── What this file deliberately does NOT contain ──────────────────────────
   *
   * The QUEUE's columns, not the submission's. Date of birth, address,
   * nationality, phone and document paths stay out, following the same R-2.5
   * minimisation the queue query already applies — a reviewer reads those on
   * the detail screen, where doing so writes its own audit row. An export that
   * flattened full identity profiles into a spreadsheet would route the most
   * sensitive read in the system around the record that accounts for it.
   */
  @Get('kyc/export')
  @UseGuards(PermissionsGuard)
  // The same permissions as the queue. An export is not a lesser act.
  @RequirePermissions('kyc.view', 'kyc.review')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Export the filtered KYC review queue as CSV',
    description:
      'The same `status` and `q` filters as GET /admin/kyc, over every matching row rather than ' +
      'one page. Carries the queue’s columns only — not the full submission.',
  })
  @ApiOkResponse({
    description: 'A CSV file. `Content-Disposition` names it `kyc-<YYYY-MM-DD>.csv`.',
    content: { 'text/csv': { schema: { type: 'string', format: 'binary' } } },
  })
  @ApiQuery({ name: 'format', required: false, enum: ['csv'] })
  @ApiQuery({ name: 'status', required: false, enum: kycStatusEnum.enumValues })
  @ApiQuery({ name: 'q', required: false, description: 'Search email and name.' })
  @ScopedToClients(
    'AdminExportService.kycBatch → KycStore.findPageWithUsers with actor.clientScope, the same predicate on kyc_submissions.user_id the queue applies.',
  )
  @Audited('export.kyc')
  async exportKyc(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Res() res: Response,
    @Query('format') format?: string,
    @Query('status') status?: string,
    @Query('q') q?: string,
  ) {
    const chosen = exportFormat(format);
    const query = {
      status: enumQuery(status, kycStatusEnum.enumValues, 'status'),
      q: searchQuery(q),
    };

    this.audit.record(req.admin.id, 'export.kyc', 'kyc_queue', req.admin.id, {
      format: chosen,
      filters: query,
    });

    await streamCsv(res, 'kyc', chosen, this.exports.kycColumns, (offset, limit) =>
      this.exports.kycBatch(query, req.admin, offset, limit),
    );
  }

  @Get('kyc/:userId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('kyc.view', 'kyc.review')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Get full KYC submission for a user' })
  @ApiOkResponse({ type: KycSubmissionDto })
  @ScopedToClients('Scoped by-id read — an out-of-scope submission 404s like a missing one.')
  getKyc(
    @Param('userId', UuidParam) userId: string,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    return this.compliance.getKyc(userId, req.admin);
  }

  /*
   * The client's previous attempts — FSD §10's "attributable, reviewable
   * records", for the question a reviewer could not previously ask.
   *
   * Same `kyc.review` permission as the submission itself: this is the same PII
   * one decision older, so gating it differently would be arbitrary.
   */
  @Get('kyc/:userId/history')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('kyc.view', 'kyc.review')
  @ApiCookieAuth()
  @ApiOperation({
    summary: "A client's previously decided KYC attempts, oldest first",
  })
  @ApiOkResponse({ type: [KycAttemptDto] })
  @ScopedToClients('Scoped by-id read over kyc_submission_attempts.')
  getKycHistory(
    @Param('userId', UuidParam) userId: string,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    return this.compliance.getKycHistory(userId, req.admin);
  }

  @Patch('kyc/:userId/claim')
  @AnnouncesChange('kyc')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('kyc.review')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Claim a submitted KYC for review (sets under_review)',
  })
  @ApiOkResponse({ type: KycSubmissionDto })
  @ScopedToClients(
    "The predicate joins the transition's UPDATE ... WHERE, so check and write stay one statement.",
  )
  @Audited('kyc.claim')
  claimKyc(
    @Param('userId', UuidParam) userId: string,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    return this.compliance.claimKyc(userId, req.admin);
  }

  @Patch('kyc/:userId/release')
  @AnnouncesChange('kyc')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('kyc.review')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Hand a claimed KYC back to the queue (under_review → submitted)',
    description:
      'The way out of a claim. A reviewer who picked a submission up and cannot finish it — ' +
      'reassigned, off shift, or moved out of that territory — would otherwise leave a row that ' +
      'looks taken to everyone else. Gated exactly like a decision, because approve and reject ' +
      'already accept an under_review row from any reviewer who can see it: a claim is advisory, ' +
      'never a lock. Refuses a submission that has already been DECIDED — reopening one is ' +
      "reject's job, with a reason attached.",
  })
  @ApiOkResponse({ type: KycSubmissionDto })
  @ScopedToClients(
    "The predicate joins the transition's UPDATE ... WHERE, so check and write stay one statement.",
  )
  @Audited('kyc.release')
  releaseKyc(
    @Param('userId', UuidParam) userId: string,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    return this.compliance.releaseKyc(userId, req.admin);
  }

  @Patch('kyc/:userId/approve')
  @AnnouncesChange('kyc')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('kyc.review')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Approve KYC — bumps user verificationLevel to 1; returns the updated submission',
  })
  @ApiOkResponse({ type: KycSubmissionDto })
  @ScopedToClients(
    "Predicate inside the transition's UPDATE ... WHERE — rowcount 0 becomes the existing NotFound.",
  )
  @Audited('kyc.approve')
  approveKyc(
    @Param('userId', UuidParam) userId: string,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    return this.compliance.approveKyc(userId, req.admin);
  }

  @Patch('kyc/:userId/reject')
  @AnnouncesChange('kyc')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('kyc.review')
  @ApiCookieAuth()
  @ApiOperation({
    summary:
      'Reject KYC with a reason (free text or a configured reasonId); returns the updated submission',
  })
  @ApiOkResponse({ type: KycSubmissionDto })
  @ScopedToClients("Predicate inside the transition's UPDATE ... WHERE.")
  @Audited('kyc.reject')
  rejectKyc(
    @Param('userId', UuidParam) userId: string,
    @Body() dto: RejectDto,
    @Req() req: Request & { admin: AuthenticatedAdmin },
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
  @NotClientScoped('Configuration vocabulary shared by every reviewer; contains no client data.')
  listRejectionReasons(@Query('context') context?: RejectionContext) {
    return this.compliance.listRejectionReasons(context);
  }

  @Post('rejection-reasons')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('kyc.create')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Add a rejection reason (master admin only)' })
  @ApiOkResponse({ type: RejectionReasonResponseDto })
  @NotClientScoped('Configuration vocabulary; contains no client data.')
  @Audited('rejection_reason.create')
  createRejectionReason(
    @Body() dto: RejectionReasonDto,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    return this.compliance.createRejectionReason(dto.context, dto.label, req.admin);
  }

  @Put('rejection-reasons/:id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('kyc.edit')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Rename a rejection reason (master admin only)' })
  @ApiOkResponse({ type: RejectionReasonResponseDto })
  @NotClientScoped('Configuration vocabulary; contains no client data.')
  @Audited('rejection_reason.update')
  updateRejectionReason(
    @Param('id', UuidParam) id: string,
    @Body('label') label: string,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    return this.compliance.updateRejectionReason(id, label, req.admin);
  }

  @Delete('rejection-reasons/:id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('kyc.delete')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Delete a rejection reason (master admin only)' })
  @ApiOkResponse({ type: MessageResponseDto })
  @NotClientScoped('Configuration vocabulary; contains no client data.')
  @Audited('rejection_reason.delete')
  deleteRejectionReason(
    @Param('id', UuidParam) id: string,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    return this.compliance.deleteRejectionReason(id, req.admin);
  }

  // ── KYC Step Configurator ──────────────────────────────────────────────────
  // `kyc.edit` included so the builder can LOAD the config it is allowed to
  // change — a route gated on editing that 403s the read renders nothing.
  @Get('kyc-config')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('kyc.view', 'kyc.edit')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Get current KYC onboarding steps configuration' })
  @NotClientScoped("The KYC form definition — a schema, not anybody's submission.")
  getKycConfig() {
    return this.compliance.getKycConfig();
  }

  /**
   * The documents the builder may offer, and what each one requires.
   *
   * Served rather than duplicated in the admin bundle: "a passport is one photo
   * page" is a fact the portal also renders from, and two copies of it would
   * drift the moment one was edited. The builder ticks values off this list;
   * the step stores the values only.
   */
  @Get('kyc-config/document-catalogue')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('kyc.view', 'kyc.edit')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Documents a `document` field may accept' })
  @ApiOkResponse({ type: [KycDocumentTypeDto] })
  @NotClientScoped('A catalogue of document shapes — no client data.')
  getDocumentCatalogue() {
    return DOCUMENT_CATALOGUE;
  }

  @Put('kyc-config')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('kyc.edit')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Update entire KYC onboarding steps configuration' })
  @NotClientScoped('The KYC form definition; contains no client data.')
  @Audited('kyc_config.replace')
  updateKycConfig(@Body() dto: KycConfigDto, @Req() req: Request & { admin: AuthenticatedAdmin }) {
    return this.compliance.updateKycConfig(dto.steps as unknown as KycStepConfig[], req.admin);
  }

  @Post('kyc-config/steps')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('kyc.create')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Add a new KYC step' })
  @NotClientScoped('The KYC form definition; contains no client data.')
  @Audited('kyc_config.step_add')
  addKycStep(@Body() dto: KycStepDto, @Req() req: Request & { admin: AuthenticatedAdmin }) {
    return this.compliance.addKycStep(
      dto as unknown as Omit<KycStepConfig, 'id' | 'stepNumber'>,
      req.admin,
    );
  }

  @Put('kyc-config/steps/:id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('kyc.edit')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Update a specific KYC step' })
  @NotClientScoped('The KYC form definition; contains no client data.')
  @Audited('kyc_config.step_update')
  updateKycStep(
    @Param('id', UuidParam) id: string,
    @Body() dto: KycStepDto,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    return this.compliance.updateKycStep(id, dto, req.admin);
  }

  @Delete('kyc-config/steps/:id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('kyc.delete')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Delete a KYC step' })
  @NotClientScoped('The KYC form definition; contains no client data.')
  @Audited('kyc_config.step_delete')
  deleteKycStep(
    @Param('id', UuidParam) id: string,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    return this.compliance.deleteKycStep(id, req.admin);
  }

  @Post('kyc-config/reset')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('kyc.edit')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Reset KYC steps to default' })
  @NotClientScoped('The KYC form definition; contains no client data.')
  @Audited('kyc_config.reset')
  resetKycConfig(@Req() req: Request & { admin: AuthenticatedAdmin }) {
    return this.compliance.resetKycConfig(req.admin);
  }
}
