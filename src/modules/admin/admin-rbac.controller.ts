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
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { ADMIN_SORT_COLUMNS } from '../../store/admins.store';
import { ROLE_SORT_COLUMNS } from '../../store/roles.store';
import { Request, Response } from 'express';
import { AdminRbacService } from './admin-rbac.service';
import { AdminStatusDto, RoleDto, UpdateAdminDto, UpdateRoleDto } from './dto/requests/rbac.dto';
import {
  AdminProfileDto,
  MessageResponseDto,
  PermissionModuleDto,
  RoleResponseDto,
} from './dto/responses.dto';
import {
  PermissionsGuard,
  RequirePermissions,
  type AuthenticatedAdmin,
} from './guards/admin.guard';
import { UuidParam } from '../../common/query-params';
import { NotClientScoped } from './guards/client-scope.decorator';
import { ClientFieldsService } from './client-fields.service';
import { ClientFieldGroupDto } from './dto/responses.dto';
import { Audited, NotAudited } from './guards/audited.decorator';
import { AdminExportService } from './admin-export.service';
import {
  exportFormat,
  streamCsvFromArray,
  EXPORT_RATE_LIMIT,
} from '../../common/export/export-response';

/** Permission catalog, roles and the admin directory (RBAC-02/07). */
@ApiTags('admin')
@ApiExtraModels(PermissionModuleDto)
@Controller('admin')
export class AdminRbacController {
  constructor(
    private readonly rbac: AdminRbacService,
    private readonly clientFields: ClientFieldsService,
    private readonly exports: AdminExportService,
  ) {}

