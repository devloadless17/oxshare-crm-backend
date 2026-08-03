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

import { Body, Controller, Get, Param, Patch, Query, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { AdminClientsService } from './admin-clients.service';
import { Admin } from '../../store/admins.store';
import { ClientStatusDto } from './dto/requests/clients.dto';
import { ClientListResponseDto } from './dto/responses.dto';
import { PermissionsGuard, RequirePermissions } from './guards/admin.guard';

/** Client directory and suspend/reinstate (ADM-01 / ADM-14). */
@ApiTags('admin')
@Controller('admin')
export class AdminClientsController {
  constructor(private readonly clients: AdminClientsService) {}

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
    return this.clients.listClients({
      page,
      limit,
      q,
      type,
      status,
      level,
    });
  }

  @Patch('clients/:id/status')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('users.suspend')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Suspend or reactivate a client account (requires users.suspend)',
  })
  setClientStatus(
    @Param('id') id: string,
    @Body() dto: ClientStatusDto,
    @Req() req: Request & { admin: Admin },
  ) {
    return this.clients.setClientStatus(id, dto.status, req.admin);
  }
}
