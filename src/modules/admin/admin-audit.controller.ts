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

import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AdminAuditService } from './admin-audit.service';
import { AuditListResponseDto } from './dto/responses.dto';
import { MasterAdminGuard } from './guards/admin.guard';

/** Append-only admin action log (master admin only). */
@ApiTags('admin')
@Controller('admin')
export class AdminAuditController {
  constructor(private readonly audit: AdminAuditService) {}

  @Get('audit-log')
  @UseGuards(MasterAdminGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Append-only admin action log (master admin only)' })
  @ApiOkResponse({ type: AuditListResponseDto })
  listAuditLog(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('action') action?: string,
    @Query('subjectType') subjectType?: string,
  ) {
    return this.audit.listAuditLog({ page, limit, cursor, action, subjectType });
  }
}