  // ── RBAC: permission catalog, roles, admin directory (RBAC-02/07) ─────────
  @Get('permissions')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('roles.view', 'admins.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Permission catalog grouped by module (requires roles.view or admins.view)',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      additionalProperties: {
        $ref: '#/components/schemas/PermissionModuleDto',
      },
    },
  })
  @NotClientScoped('The permission catalog — a static vocabulary, not client data.')
  getPermissions() {
    return this.rbac.getPermissionsCatalog();
  }

  /**
   * The RBAC-03 field catalog — which client fields exist, and which may be
   * hidden.
   *
   * Served for the same reason `GET /admin/permissions` is (R-4.5): the
   * frontend never invents a key. A mask key with no backend counterpart is not
   * a cosmetic bug — it is a field an operator ticked a box for and believes
   * they hid.
   */
  @Get('client-fields')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('roles.view', 'admins.view')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Maskable client fields, grouped (requires roles.view or admins.view)' })
  @ApiOkResponse({
    schema: {
      type: 'object',
      additionalProperties: { $ref: '#/components/schemas/ClientFieldGroupDto' },
    },
  })
  @ApiExtraModels(ClientFieldGroupDto)
  @NotClientScoped(
    'The field VOCABULARY — a static catalog read from disk, containing no client data.',
  )
  listClientFields() {
    return this.clientFields.publicCatalog();
  }

  @Get('roles')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('roles.view', 'admins.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'List RBAC roles (requires roles.view or admins.view)',
  })
  @ApiOkResponse({ type: [RoleResponseDto] })
  @ApiQuery({ name: 'sort', required: false, enum: Object.keys(ROLE_SORT_COLUMNS) })
  @ApiQuery({ name: 'order', required: false, enum: ['asc', 'desc'] })
  @NotClientScoped('RBAC configuration; roles are not clients.')
  listRoles(@Query('sort') sort?: string, @Query('order') order?: string) {
    // Validated in the service against ROLE_SORT_COLUMNS — the one place the
    // column mapping lives. Defaults to name ascending.
    return this.rbac.listRoles({ sort, order });
  }

  /**
   * The role definitions as CSV.
   *
   * `permissions` and `maskedFields` are array columns, joined with spaces
   * rather than commas: a comma-joined list inside a CSV cell is correct once
   * quoted, but it reads as several columns to anyone eyeballing the file, and
   * these are exactly the cells somebody scans when auditing who can do what.
   */
  @Get('roles/export')
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
  // OR semantics, matching GET /admin/roles exactly.
  @RequirePermissions('roles.view', 'admins.view')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Export the RBAC role definitions as CSV' })
  @ApiOkResponse({
    description: 'A CSV file, named `roles-<YYYY-MM-DD>.csv`.',
    content: { 'text/csv': { schema: { type: 'string', format: 'binary' } } },
  })
  @ApiQuery({ name: 'format', required: false, enum: ['csv'] })
  @NotClientScoped('RBAC configuration; roles are not clients.')
  @NotAudited(
    'RBAC configuration naming no client. Every CHANGE to a role is audited (role.create/update/delete); reading the definitions is not the act worth attributing.',
  )
  async exportRoles(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Res() res: Response,
    @Query('format') format?: string,
  ) {
    const chosen = exportFormat(format);
    await streamCsvFromArray(res, 'roles', chosen, this.exports.roleColumns, () =>
      this.exports.allRoles(req.admin),
    );
  }

  @Post('roles')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('roles.create')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Create a custom role (requires roles.manage)' })
  @ApiOkResponse({ type: RoleResponseDto })
  @NotClientScoped('RBAC configuration; roles are not clients.')
  @Audited('role.create')
  createRole(@Body() dto: RoleDto, @Req() req: Request & { admin: AuthenticatedAdmin }) {
    return this.rbac.createRole(
      dto.name,
      dto.description,
      dto.permissions,
      req.admin,
      dto.maskedFields,
    );
  }

  @Put('roles/:id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('roles.edit')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Update a custom role (requires roles.manage)' })
  @ApiOkResponse({ type: RoleResponseDto })
  @NotClientScoped('RBAC configuration; roles are not clients.')
  @Audited('role.update')
  updateRole(
    @Param('id', UuidParam) id: string,
    @Body() dto: UpdateRoleDto,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    return this.rbac.updateRole(id, dto, req.admin);
  }

  @Delete('roles/:id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('roles.delete')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Delete a custom role (requires roles.manage)' })
  @ApiOkResponse({ type: MessageResponseDto })
  @NotClientScoped('RBAC configuration; roles are not clients.')
  @Audited('role.delete')
  deleteRole(
    @Param('id', UuidParam) id: string,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    return this.rbac.deleteRole(id, req.admin.id);
  }

  @Get('users')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('admins.view')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'List admin accounts (requires admins.view)' })
  /*
   * Two response shapes, and the OpenAPI declaration says so.
   *
   * Unpaged (no `page`/`limit`) this is the bare array it has always been —
   * live callers read it that way, and administrators number in the dozens.
   * Ask for a page and you get the standard `{ items, total, page, limit }`
   * envelope instead. Declaring only the array would make the generated
   * frontend types wrong for anybody who opts in, and declaring only the
   * envelope would make them wrong for everybody who has not.
   */
  @ApiOkResponse({
    description:
      'A bare array by default. With `page` or `limit`, the paginated envelope ' +
      '`{ items, total, page, limit }` instead.',
    schema: {
      oneOf: [
        { type: 'array', items: { $ref: getSchemaPath(AdminProfileDto) } },
        {
          type: 'object',
          properties: {
            items: { type: 'array', items: { $ref: getSchemaPath(AdminProfileDto) } },
            total: { type: 'number' },
            page: { type: 'number' },
            limit: { type: 'number' },
          },
          required: ['items', 'total', 'page', 'limit'],
        },
      ],
    },
  })
  @ApiExtraModels(AdminProfileDto)
  @ApiQuery({ name: 'sort', required: false, enum: Object.keys(ADMIN_SORT_COLUMNS) })
  @ApiQuery({ name: 'order', required: false, enum: ['asc', 'desc'] })
  @ApiQuery({
    name: 'page',
    required: false,
    description: 'Opting into paging switches the response to the envelope shape.',
  })
  @ApiQuery({ name: 'limit', required: false })
  @NotClientScoped(
    'The ADMINISTRATOR directory. Administrators are not clients and are never scoped by client tag.',
  )
  listAdmins(
    @Query('sort') sort?: string,
    @Query('order') order?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.rbac.listAdmins({ sort, order, page, limit });
  }

  /**
   * The administrator directory as CSV.
   *
   * ── Served under `users/export`, and why that is not the client list ──────
   *
   * `/admin/users` is the ADMINISTRATOR directory; the client list is
   * `/admin/clients`. The admin frontend calls this one `admin-users`, so the
   * file is named `admin-users-<date>.csv` rather than `users-…` — a file
   * called `users.csv` sitting in a downloads folder beside `clients.csv` is
   * exactly the ambiguity worth spending a hyphen to avoid.
   *
   * Declared before `users/:id` so Express does not bind `id = 'export'`.
   *
   * ── `permissions` here are RESOLVED, not stored ───────────────────────────
   *
   * `listAdmins` expands each admin's role into the live permission set, so the
   * file answers "what can this person do today" rather than "what was written
   * on their row". That is the question somebody exports this to answer.
   */
  /*
   * `admin-users`, NOT `users` — the path the admin client actually calls.
   *
   * Its `ExportResource` union names this resource `'admin-users'` and builds
   * the URL as `/admin/${resource}/export`, so the request on the wire is
   * `GET /admin/admin-users/export`. Serving it at `/admin/users/export`
   * instead would 404, and that app deliberately reads a 404 as "the backend
   * has not built this endpoint yet" — so the button would render as
   * unavailable and nobody would see an error worth investigating.
   *
   * The name is also the better one on its own merits: `/admin/users` is the
   * ADMINISTRATOR directory while clients live at `/admin/clients`, and a
   * downloaded file called `users.csv` sitting beside `clients.csv` is exactly
   * the ambiguity worth spending a prefix to avoid. The list route keeps its
   * historical `users` path; only the export is named for what it contains.
   */
  @Get('admin-users/export')
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
  @RequirePermissions('admins.view')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Export the administrator directory as CSV' })
  @ApiOkResponse({
    description: 'A CSV file, named `admin-users-<YYYY-MM-DD>.csv`.',
    content: { 'text/csv': { schema: { type: 'string', format: 'binary' } } },
  })
  @ApiQuery({ name: 'format', required: false, enum: ['csv'] })
  @NotClientScoped(
    'The ADMINISTRATOR directory. Administrators are not clients and are never scoped by client tag — the same stance the list carries.',
  )
  @NotAudited(
    'The administrator directory contains no client data, and every change to an admin is separately audited (admin.update/suspend). Reading the roster is not the act worth attributing.',
  )
  async exportAdmins(@Res() res: Response, @Query('format') format?: string) {
    const chosen = exportFormat(format);
    /*
     * Called with NO arguments, which selects the overload returning a bare
     * array rather than the paginated one. Passing `{}` would resolve to the
     * union and hand a `{ items, total }` object to something expecting rows —
     * the export wants every administrator, never a page of them.
     */
    await streamCsvFromArray(res, 'admin-users', chosen, ADMIN_EXPORT_COLUMNS, () =>
      this.rbac.listAdmins(),
    );
  }

  @Patch('users/:id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('admins.edit')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Update an admin’s name, role, or permissions (requires admins.edit)',
  })
  @ApiOkResponse({ type: AdminProfileDto })
  @NotClientScoped('Edits an administrator, not a client.')
  @Audited('admin.update')
  updateAdmin(
    @Param('id', UuidParam) id: string,
    @Body() dto: UpdateAdminDto,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    return this.rbac.updateAdmin(id, dto, req.admin);
  }

  /*
   * Separate from PATCH users/:id on purpose: suspension needs users.SUSPEND,
   * not admins.edit. One endpoint whose required permission depends on which
   * body keys arrive is a guard that silently widens the next time a field is
   * added. See AdminStatusDto.
   */
  @Patch('users/:id/status')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('admins.suspend')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Suspend or reactivate an administrator (requires admins.suspend)',
    description:
      'Suspension takes effect on the target’s NEXT request — AdminGuard re-reads status ' +
      'on every call — and blocks login. Refused on your own account and on the master admin.',
  })
  @ApiOkResponse({ type: AdminProfileDto })
  @NotClientScoped('Suspends an administrator, not a client.')
  @Audited('admin.suspend')
  setAdminStatus(
    @Param('id', UuidParam) id: string,
    @Body() dto: AdminStatusDto,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    return this.rbac.setAdminStatus(id, dto.status, req.admin);
  }
}

