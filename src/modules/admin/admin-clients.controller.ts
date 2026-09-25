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

import { Body, Controller, Get, Param, Patch, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { AdminClientsService } from './admin-clients.service';
import { AdminExportService } from './admin-export.service';
import { AdminAuditService } from './admin-audit.service';
import { exportFormat, streamCsv, EXPORT_RATE_LIMIT } from '../../common/export/export-response';
import {
  ChangeClientEmailDto,
  ClientStatusDto,
  SetClientReferrerDto,
  UpdateClientProfileDto,
} from './dto/requests/clients.dto';
import { ClientAccountDto, ClientListResponseDto, ClientProfileDto } from './dto/responses.dto';
import {
  PermissionsGuard,
  RequirePermissions,
  type AuthenticatedAdmin,
} from './guards/admin.guard';
import { enumQuery, searchQuery } from '../../common/query-params';
import { ClientRefPipe } from '../../common/client-ref.pipe';
import { kycStatusEnum, userStatusEnum, userTypeEnum } from '../../database/schema';
import { CLIENT_SORT_COLUMNS } from '../../store/users.store';
import { ScopedToClients } from './guards/client-scope.decorator';
import { Audited } from './guards/audited.decorator';
import { AnnouncesChange } from '../../common/realtime/announces-change.decorator';

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
  @RequirePermissions('clients.view')
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
  @ApiQuery({
    name: 'q',
    required: false,
    description: 'A Portal ID (digits, matched exactly) or free text over email and name.',
  })
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
  @ApiQuery({
    name: 'referredBy',
    required: false,
    description:
      'Clients introduced by this partner, by the partner’s Portal ID ' +
      '(users.referred_by_ib_user_id). Scoped like every other filter — a reader still only ' +
      'sees their own territory. A value that is not a Portal ID is a 400, never a silently ' +
      'unfiltered list.',
  })
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
    @Query('referredBy', ClientRefPipe) referredBy?: string,
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
        // Validated in the SERVICE against a uuid shape: a malformed value is
        // a 400, never a silently unfiltered list. See the note beside UUID_RE
        // there — an ignored filter is what puts a "filtered by X" banner over
        // every row in the system.
        referredBy,
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
   * `ClientRefPipe` and 400s. The export route must be registered before the
   * parameterised one. This is the same trap `kyc/:userId` and the IB routes
   * have, and each of those export routes is placed the same way.
   *
   * ── The same permission and the same scope as the list ────────────────────
   *
   * `clients.view` and `@ScopedToClients`, not because the decorators were copied
   * but because an export that required less, or scoped less, would be a
   * documented way around both. `AdminExportService.clientBatch` passes
   * `actor.clientScope` into the same `UsersStore.findPage` the list calls, and
   * it applies the RBAC-03 field mask too — an admin who may not see email
   * addresses on screen must not be handed a file of them.
   */
  @Get('clients/export')
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
  @RequirePermissions('clients.view')
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
  @ApiQuery({
    name: 'q',
    required: false,
    description: 'A Portal ID (digits, matched exactly) or free text over email and name.',
  })
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
  @ApiQuery({
    name: 'referredBy',
    required: false,
    description:
      'Clients introduced by this partner, by Portal ID — the same filter as the list, so the ' +
      'file matches the screen it was exported from.',
  })
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
    @Query('referredBy', ClientRefPipe) referredBy?: string,
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
      // One partner's book — the Network tab's "see all" view. Validated in
      // `clientBatch` like the list validates it: malformed is a 400.
      referredBy,
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
  @RequirePermissions('clients.view')
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
    @Param('id', ClientRefPipe) id: string,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    return this.clients.getClientProfile(id, req.admin);
  }

  @Patch('clients/:id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('clients.edit')
  @ApiCookieAuth()
  @ApiOperation({
    summary: "Correct a client's profile (requires clients.edit)",
    description:
      'Name, phone and country only — the clerical set a support desk fixes when a client typed ' +
      'them wrong at registration.\n\n' +
      'Email is NOT here. It lives on PATCH /admin/clients/:id/email behind the separate ' +
      '`clients.email` permission, because changing the address an account signs in with is an ' +
      'account-takeover primitive and must not ride along with fixing a surname.\n\n' +
      '`status` is not here either (PATCH .../status, `clients.suspend`), and neither is ' +
      'verification level or type — those are conclusions the KYC and partner flows reach from ' +
      'evidence, not fields to type in.\n\n' +
      'Send an empty string for phone or country to clear it.',
  })
  @ApiOkResponse({ type: ClientAccountDto })
  @ScopedToClients('UsersStore.findForAdmin(id, scope) — an out-of-scope client is 404, never 403.')
  @Audited('client.profile_update')
  updateClientProfile(
    @Param('id', ClientRefPipe) id: string,
    @Body() dto: UpdateClientProfileDto,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    return this.clients.updateClientProfile(id, dto, req.admin);
  }

  @Patch('clients/:id/email')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('clients.email')
  @ApiCookieAuth()
  @ApiOperation({
    summary: "Change a client's sign-in email (requires clients.email)",
    description:
      '⚠️ The one operation on this surface that can take an account over: point the address at ' +
      'your own inbox, run a password reset, and the balance follows. It carries its own ' +
      'permission for exactly that reason — `clients.edit` does not grant it.\n\n' +
      'Changing it: revokes every portal session for the client, resets email verification and ' +
      'sends a fresh verification link to the NEW address, and notifies the PREVIOUS address that ' +
      'the change happened. That last one is the control that points at the person who would ' +
      'notice an unauthorised change, so it is sent whether or not anyone asked for it.\n\n' +
      'Already-issued access tokens are short-lived JWTs and expire on their own; what revocation ' +
      'guarantees is that none of them can be refreshed.',
  })
  @ApiOkResponse({ type: ClientAccountDto })
  @ScopedToClients('UsersStore.findForAdmin(id, scope) — an out-of-scope client is 404, never 403.')
  @Audited('client.email_change')
  changeClientEmail(
    @Param('id', ClientRefPipe) id: string,
    @Body() dto: ChangeClientEmailDto,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    return this.clients.changeClientEmail(id, dto.email, req.admin);
  }

  @Patch('clients/:id/referrer')
  @AnnouncesChange('clients')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('clients.referrer.set')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Record the partner who introduced a client, when none is recorded',
    description:
      'Attribution is captured in ONE place — `?ref=` on the registration screen — and both ' +
      'portal auth cross-links dropped it, so a client who followed a partner link, clicked ' +
      '"Sign in", then "Create an account" registered attributed to nobody. Permanently: ' +
      '`referred_by_ib_user_id` was written at registration and nowhere else.\n\n' +
      '⚠️ **NULL to A only.** A client who already has a referrer answers **409 ' +
      'REFERRER_ALREADY_SET**. Re-pointing attribution would move a partner\u2019s client and ' +
      'their future commissions to somebody else, which `docs/` forbids — and the refusal is ' +
      'in the service rather than in a screen so this route cannot become that flow later.\n\n' +
      'Takes the CODE the client reports, never a partner id: looking a partner up means ' +
      'picking one off a list, which is the shape of choosing who gets paid.\n\n' +
      'Three distinct refusals, because they need three sentences — ' +
      '`REFERRAL_CODE_UNKNOWN` (a typo), `REFERRAL_SELF` (the client\u2019s own code), and ' +
      '`REFERRAL_PARTNER_INACTIVE` (the code was RIGHT; that partner is suspended).\n\n' +
      'Does NOT backdate: commission reads attribution at accrual time, so this pays on deals ' +
      'not yet accrued and restates nothing already credited.',
  })
  @ApiOkResponse({ type: ClientAccountDto })
  @ScopedToClients('UsersStore.findForAdmin(id, scope) — an out-of-scope client is 404, never 403.')
  @Audited('client.referrer_set')
  setClientReferrer(
    @Param('id', ClientRefPipe) id: string,
    @Body() dto: SetClientReferrerDto,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    return this.clients.setClientReferrer(id, dto.referralCode, req.admin);
  }

  @Patch('clients/:id/status')
  @AnnouncesChange('clients')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('clients.suspend')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Suspend or reactivate a client account (requires clients.suspend)',
  })
  @ScopedToClients('UsersStore.findForAdmin(id, scope) — an out-of-scope client is 404, never 403.')
  @Audited('client.suspend')
  setClientStatus(
    @Param('id', ClientRefPipe) id: string,
    @Body() dto: ClientStatusDto,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    return this.clients.setClientStatus(id, dto.status, req.admin);
  }
}
