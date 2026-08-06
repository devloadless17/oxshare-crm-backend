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

import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { Admin } from '../../store/admins.store';
import { AdminAuditService } from './admin-audit.service';
import { AuditActionDto, AuditListResponseDto } from './dto/responses.dto';
import { MasterAdminGuard } from './guards/admin.guard';
import { AUDIT_ACTIONS } from './audit-actions.catalog';
import { searchQuery } from '../../common/query-params';
import { NotClientScoped } from './guards/client-scope.decorator';

/** Append-only admin action log (master admin only). */
@ApiTags('admin')
@Controller('admin')
export class AdminAuditController {
  constructor(private readonly audit: AdminAuditService) {}

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
  @UseGuards(MasterAdminGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Every action the log can record (master admin only)' })
  @ApiOkResponse({ type: [AuditActionDto] })
  @NotClientScoped('A static vocabulary of action names. Contains no client data of any kind.')
  listAuditActions() {
    return AUDIT_ACTIONS;
  }

  @Get('audit-log')
  @UseGuards(MasterAdminGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Append-only admin action log (master admin only)' })
  @ApiOkResponse({ type: AuditListResponseDto })
  @NotClientScoped(
    'MasterAdminGuard only, and a master admin is unrestricted by definition. The coverage spec also asserts that guard is still attached, so opening this to sub-admins fails CI rather than silently serving unscoped subjects.',
  )
  listAuditLog(
    @Req() req: Request & { admin: Admin },
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('action') action?: string,
    @Query('subjectType') subjectType?: string,
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
    });
  }
}
