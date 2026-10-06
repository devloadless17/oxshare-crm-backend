import { ApiDateRangeQueries, dateRangeQuery } from '../../common/date-range';
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

import { Controller, Get, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import type { AuthenticatedAdmin } from './guards/admin.guard';
import { AdminAuditService } from './admin-audit.service';
import { AuditActionDto, AuditListResponseDto } from './dto/responses.dto';
import { PermissionsGuard, RequirePermissions } from './guards/admin.guard';
import { AUDIT_ACTIONS } from './audit-actions.catalog';
import { AUDIT_SORT_COLUMNS } from '../../store/audit-log.store';
import { searchQuery, uuidQuery } from '../../common/query-params';
import { NotClientScoped, ScopedToClients } from './guards/client-scope.decorator';
import { Audited } from './guards/audited.decorator';
import { AdminExportService, type ExportSeek } from './admin-export.service';
import { exportFormat, streamCsv, EXPORT_RATE_LIMIT } from '../../common/export/export-response';

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
  @ApiQuery({
    name: 'actorId',
    required: false,
    description: 'WHO did it — one administrator, by id.',
  })
  @ApiQuery({
    name: 'subjectId',
    required: false,
    description:
      'WHAT it was done to — one client, admin, withdrawal or other subject, by id. This is ' +
      'the "everything that has happened to this person" read a client profile links to.',
  })
  @ApiQuery({
    name: 'q',
    required: false,
    description:
      'A Portal ID (digits) finds every row about that client or performed by them. Anything ' +
      "else is free text over the ACTOR's email, which is denormalised onto every row so a deleted " +
      "administrator's trail still names them. It deliberately does not search `details`: " +
      'that blob holds client PII, and matching inside it would let a narrow-scoped reader ' +
      'confirm a client exists from a row count.',
  })
  @ScopedToClients(
    'AuditLogStore.findAll applies clientScopePredicate to rows whose subject is a CLIENT ' +
      '(subject_type user / kyc_submission, via auditBatch → scope) — D-54, resolved. ' +
      'Admin-subject rows are unscoped: the trail about administrators is not client data.',
  )
  @ApiDateRangeQueries()
  @Audited('export.audit_log')
  async exportAuditLog(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Res() res: Response,
    @Query('format') format?: string,
    @Query('action') action?: string,
    @Query('subjectType') subjectType?: string,
    @Query('actorId') actorId?: string,
    @Query('subjectId') subjectId?: string,
    @Query('q') q?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const chosen = exportFormat(format);
    // Bounded to the column width exactly as the list route does: a term longer
    // than varchar(100) cannot match any row, so accepting one only buys the
    // database a pointless scan.
    const query = {
      action: searchQuery(action, 'action'),
      subjectType: searchQuery(subjectType, 'subjectType'),
      // Same shape check as the list — an export must refuse what the screen
      // refuses, or the file answers a question the screen would not.
      actorId: uuidQuery(actorId, 'actorId'),
      subjectId,
      q: searchQuery(q, 'q'),
      range: dateRangeQuery(from, to),
    };

    this.audit.record(req.admin.id, 'export.audit_log', 'audit_log', req.admin.id, {
      format: chosen,
      filters: query,
    });

    const seek: ExportSeek = {};
    await streamCsv(res, 'audit-log', chosen, this.exports.auditColumns, (offset, limit) =>
      this.exports.auditBatch(query, req.admin, offset, limit, seek),
    );
  }

  @Get('audit-log')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('audit.view')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Append-only admin action log (master admin only)' })
  @ApiOkResponse({ type: AuditListResponseDto })
  @ScopedToClients(
    'AuditLogStore.findAll applies clientScopePredicate to rows whose subject is a CLIENT ' +
      '(subject_type user / kyc_submission) — D-54, resolved (owner, 13 Aug 2026). The old ' +
      'exemption claimed "the subjects are admin ids", which was mostly true and exactly ' +
      'wrong for the KYC and tag rows; a tag-scoped admin could read decisions about ' +
      'clients outside their territory. Admin-subject rows stay unscoped for every ' +
      'audit.view holder.',
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
  @ApiQuery({
    name: 'actorId',
    required: false,
    description: 'WHO did it — one administrator, by id.',
  })
  @ApiQuery({
    name: 'subjectId',
    required: false,
    description:
      'WHAT it was done to — one client, admin, withdrawal or other subject, by id. This is ' +
      'the "everything that has happened to this person" read a client profile links to.',
  })
  @ApiQuery({
    name: 'q',
    required: false,
    description:
      'A Portal ID (digits) finds every row about that client or performed by them. Anything ' +
      "else is free text over the ACTOR's email, which is denormalised onto every row so a deleted " +
      "administrator's trail still names them. It deliberately does not search `details`: " +
      'that blob holds client PII, and matching inside it would let a narrow-scoped reader ' +
      'confirm a client exists from a row count.',
  })
  @ApiQuery({ name: 'sort', required: false, enum: Object.keys(AUDIT_SORT_COLUMNS) })
  @ApiQuery({ name: 'order', required: false, enum: ['asc', 'desc'] })
  @ApiDateRangeQueries()
  listAuditLog(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('action') action?: string,
    @Query('subjectType') subjectType?: string,
    @Query('actorId') actorId?: string,
    @Query('subjectId') subjectId?: string,
    @Query('q') q?: string,
    @Query('sort') sort?: string,
    @Query('order') order?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
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
      /*
       * SHAPE-CHECKED AT THE EDGE, so the message names the parameter.
       *
       * ⚠️ Not a 500 fix. `AllExceptionsFilter` already maps Postgres `22P02` to
       * a 400 — it was added for exactly this, after a typo'd uuid in a URL was
       * "logged with a full stack as an unexpected server error". So the status
       * was right before this; what was wrong was the SENTENCE. "A value in the
       * request is not a valid identifier" does not say which value, on a route
       * taking four of them, and the database paid for a round trip to produce
       * it.
       *
       * `subjectId` beside it is deliberately NOT uuid-checked: that column is
       * text and holds route signatures like `PATCH /v1/admin/users/:id` as well
       * as ids.
       */
      actorId: uuidQuery(actorId, 'actorId'),
      subjectId,
      /*
       * Bounded the same way: `actor_email` is varchar(255), so a term longer
       * than the column cannot match a row and only buys the database a scan.
       */
      q: searchQuery(q, 'q'),
      // Validated in the service against AUDIT_SORT_COLUMNS — the one place the
      // column mapping lives.
      sort,
      order,
      range: dateRangeQuery(from, to),
    });
  }
}
