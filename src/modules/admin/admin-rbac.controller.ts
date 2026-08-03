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
import { Admin } from '../../store/admins.store';
import { RoleDto, UpdateAdminDto, UpdateRoleDto } from './dto/requests/rbac.dto';
import {
  AdminProfileDto,
  MessageResponseDto,
  PermissionModuleDto,
  RoleResponseDto,
} from './dto/responses.dto';
import { PermissionsGuard, RequirePermissions } from './guards/admin.guard';

/** Permission catalog, roles and the admin directory (RBAC-02/07). */
@ApiTags('admin')
@ApiExtraModels(PermissionModuleDto)
@Controller('admin')
export class AdminRbacController {
  constructor(private readonly rbac: AdminRbacService) {}

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
  getPermissions() {
    return this.rbac.getPermissionsCatalog();
  }

  @Get('roles')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('roles.view', 'users.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'List RBAC roles (requires roles.view or users.view)',
  })
  @ApiOkResponse({ type: [RoleResponseDto] })
  listRoles() {
    return this.rbac.listRoles();
  }

  @Post('roles')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('roles.manage')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Create a custom role (requires roles.manage)' })
  @ApiOkResponse({ type: RoleResponseDto })
  createRole(@Body() dto: RoleDto, @Req() req: Request & { admin: Admin }) {
    return this.rbac.createRole(dto.name, dto.description, dto.permissions, req.admin);
  }

  @Put('roles/:id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('roles.manage')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Update a custom role (requires roles.manage)' })
  @ApiOkResponse({ type: RoleResponseDto })
  updateRole(
    @Param('id') id: string,
    @Body() dto: UpdateRoleDto,
    @Req() req: Request & { admin: Admin },
  ) {
    return this.rbac.updateRole(id, dto, req.admin);
  }

  @Delete('roles/:id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('roles.manage')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Delete a custom role (requires roles.manage)' })
  @ApiOkResponse({ type: MessageResponseDto })
  deleteRole(@Param('id') id: string, @Req() req: Request & { admin: Admin }) {
    return this.rbac.deleteRole(id, req.admin.id);
  }

  @Get('users')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('users.view')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'List admin accounts (requires users.view)' })
  @ApiOkResponse({ type: [AdminProfileDto] })
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
  updateAdmin(
    @Param('id') id: string,
    @Body() dto: UpdateAdminDto,
    @Req() req: Request & { admin: Admin },
  ) {
    return this.rbac.updateAdmin(id, dto, req.admin);
  }
}
