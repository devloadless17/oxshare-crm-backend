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

import { Controller, Get, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { Admin } from '../../store/admins.store';
import { AdminAuditService } from './admin-audit.service';
import { AuditActionDto, AuditListResponseDto } from './dto/responses.dto';
import { PermissionsGuard, RequirePermissions } from './guards/admin.guard';
import { AUDIT_ACTIONS } from './audit-actions.catalog';
import { AUDIT_SORT_COLUMNS } from '../../store/audit-log.store';
import { searchQuery } from '../../common/query-params';
import { NotClientScoped } from './guards/client-scope.decorator';
import { Audited } from './guards/audited.decorator';
import { AdminExportService } from './admin-export.service';
import { exportFormat, streamCsv } from '../../common/export/export-response';

/** Append-only admin action log (master admin only). */
@ApiTags('admin')
@Controller('admin')
export class AdminAuditController {
  constructor(
    private readonly audit: AdminAuditService,
    private readonly exports: AdminExportService,
  ) {}

  /**
   * The action vocabulary the filter is built from.
   *
   * Served rather than hardcoded in the frontend, for the same reason the
   * permission and client-field catalogs are (R-4.5). The admin screen carried
   * a list of EIGHT actions while the system recorded thirty-four, so
   * everything added because it had previously gone unrecorded was also
   * unfilterable — which is to say the actions somebody would actually come
   * looking for.
   */
  @Get('audit-log/actions')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('audit.view')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Every action the log can record (master admin only)' })
  @ApiOkResponse({ type: [AuditActionDto] })
  @NotClientScoped('A static vocabulary of action names. Contains no client data of any kind.')
  listAuditActions() {
    return AUDIT_ACTIONS;
  }

  /**
   * The admin action log as CSV — master admin only.
   *
   * ── Placed before `audit-log`, and why order does NOT matter here ──────────
   *
   * Unlike the client and KYC exports, neither of these routes is
   * parameterised, so `audit-log/export` and `audit-log` cannot shadow one
   * another. It is placed adjacent for readability rather than out of
   * necessity.
   *
   * ── `audit.view`, asserted a second time in the service ───────────────────
   *
   * The trail records who acted on which clients, which makes "who may read it"
   * a privileged question in its own right. `AdminExportService.auditBatch`
   * re-checks the key rather than trusting the decorator, for the reason
   * `AdminAuditService.listAuditLog` records (R-4.3): a guard runs only on an
   * HTTP request, and this service is reachable from a batch job that never
   * passes one.
   *
   * ── This export appears in the NEXT export, not its own ───────────────────
   *
   * The audit row lands after the read it describes. That is the useful
   * behaviour: a reader of one export can see that the previous one happened.
   */
  @Get('audit-log/export')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('audit.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Export the filtered admin action log as CSV (master admin only)',
    description:
      'The same `action` and `subjectType` filters as GET /admin/audit-log, over every matching ' +
      'row rather than one page. The `details` column is the jsonb payload, serialised whole.',
  })
  @ApiOkResponse({
    description: 'A CSV file. `Content-Disposition` names it `audit-log-<YYYY-MM-DD>.csv`.',
    content: { 'text/csv': { schema: { type: 'string', format: 'binary' } } },
  })
  @ApiQuery({ name: 'format', required: false, enum: ['csv'] })
  @ApiQuery({ name: 'action', required: false })
  @ApiQuery({ name: 'subjectType', required: false })
  @NotClientScoped(
    'Gated on audit.view, and the log records administrators acting rather than client-owned rows — the same stance GET /admin/audit-log takes, on the same table.',
  )
  @Audited('export.audit_log')
  async exportAuditLog(
    @Req() req: Request & { admin: Admin },
    @Res() res: Response,
    @Query('format') format?: string,
    @Query('action') action?: string,
    @Query('subjectType') subjectType?: string,
  ) {
    const chosen = exportFormat(format);
    // Bounded to the column width exactly as the list route does: a term longer
    // than varchar(100) cannot match any row, so accepting one only buys the
    // database a pointless scan.
    const query = {
      action: searchQuery(action, 'action'),
      subjectType: searchQuery(subjectType, 'subjectType'),
    };

    this.audit.record(req.admin.id, 'export.audit_log', 'audit_log', req.admin.id, {
      format: chosen,
      filters: query,
    });

    await streamCsv(res, 'audit-log', chosen, this.exports.auditColumns, (offset, limit) =>
      this.exports.auditBatch(query, req.admin, offset, limit),
    );
  }

  @Get('audit-log')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('audit.view')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Append-only admin action log (master admin only)' })
  @ApiOkResponse({ type: AuditListResponseDto })
  @NotClientScoped(
    'Gated on audit.view. The log records administrators acting, not client-owned rows, so there is no client scope to apply — the subjects are admin ids and the actions they took.',
  )
  /*
   * Declared OPTIONAL, explicitly — otherwise Swagger emits every `@Query()` as
   * `required: true` and the generated frontend types demand all seven on a call
   * that legitimately passes none.
   */
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'cursor', required: false, description: 'Opaque keyset cursor (R-2.4).' })
  @ApiQuery({ name: 'action', required: false })
  @ApiQuery({ name: 'subjectType', required: false })
  @ApiQuery({ name: 'sort', required: false, enum: Object.keys(AUDIT_SORT_COLUMNS) })
  @ApiQuery({ name: 'order', required: false, enum: ['asc', 'desc'] })
  listAuditLog(
    @Req() req: Request & { admin: Admin },
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('action') action?: string,
    @Query('subjectType') subjectType?: string,
    @Query('sort') sort?: string,
    @Query('order') order?: string,
  ) {
    /*
     * `action` and `subjectType` are varchar(100), not enums, so an odd value
     * matches nothing rather than erroring — the risk here is size, not shape.
     * Bounded to the column width: a term longer than the column cannot match
     * any row anyway, so accepting one only buys the database a pointless scan.
     */
    return this.audit.listAuditLog(req.admin, {
      page,
      limit,
      cursor,
      action: searchQuery(action, 'action'),
      subjectType: searchQuery(subjectType, 'subjectType'),
      // Validated in the service against AUDIT_SORT_COLUMNS — the one place the
      // column mapping lives.
      sort,
      order,
    });
  }
}
