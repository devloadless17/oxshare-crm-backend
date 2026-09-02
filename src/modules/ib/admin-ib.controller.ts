import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import {
  AuthenticatedAdmin,
  PermissionsGuard,
  RequirePermissions,
} from '../admin/guards/admin.guard';
import { NotClientScoped, ScopedToClients } from '../admin/guards/client-scope.decorator';
import { Audited } from '../admin/guards/audited.decorator';
import { IbApplicationsService } from './ib-applications.service';
import { CommissionService } from './commission.service';
import {
  IB_ACCRUAL_SORT_COLUMNS,
  IB_APPLICATION_SORT_COLUMNS,
  IB_PARTNER_SORT_COLUMNS,
} from '../../store/ib.store';
import { ibAccrualStatusEnum } from '../../database/schema';
import { enumQuery } from '../../common/query-params';
import { AdminExportService } from '../admin/admin-export.service';
import { AdminAuditService } from '../admin/admin-audit.service';
import { exportFormat, streamCsv } from '../../common/export/export-response';
import {
  ApproveIbApplicationDto,
  ChangeIbProgramDto,
  ReverseAccrualDto,
  IbAccountDto,
  IbApplicationDto,
  IbPartnerDetailDto,
  IB_APPLICATION_STATUSES,
  ReassignIbParentDto,
  RejectIbApplicationDto,
  SetIbActiveDto,
  type IbApplicationStatusDto,
} from './dto/ib-application.dto';
import { AnnouncesChange } from '../../common/realtime/announces-change.decorator';

/**
 * Reviewing partner applications.
 *
 * ## `@ScopedToClients`, unlike the programmes controller
 *
 * Every route here reaches a CLIENT — an application names the person who made
 * it — so an admin restricted to a subset of the client base must not see or
 * decide one from outside it. The list applies the predicate in its query; the
 * decisions ask `ClientVisibilityService` first, and get a 404 rather than a
 * 403 so the id cannot be used to enumerate the clients they were denied.
 *
 * ## Approve and reject are SEPARATE permissions
 *
 * `ib.approve` and `ib.reject`, not one `ib.decide`. Granting somebody the
 * ability to turn applications down is a smaller act of trust than granting
 * them the ability to create partners who will be paid, and a single key makes
 * that distinction unavailable to whoever configures a role.
 *
 * Neither one implies `ib.partners.edit`: rewriting the payout ladder is a different
 * power from deciding who joins it.
 */
@ApiTags('admin')
@Controller('admin/ib')
export class AdminIbController {
  constructor(
    private readonly applications: IbApplicationsService,
    private readonly exports: AdminExportService,
    private readonly audit: AdminAuditService,
    private readonly commissions: CommissionService,
  ) {}

