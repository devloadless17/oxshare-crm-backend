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

import { Body, Controller, Get, Param, Patch, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { AdminClientsService } from './admin-clients.service';
import { AdminExportService } from './admin-export.service';
import { AdminAuditService } from './admin-audit.service';
import { exportFormat, streamCsv } from '../../common/export/export-response';
import { ClientStatusDto } from './dto/requests/clients.dto';
import { ClientListResponseDto, ClientProfileDto } from './dto/responses.dto';
import {
  PermissionsGuard,
  RequirePermissions,
  type AuthenticatedAdmin,
} from './guards/admin.guard';
import { UuidParam, enumQuery, searchQuery } from '../../common/query-params';
import { kycStatusEnum, userStatusEnum, userTypeEnum } from '../../database/schema';
import { CLIENT_SORT_COLUMNS } from '../../store/users.store';
import { ScopedToClients } from './guards/client-scope.decorator';
import { Audited } from './guards/audited.decorator';

/** Client directory and suspend/reinstate (ADM-01 / ADM-14). */
@ApiTags('admin')
@Controller('admin')
export class AdminClientsController {
  constructor(
    private readonly clients: AdminClientsService,
    private readonly exports: AdminExportService,
    private readonly audit: AdminAuditService,
  ) {}

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
  @ApiQuery({
    name: 'emailVerified',
    required: false,
    enum: ['true', 'false'],
    description: 'Omit to include both. Distinct from KYC — see ClientRowDto.',
  })
  @ApiQuery({
    name: 'kycStatus',
    required: false,
    enum: kycStatusEnum.enumValues,
    description: '`not_started` matches clients with no submission row at all.',
  })
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
    @Query('emailVerified') emailVerified?: string,
    @Query('kycStatus') kycStatus?: string,
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
        // Both validated in the service — `kycStatus` against the enum, so an
        // unrecognised value is a 400 naming the six rather than a silently
        // unfiltered list.
        emailVerified,
        kycStatus,
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

  /**
   * The client list as a CSV file — every row matching the filters, not a page.
   *
   * ── DECLARED BEFORE `clients/:id`, and that is load-bearing ────────────────
   *
   * Express matches routes in registration order, so with `clients/:id` first a
   * request for `/admin/clients/export` binds `id = 'export'`, fails
   * `UuidParam` and 400s. The export route must be registered before the
   * parameterised one. This is the same trap `kyc/:userId` and the IB routes
   * have, and each of those export routes is placed the same way.
   *
   * ── The same permission and the same scope as the list ────────────────────
   *
   * `users.view` and `@ScopedToClients`, not because the decorators were copied
   * but because an export that required less, or scoped less, would be a
   * documented way around both. `AdminExportService.clientBatch` passes
   * `actor.clientScope` into the same `UsersStore.findPage` the list calls, and
   * it applies the RBAC-03 field mask too — an admin who may not see email
   * addresses on screen must not be handed a file of them.
   */
  @Get('clients/export')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('users.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Export the filtered client list as CSV',
    description:
      'Takes the SAME filters as GET /admin/clients and covers every matching row rather than ' +
      'one page. Paging parameters are not accepted. Client scope and field masking apply ' +
      'exactly as they do to the list.',
  })
  @ApiOkResponse({
    description: 'A CSV file. `Content-Disposition` names it `clients-<YYYY-MM-DD>.csv`.',
    content: { 'text/csv': { schema: { type: 'string', format: 'binary' } } },
  })
  // `required: false` on every one, for the reason the list route records: without
  // it Swagger marks each as required and the generated frontend types demand
  // filters a plain "export everything" call legitimately omits.
  @ApiQuery({ name: 'format', required: false, enum: ['csv'] })
  @ApiQuery({ name: 'q', required: false, description: 'Search email and name.' })
  @ApiQuery({ name: 'type', required: false, enum: userTypeEnum.enumValues })
  @ApiQuery({ name: 'status', required: false, enum: userStatusEnum.enumValues })
  @ApiQuery({ name: 'level', required: false, enum: [0, 1] })
  @ApiQuery({ name: 'country', required: false, description: 'Exact match on the country tag.' })
  @ApiQuery({
    name: 'emailVerified',
    required: false,
    enum: ['true', 'false'],
    description: 'Omit to include both. Distinct from KYC — see ClientRowDto.',
  })
  @ApiQuery({
    name: 'kycStatus',
    required: false,
    enum: kycStatusEnum.enumValues,
    description: '`not_started` matches clients with no submission row at all.',
  })
  @ApiQuery({ name: 'tag', required: false, description: 'Tag SLUG, not id (ADM-14).' })
  @ApiQuery({ name: 'sort', required: false, enum: Object.keys(CLIENT_SORT_COLUMNS) })
  @ApiQuery({ name: 'order', required: false, enum: ['asc', 'desc'] })
  @ScopedToClients(
    'AdminExportService.clientBatch → UsersStore.findPage with actor.clientScope, the same predicate on users.id the list applies.',
  )
  /*
   * AUDITED, though it is a GET — the exception argued in audit-actions.catalog.
   * A page of clients on a screen and a file of every client on a laptop are
   * different acts, and only one of them needs to be attributable afterwards.
   */
  @Audited('export.clients')
  async exportClients(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Res() res: Response,
    @Query('format') format?: string,
    @Query('q') q?: string,
    @Query('type') type?: string,
    @Query('status') status?: string,
    @Query('level') level?: string,
    @Query('country') country?: string,
    @Query('emailVerified') emailVerified?: string,
    @Query('kycStatus') kycStatus?: string,
    @Query('tag') tag?: string,
    @Query('sort') sort?: string,
    @Query('order') order?: string,
  ) {
    const chosen = exportFormat(format);
    const query = {
      // Validated identically to the list route, so an unrecognised value is the
      // same 400 there and here rather than an empty file.
      q: searchQuery(q),
      type: enumQuery(type, userTypeEnum.enumValues, 'type'),
      status: enumQuery(status, userStatusEnum.enumValues, 'status'),
      level,
      country: searchQuery(country, 'country'),
      // The export honours the SAME filters as the list, so "export what I am
      // looking at" stays true as filters are added. Omitting these two would
      // have made a filtered screen produce an unfiltered file.
      emailVerified,
      kycStatus,
      tag: searchQuery(tag, 'tag'),
      sort,
      order,
    };

    this.audit.record(req.admin.id, 'export.clients', 'client_list', req.admin.id, {
      format: chosen,
      filters: query,
    });

    await streamCsv(res, 'clients', chosen, this.exports.clientColumns, (offset, limit) =>
      this.exports.clientBatch(query, req.admin, offset, limit),
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
