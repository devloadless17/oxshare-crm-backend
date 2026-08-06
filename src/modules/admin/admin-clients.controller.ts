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
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { AdminClientsService } from './admin-clients.service';
import { ClientStatusDto } from './dto/requests/clients.dto';
import { ClientListResponseDto, ClientProfileDto } from './dto/responses.dto';
import {
  PermissionsGuard,
  RequirePermissions,
  type AuthenticatedAdmin,
} from './guards/admin.guard';
import { UuidParam, enumQuery, searchQuery } from '../../common/query-params';
import { userStatusEnum, userTypeEnum } from '../../database/schema';
import { CLIENT_SORT_COLUMNS } from '../../store/users.store';
import { ScopedToClients } from './guards/client-scope.decorator';
import { Audited } from './guards/audited.decorator';

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
  @ApiOperation({ summary: 'Paginated, filterable, sortable client list' })
  @ApiOkResponse({ type: ClientListResponseDto })
  /*
   * Declared OPTIONAL, explicitly.
   *
   * Without these, Swagger emits every `@Query()` as `required: true`, and the
   * frontends' generated types then demand all twelve parameters on a call that
   * legitimately passes none of them — which is how a contract-typing mechanism
   * turns into something people cast their way around.
   */
  @ApiQuery({ name: 'page', required: false, description: 'Legacy offset paging. Prefer cursor.' })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'cursor', required: false, description: 'Opaque keyset cursor (R-2.4).' })
  @ApiQuery({ name: 'withTotal', required: false, description: 'Counting is a full scan.' })
  @ApiQuery({ name: 'q', required: false, description: 'Search email and name.' })
  @ApiQuery({ name: 'type', required: false, enum: userTypeEnum.enumValues })
  @ApiQuery({ name: 'status', required: false, enum: userStatusEnum.enumValues })
  @ApiQuery({ name: 'level', required: false, enum: [0, 1] })
  @ApiQuery({ name: 'country', required: false, description: 'Exact match on the country tag.' })
  @ApiQuery({ name: 'tag', required: false, description: 'Tag SLUG, not id (ADM-14).' })
  @ApiQuery({ name: 'sort', required: false, enum: Object.keys(CLIENT_SORT_COLUMNS) })
  @ApiQuery({ name: 'order', required: false, enum: ['asc', 'desc'] })
  @ScopedToClients(
    'The list predicate — UsersStore.findPage applies clientScopePredicate to users.id.',
  )
  listClients(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('withTotal') withTotal?: string,
    @Query('q') q?: string,
    @Query('type') type?: string,
    @Query('status') status?: string,
    @Query('level') level?: string,
    @Query('country') country?: string,
    @Query('tag') tag?: string,
    @Query('sort') sort?: string,
    @Query('order') order?: string,
  ) {
    return this.clients.listClients(
      {
        page,
        limit,
        cursor,
        withTotal,
        // Bounded because it reaches a trigram predicate: a very long term is
        // cheap to send and expensive for Postgres to answer.
        q: searchQuery(q),
        // Both are Postgres enum columns compared behind a cast in
        // `users.store.ts`, so an unrecognised value surfaced as a 500 carrying a
        // database error rather than a 400 naming the field. `level` was already
        // parsed in the service; these two were not.
        type: enumQuery(type, userTypeEnum.enumValues, 'type'),
        status: enumQuery(status, userStatusEnum.enumValues, 'status'),
        level,
        // Bounded for the same reason as `q` — both reach an indexed comparison
        // over a 219,000-row table.
        country: searchQuery(country, 'country'),
        tag: searchQuery(tag, 'tag'),
        // `sort`/`order` are validated in the service against the SORTABLE_COLUMNS
        // allowlist, which is where the column mapping lives. Validating here too
        // would put the allowlist in two places.
        sort,
        order,
      },
      req.admin,
    );
  }

  @Get('clients/:id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('users.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: "A client's full profile — KYC, documents, trading accounts, referrals (FR-ADM-01)",
    description:
      'Each section is gated on its own permission and is ABSENT when the caller lacks it — ' +
      'which is deliberately different from present-and-empty, so a screen can distinguish ' +
      '"hidden from you" from "this client has none".',
  })
  @ApiOkResponse({ type: ClientProfileDto })
  @ScopedToClients(
    'UsersStore.findForAdmin(id, scope) — an out-of-scope client is 404, identically to a missing one.',
  )
  getClientProfile(
    @Param('id', UuidParam) id: string,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    return this.clients.getClientProfile(id, req.admin);
  }

  @Patch('clients/:id/status')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('users.suspend')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Suspend or reactivate a client account (requires users.suspend)',
  })
  @ScopedToClients('UsersStore.findForAdmin(id, scope) — an out-of-scope client is 404, never 403.')
  @Audited('client.suspend')
  setClientStatus(
    @Param('id', UuidParam) id: string,
    @Body() dto: ClientStatusDto,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    return this.clients.setClientStatus(id, dto.status, req.admin);
  }
}
