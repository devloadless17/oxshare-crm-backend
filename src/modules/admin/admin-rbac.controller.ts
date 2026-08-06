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
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Request } from 'express';
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
import { Audited } from './guards/audited.decorator';

/** Permission catalog, roles and the admin directory (RBAC-02/07). */
@ApiTags('admin')
@ApiExtraModels(PermissionModuleDto)
@Controller('admin')
export class AdminRbacController {
  constructor(
    private readonly rbac: AdminRbacService,
    private readonly clientFields: ClientFieldsService,
  ) {}

  // ── RBAC: permission catalog, roles, admin directory (RBAC-02/07) ─────────
  @Get('permissions')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('roles.view', 'users.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Permission catalog grouped by module (requires roles.view or users.view)',
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
  @RequirePermissions('roles.view', 'users.view')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Maskable client fields, grouped (requires roles.view or users.view)' })
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
    return this.clientFields.getCatalog();
  }

  @Get('roles')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('roles.view', 'users.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'List RBAC roles (requires roles.view or users.view)',
  })
  @ApiOkResponse({ type: [RoleResponseDto] })
  @NotClientScoped('RBAC configuration; roles are not clients.')
  listRoles() {
    return this.rbac.listRoles();
  }

  @Post('roles')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('roles.manage')
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
  @RequirePermissions('roles.manage')
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
  @RequirePermissions('roles.manage')
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
  @RequirePermissions('users.view')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'List admin accounts (requires users.view)' })
  @ApiOkResponse({ type: [AdminProfileDto] })
  @NotClientScoped(
    'The ADMINISTRATOR directory. Administrators are not clients and are never scoped by client tag.',
  )
  listAdmins() {
    return this.rbac.listAdmins();
  }

  @Patch('users/:id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('users.edit')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Update an admin’s name, role, or permissions (requires users.edit)',
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
   * not users.edit. One endpoint whose required permission depends on which
   * body keys arrive is a guard that silently widens the next time a field is
   * added. See AdminStatusDto.
   */
  @Patch('users/:id/status')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('users.suspend')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Suspend or reactivate an administrator (requires users.suspend)',
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