/**
 * The administrator export's columns.
 *
 * No password hash, no token, no session — `listAdmins` sanitises through an
 * ALLOW-list and this reads only from what it returns, so a column cannot
 * accidentally start carrying a secret that is added to the table later.
 *
 * `Scoped tags` is the administrator's client territory. An empty cell means
 * unrestricted, which is the deliberately permissive default recorded in
 * `common/security/client-scope.ts` — worth reading as "sees everyone", not as
 * "sees nobody".
 */
const ADMIN_EXPORT_COLUMNS = [
  { header: 'Admin ID', value: (r: AdminExportRow) => r.id },
  { header: 'Email', value: (r: AdminExportRow) => r.email },
  { header: 'Name', value: (r: AdminExportRow) => r.name },
  { header: 'Role', value: (r: AdminExportRow) => r.role },
  { header: 'Status', value: (r: AdminExportRow) => r.status },
  { header: 'Permissions', value: (r: AdminExportRow) => r.permissions.join(' ') },
  { header: 'Masked fields', value: (r: AdminExportRow) => r.maskedFields.join(' ') },
  {
    header: 'Scoped tags',
    value: (r: AdminExportRow) => r.scopedTags.map((t) => t.slug).join(' '),
  },
  { header: 'Created at', value: (r: AdminExportRow) => r.createdAt },
] as const;

interface AdminExportRow {
  id: string;
  email: string;
  name: string;
  role: string;
  status: string;
  permissions: string[];
  maskedFields: string[];
  scopedTags: { slug: string }[];
  createdAt: Date;
}
