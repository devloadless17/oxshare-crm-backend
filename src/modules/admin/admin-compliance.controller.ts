import { Throttle } from '@nestjs/throttler';
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
  Headers,
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
import { exportFormat, streamCsv, EXPORT_RATE_LIMIT } from '../../common/export/export-response';
import { KYC_SORT_COLUMNS } from '../../store/kyc.store';
import { KycStepConfig } from '../../store/kyc-config.store';
import { DOCUMENT_CATALOGUE } from '../../common/kyc/document-catalogue';
import { KycDocumentTypeDto, KycFieldConfigDto } from '../compliance/dto/kyc-response.dto';
import { IDENTITY_FIELDS } from '../../common/kyc/identity-core';
import { RejectionContext } from '../../store/rejection-reasons.store';
import {
  KycConfigDto,
  KycStepDto,
  RejectDto,
  RejectionReasonDto,
  CorrectKycIdentityDto,
  ReverifyKycDto,
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
import { StepIdParam, UuidParam, enumQuery, searchQuery } from '../../common/query-params';
import { ClientRefPipe } from '../../common/client-ref.pipe';
import { NEEDS_REVIEW } from '../../store/kyc.store';
import { kycStatusEnum } from '../../database/schema';
import { NotClientScoped, ScopedToClients } from './guards/client-scope.decorator';
import { Audited } from './guards/audited.decorator';
import { AnnouncesChange } from '../../common/realtime/announces-change.decorator';
import { versionFromIfMatch } from '../../common/http/if-match';

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
  @ApiQuery({
    name: 'q',
    required: false,
    description: 'A Portal ID (digits, matched exactly) or free text over email and name.',
  })
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
  @ApiQuery({
    name: 'q',
    required: false,
    description: 'A Portal ID (digits, matched exactly) or free text over email and name.',
  })
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
    @Param('userId', ClientRefPipe) userId: number,
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
    @Param('userId', ClientRefPipe) userId: number,
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
    @Param('userId', ClientRefPipe) userId: number,
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
      'looks taken to everyone else. A reviewer may always hand back their OWN claim. Handing ' +
      "back a colleague's needs `kyc.claim.override`: approve and reject already refuse a " +
      'submission another reviewer holds, and leaving release open meant that claim could be ' +
      'removed by anybody, which took the lock off its hinges. The override exists so the desk ' +
      'is never stranded by a claim nobody is coming back to. Refuses a submission that has ' +
      "already been DECIDED — reopening one is reject's job, with a reason attached.",
  })
  @ApiOkResponse({ type: KycSubmissionDto })
  @ScopedToClients(
    "The predicate joins the transition's UPDATE ... WHERE, so check and write stay one statement.",
  )
  @Audited('kyc.release')
  releaseKyc(
    @Param('userId', ClientRefPipe) userId: number,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    return this.compliance.releaseKyc(userId, req.admin);
  }

  @Patch('kyc/:userId/personal-info')
  @AnnouncesChange('kyc')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('kyc.identity.correct')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Correct a date of birth or address on an APPROVED submission (CORE-18)',
    description:
      'The one state where the client cannot correct their own details. `saveStep` lets them ' +
      'edit while not_started, in_progress or rejected and correctly locks submitted and ' +
      'under_review; APPROVED had no path at all, and the refusal on POST /kyc/reset told the ' +
      'client to contact support — who had neither the field nor a route. The only lever left ' +
      'was to REJECT the verification for a typo, which drops verificationLevel to 0 and shuts ' +
      'the money doors.\n\n' +
      'RE-VALIDATED through the same rules as submission. A corrected value that is impossible, ' +
      'in the future or under 18 answers **409**, not 400: that is a fact about the RECORD, not ' +
      'about what was typed, and the operator has just found a different problem — a rejection ' +
      'rather than an edit. `details.kind` names which rule.\n\n' +
      'Audited as `kyc.identity_correct` against the SUBMISSION, with the value on both sides.',
  })
  @ApiOkResponse({ type: KycSubmissionDto })
  @ScopedToClients(
    'ClientVisibilityService.assertVisible before the submission is read — an out-of-scope ' +
      'client 404s exactly as a missing one does.',
  )
  @Audited('kyc.identity_correct')
  correctKycIdentity(
    @Param('userId', ClientRefPipe) userId: number,
    @Body() dto: CorrectKycIdentityDto,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    return this.compliance.correctKycIdentity(userId, dto, req.admin);
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
    @Param('userId', ClientRefPipe) userId: number,
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
    @Param('userId', ClientRefPipe) userId: number,
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

  @Post('kyc/:userId/reverify')
  @AnnouncesChange('kyc')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('kyc.review')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Return an APPROVED verification to the client to update (re-verification)',
    description:
      'For a verified detail that changed materially — a new passport, a move abroad. The ' +
      'verification returns to the client with the items to redo, the level goes back to 0 ' +
      '(deposits and withdrawals pause until re-approval), and the client is emailed the ' +
      'reason — as a request to update, not as a rejection. `reverificationRequestedAt` is set ' +
      'until the next approval. A typo is a correction instead (`PATCH .../personal-info`).',
  })
  @ApiOkResponse({ type: KycSubmissionDto })
  @ScopedToClients(
    'ClientVisibilityService.assertVisible before the submission is read — an out-of-scope ' +
      'client 404s exactly as a missing one does.',
  )
  @Audited('kyc.reverification_request')
  requestReverification(
    @Param('userId', ClientRefPipe) userId: number,
    @Body() dto: ReverifyKycDto,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    return this.compliance.requestReverification(userId, req.admin, dto.reason, dto.items);
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
  @ApiOperation({
    summary: 'Get current KYC onboarding steps configuration',
    description:
      "The form as every reader sees it: the platform's identity fields, built-in steps and " +
      "documents included (`system` / `core`), the broker's own parts as stored. The `ETag` " +
      'header is the version a save must name in `If-Match`.',
  })
  @NotClientScoped("The KYC form definition — a schema, not anybody's submission.")
  async getKycConfig(@Res({ passthrough: true }) res: Response) {
    const { steps, version } = await this.compliance.getKycConfig();
    res.setHeader('ETag', `"${version}"`);
    return steps;
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

  @Get('kyc-config/identity-catalogue')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('kyc.view', 'kyc.edit')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'The identity details Personal Information may ask for',
    description:
      'The platform owns their names, kinds and meaning; the builder decides which are asked, ' +
      'where, and whether each is required. `required` here is the default tier.',
  })
  @ApiOkResponse({ type: [KycFieldConfigDto] })
  @NotClientScoped('A catalogue of the platform’s identity fields — no client data.')
  getIdentityCatalogue() {
    return IDENTITY_FIELDS.map(({ id, name, label, type, required, hint }) => ({
      id,
      name,
      label,
      type,
      required,
      ...(hint ? { hint } : {}),
    }));
  }

  @Put('kyc-config')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('kyc.edit')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Update entire KYC onboarding steps configuration',
    description:
      'Send `If-Match` with the `ETag` the form was read with: a form somebody else has ' +
      'changed since answers **409 `KYC_CONFIG_STALE`** instead of silently replacing their ' +
      'work. Adding a step also needs `kyc.create`, removing one `kyc.delete`. A refusal names ' +
      'where it is in the posted form — `fields` is keyed `steps.<i>` or `steps.<i>.fields.<j>`.',
  })
  @NotClientScoped('The KYC form definition; contains no client data.')
  @Audited('kyc_config.replace')
  updateKycConfig(
    @Body() dto: KycConfigDto,
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Headers('if-match') ifMatch?: string,
  ) {
    return this.compliance.updateKycConfig(
      dto.steps as unknown as KycStepConfig[],
      req.admin,
      versionFromIfMatch(ifMatch),
      dto.format,
    );
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
    @Param('id', StepIdParam) id: string,
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
    @Param('id', StepIdParam) id: string,
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