  @Get('applications')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('ib.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'The partner application queue',
    description:
      'Paginated, newest first, with per-status counts for the tab labels. Both the rows and ' +
      'the counts respect the reviewing admin’s client scope.',
  })
  /*
   * Declared OPTIONAL, explicitly — otherwise Swagger emits every `@Query()` as
   * `required: true` and the generated frontend types demand all five on a call
   * that legitimately passes none.
   */
  @ApiQuery({ name: 'status', required: false, enum: IB_APPLICATION_STATUSES })
  @ApiQuery({
    name: 'q',
    required: false,
    description:
      'Search the applicant’s email and name — the same three columns the KYC queue searches.',
  })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'sort', required: false, enum: Object.keys(IB_APPLICATION_SORT_COLUMNS) })
  @ApiQuery({ name: 'order', required: false, enum: ['asc', 'desc'] })
  @ScopedToClients('IbStore.findPageWithUsers applies the predicate to ib_applications.user_id.')
  list(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Query('status') status?: string,
    @Query('q') q?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('sort') sort?: string,
    @Query('order') order?: string,
  ) {
    return this.applications.list(
      {
        // `ib_application_status` is a Postgres enum, so an unrecognised value
        // would error in the database rather than at the edge.
        status: parseStatus(status),
        q,
        page: parsePositive(page),
        limit: parsePositive(limit),
        // Validated in the service against the allowlist, which is where the
        // column mapping lives.
        sort,
        order,
      },
      req.admin.clientScope,
    );
  }

  /**
   * The partner application queue as CSV.
   *
   * Declared before `applications/:id/*` so Express does not bind `id =
   * 'export'` — the same ordering rule the client and KYC exports follow.
   *
   * `ib.view`, matching the list. Notably NOT `ib.approve`: reading the queue
   * and deciding on it are separate powers here, and an export is a read.
   */
  @Get('applications/export')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('ib.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Export the partner application queue as CSV',
    description:
      'The same `status` filter as GET /admin/ib/applications, over every matching row rather ' +
      'than one page. Respects the reviewing admin’s client scope.',
  })
  @ApiOkResponse({
    description: 'A CSV file, named `ib-applications-<YYYY-MM-DD>.csv`.',
    content: { 'text/csv': { schema: { type: 'string', format: 'binary' } } },
  })
  @ApiQuery({ name: 'format', required: false, enum: ['csv'] })
  @ApiQuery({ name: 'status', required: false, enum: IB_APPLICATION_STATUSES })
  @ScopedToClients(
    'AdminExportService.ibApplicationBatch → IbStore.findPageWithUsers with actor.clientScope, the same predicate on users.id the queue applies.',
  )
  @Audited('export.ib_applications')
  async exportApplications(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Res() res: Response,
    @Query('format') format?: string,
    @Query('status') status?: string,
  ) {
    const chosen = exportFormat(format);
    const query = { status: parseStatus(status) };

    this.audit.record(req.admin.id, 'export.ib_applications', 'ib_applications', req.admin.id, {
      format: chosen,
      filters: query,
    });

    await streamCsv(
      res,
      'ib-applications',
      chosen,
      this.exports.ibApplicationColumns,
      (offset, limit) => this.exports.ibApplicationBatch(query, req.admin, offset, limit),
    );
  }

  @Patch('applications/:id/approve')
  @AnnouncesChange('ib-applications')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('ib.approve')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Approve an application and create the partner account',
    description:
      'One transaction: the application moves out of pending and the account is created ' +
      'together, so there is no state where a client has been told they were accepted and has ' +
      'no referral code. Refuses if another reviewer already decided it. `programId` names the ' +
      'terms to appoint them on (FR-IB-06) and defaults to the first enabled programme; a ' +
      'disabled one is refused, because it would pay them nothing while their referral link ' +
      'kept working.',
  })
  @ApiOkResponse({ type: IbAccountDto })
  @ScopedToClients('Decides on one client’s application; out-of-scope 404s like a missing one.')
  @Audited('ib.approve')
  approve(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveIbApplicationDto,
  ) {
    return this.applications.approve(id, req.admin, req.admin.clientScope, {
      programId: dto.programId,
      parentIbUserId: dto.parentIbUserId ?? null,
      /*
       * `undefined` deliberately, not `?? null`. Undefined means "the reviewer
       * did not say", and the service falls back to what the applicant asked
       * for; null would mean "appoint them under no agency at all", which is a
       * different decision and not the one an omitted field expresses.
       */
      agencyId: dto.agencyId,
    });
  }

  @Patch('applications/:id/reject')
  @AnnouncesChange('ib-applications')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('ib.reject')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Reject an application, with a reason',
    description:
      'The reason is required and composed server-side from a configured label plus an optional ' +
      'note. It is stored already composed, because that is the sentence the client is shown.',
  })
  @ApiOkResponse({ type: IbApplicationDto })
  @ScopedToClients('Decides on one client’s application; out-of-scope 404s like a missing one.')
  @Audited('ib.reject')
  reject(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectIbApplicationDto,
  ) {
    return this.applications.reject(id, req.admin, req.admin.clientScope, dto);
  }

  // ── partners, once they exist ──────────────────────────────────────────────

  /**
   * The COMMISSION LEDGER — every accrual, who earned it and who generated it.
   *
   * ## ⚠️ This read did not exist
   *
   * `ib_accruals` was written on every settled deposit and never read back by
   * anything: no endpoint, no screen, no export. An operator could see partners
   * and programmes but not one commission — not who had earned what, not pending
   * against confirmed, not which client produced it. "What do we owe our
   * partners" was answerable only by opening the database.
   *
   * Declared BEFORE `partners/:userId/*` for the same routing reason as the
   * exports above: a literal segment must not sit behind a parameterised
   * sibling.
   *
   * `totals` is summed in SQL over the whole FILTERED set rather than the page.
   * A page total under a filter is a number that looks like an answer and is not.
   */
  @Get('accruals')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('ib.view', 'ib.commissions.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Partner commission accruals, filterable',
    description:
      'Every accrual with the partner who earned it and the client whose deposit generated it. ' +
      '`totals` sums by status across the whole filtered set, as decimal strings (§6.1).',
  })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'ibUserId', required: false, description: 'Restrict to one partner.' })
  @ApiQuery({ name: 'clientUserId', required: false, description: 'Restrict to one client.' })
  @ApiQuery({ name: 'status', required: false, enum: ibAccrualStatusEnum.enumValues })
  @ApiQuery({ name: 'sort', required: false, enum: Object.keys(IB_ACCRUAL_SORT_COLUMNS) })
  @ApiQuery({ name: 'order', required: false, enum: ['asc', 'desc'] })
  @ScopedToClients('IbStore.findAccrualsPage applies the predicate to ib_accruals.ib_user_id.')
  listAccruals(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('ibUserId') ibUserId?: string,
    @Query('clientUserId') clientUserId?: string,
    @Query('status') status?: string,
    @Query('sort') sort?: string,
    @Query('order') order?: string,
  ) {
    return this.applications.listAccruals(
      {
        page: parsePositive(page),
        limit: parsePositive(limit),
        ibUserId,
        clientUserId,
        // Validated against the column's own enum, so an unrecognised value is
        // a 400 rather than a filter that silently matches nothing.
        status: enumQuery(status, ibAccrualStatusEnum.enumValues, 'status'),
        sort,
        order,
      },
      req.admin.clientScope,
    );
  }

  /**
   * Take one accrual back.
   *
   * NOT scoped to clients. Every other partner operation here carries
   * `@ScopedToClients`, and this deliberately does not: the scope predicates in
   * `IbStore` filter on `ib_accruals.ib_user_id`, which on a REBATE row is the
   * partner whose programme produced it and not the person being debited. A
   * scope that reads the wrong column would let an operator reverse a client's
   * rebate they cannot otherwise see, which is worse than not scoping at all.
   * The permission is the gate, and it is a new one rather than `ib.view` —
   * reading accruals and clawing one back are not the same authority.
   */
  @Post('accruals/:id/reverse')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('ib.commissions.reverse')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Reverse a commission or rebate accrual',
    description:
      'The remedy for a dealer-cancelled trade, a mistyped rate caught late, or a duplicate. ' +
      'A PENDING accrual reverses for free — the money never moved. A CONFIRMED one posts a ' +
      'compensating ledger entry against the wallet that was credited, because `ledger_entries` ' +
      'is append-only and a credit is never edited. Reversing twice is a no-op, not a second ' +
      'debit. If the beneficiary has already spent or withdrawn the money the reversal REFUSES: ' +
      'wallets cannot go negative, so the recovery is a conversation rather than an API call.',
  })
  @Audited('ib.accrual_reverse')
  @NotClientScoped(
    'The scope predicates filter ib_accruals.ib_user_id, which on a REBATE row is the ' +
      'attributing partner rather than the person debited — scoping on it would be a check ' +
      'that reads the wrong column. `ib.commissions.reverse` is the gate.',
  )
  async reverseAccrual(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReverseAccrualDto,
  ) {
    const result = await this.commissions.reverseAccrual(id, dto.reason);

    /*
     * WRITTEN HERE, because `@Audited` is metadata and nothing reads it at
     * runtime — the decorator names the action for the audit SCREEN, and the
     * row only exists if somebody calls `record`. Declaring without recording
     * leaves the filter showing "no results", which reads as "it never
     * happened" for the one operation on this surface that removes money from
     * a wallet (D-21).
     *
     * AFTER the call, never before: a reversal that refuses because the
     * beneficiary already spent the money throws, and an audit row written
     * ahead of it would assert a clawback that did not occur.
     *
     * `movedMoney` is on the row because it is the difference between a status
     * change and a debit, and it is the first thing anybody reading this back
     * needs to know.
     */
    this.audit.record(req.admin.id, 'ib.accrual_reverse', 'ib_accrual', id, {
      reason: dto.reason,
      movedMoney: result.movedMoney,
    });

    return result;
  }

  @Get('partners')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('ib.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'The partner list',
    description: 'Joined to the person and the programme they are paid on, newest approval first.',
  })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'sort', required: false, enum: Object.keys(IB_PARTNER_SORT_COLUMNS) })
  @ApiQuery({ name: 'order', required: false, enum: ['asc', 'desc'] })
  @ScopedToClients('IbStore.findPartnersPage applies the predicate to ib_accounts.user_id.')
  listPartners(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('sort') sort?: string,
    @Query('order') order?: string,
  ) {
    return this.applications.listPartners(
      { page: parsePositive(page), limit: parsePositive(limit), sort, order },
      req.admin.clientScope,
    );
  }

  /**
   * The partner list as CSV.
   *
   * Declared before `partners/:userId/*` for the same routing reason as the
   * applications export above.
   */
  @Get('partners/export')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('ib.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Export the partner list as CSV',
    description:
      'Every partner the acting admin may see, joined to the person and their programme. The list ' +
      'takes no filters, so neither does its export.',
  })
  @ApiOkResponse({
    description: 'A CSV file, named `ib-partners-<YYYY-MM-DD>.csv`.',
    content: { 'text/csv': { schema: { type: 'string', format: 'binary' } } },
  })
  @ApiQuery({ name: 'format', required: false, enum: ['csv'] })
  @ScopedToClients(
    'AdminExportService.ibPartnerBatch → IbStore.findPartnersPage with actor.clientScope, the same predicate on users.id the list applies.',
  )
  @Audited('export.ib_partners')
  async exportPartners(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Res() res: Response,
    @Query('format') format?: string,
  ) {
    const chosen = exportFormat(format);

    this.audit.record(req.admin.id, 'export.ib_partners', 'ib_partners', req.admin.id, {
      format: chosen,
    });

    await streamCsv(res, 'ib-partners', chosen, this.exports.ibPartnerColumns, (offset, limit) =>
      this.exports.ibPartnerBatch(req.admin, offset, limit),
    );
  }

  /**
   * ONE partner, in full — what the client profile's partner tab renders.
   *
   * Declared AFTER `partners/export` and before `partners/:userId/*`, which is
   * the same routing constraint the export above records: a literal segment
   * that follows a parameterised one is unreachable.
   */
  @Get('partners/:userId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('ib.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'One partner’s standing, their line and their earnings',
    description:
      'The partner account joined to its programme (with its tier ladder) and agency, the partner ' +
      'above them, the partners ' +
      'directly beneath them, how many clients they introduced, and their confirmed and pending ' +
      'earnings. Answers `null` when the client is not a partner — every client profile asks, ' +
      'and most clients are not one, so that is an ordinary answer rather than a 404.',
  })
  @ApiOkResponse({ type: IbPartnerDetailDto })
  @ScopedToClients('Checks the SUBJECT with assertVisible; out-of-scope 404s like a missing one.')
  partnerDetail(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.applications.partnerDetailFor(userId, req.admin.clientScope);
  }

  /*
   * `PATCH partners/:userId/level` IS GONE (0102), and `/program` below is what
   * replaced it.
   *
   * It moved a partner to a different RUNG and described itself as the control
   * over their earnings — "a disabled one takes no share, so placing somebody on
   * it stops their earnings silently". That stopped being true in 0084, when the
   * rate moved to the programme, leaving an endpoint that changed a number
   * deciding nothing while reading as the one that mattered.
   */

  @Patch('partners/:userId/program')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('ib.partners.edit')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Move a partner onto a different commission programme',
    description:
      'The terms a partner is paid on. Applies to the NEXT trade — accruals record the rate they ' +
      'were calculated at, so nothing already credited is restated. The target must be ENABLED: a ' +
      'disabled programme pays nothing, so moving somebody onto one would stop their earnings ' +
      'silently instead of changing their terms visibly.',
  })
  @ApiOkResponse({ type: IbAccountDto })
  @ScopedToClients('Acts on one client’s partner account; out-of-scope 404s like a missing one.')
  @Audited('ib.program_change')
  changeProgram(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: ChangeIbProgramDto,
  ) {
    return this.applications.changeProgram(userId, dto.programId, req.admin.clientScope, req.admin);
  }

  @Patch('partners/:userId/parent')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('ib.partners.edit')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Reassign a partner’s parent',
    description:
      'Refuses a change that would put a partner beneath their own descendant. A self-FK cannot ' +
      'catch that — Postgres accepts A→B→A — and the payout walk climbs parents until it runs ' +
      'out, so a loop is a walk that never does.',
  })
  @ApiOkResponse({ type: IbAccountDto })
  @ScopedToClients('Acts on one client’s partner account; out-of-scope 404s like a missing one.')
  @Audited('ib.parent_change')
  reassignParent(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: ReassignIbParentDto,
  ) {
    return this.applications.reassignParent(
      userId,
      dto.parentIbUserId,
      req.admin.clientScope,
      req.admin,
    );
  }

  @Patch('partners/:userId/active')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('ib.partners.suspend')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Suspend or reactivate a partner',
    description:
      'Suspension keeps the referral code and the tree and stops the earning. There is no ' +
      'delete: removing the row would orphan every client and partner attributed beneath them.',
  })
  @ApiOkResponse({ type: IbAccountDto })
  @ScopedToClients('Acts on one client’s partner account; out-of-scope 404s like a missing one.')
  @Audited('ib.partners.suspend')
  setActive(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: SetIbActiveDto,
  ) {
    return this.applications.setActive(userId, dto.active, req.admin.clientScope, req.admin);
  }
}

/** An unrecognised status is ignored rather than 500ing in the database. */
function parseStatus(value?: string): IbApplicationStatusDto | undefined {
  return IB_APPLICATION_STATUSES.find((s) => s === value);
}

function parsePositive(value?: string): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
