// Part of the `admin` controller surface, split by concern (see admin-rbac.controller.ts).

import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { AdminIpAllowlistService } from './admin-ip-allowlist.service';
import { Admin } from '../../store/admins.store';
import { AddIpAllowlistRuleDto } from './dto/requests/ip-allowlist.dto';
import { IpAllowlistStatusDto, MessageResponseDto } from './dto/responses.dto';
import { PermissionsGuard, RequirePermissions } from './guards/admin.guard';
import { UuidParam } from '../../common/query-params';
import { clientIp } from '../../common/security/client-ip';
import { NotClientScoped } from './guards/client-scope.decorator';
import { Audited } from './guards/audited.decorator';

/**
 * RBAC-08 — the admin IP allowlist.
 *
 * Gated on `roles.manage`: deciding which networks may reach the administration
 * API is the same class of authority as deciding who holds which permissions,
 * and it should not be reachable by anyone who merely reviews KYC.
 */
@ApiTags('admin')
@Controller('admin')
export class AdminIpAllowlistController {
  constructor(private readonly allowlist: AdminIpAllowlistService) {}

  @Get('ip-allowlist')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('roles.manage')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'The IP allowlist, whether it is being enforced, and your own address',
  })
  @ApiOkResponse({ type: IpAllowlistStatusDto })
  @NotClientScoped('The RBAC-08 network allowlist; contains no client data.')
  async list(@Req() req: Request): Promise<IpAllowlistStatusDto> {
    const rules = await this.allowlist.list();
    return {
      // An empty list means the feature is OFF (D-10) — the UI has to say so
      // plainly, or an operator believes they are protected when they are not.
      enforced: rules.length > 0,
      // Returned so the screen can warn before someone locks themselves out.
      yourIp: clientIp(req) ?? null,
      rules: rules.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
    };
  }

  @Post('ip-allowlist')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('roles.manage')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Add an address or range to the allowlist' })
  @ApiOkResponse({ type: IpAllowlistStatusDto })
  @NotClientScoped('The RBAC-08 network allowlist; contains no client data.')
  @Audited('ip_allowlist.add')
  async add(@Body() dto: AddIpAllowlistRuleDto, @Req() req: Request) {
    const actor = (req as Request & { admin: Admin }).admin;
    // The caller's own address, so a rule that would lock them out is refused
    // rather than applied and regretted.
    await this.allowlist.add(dto, actor, clientIp(req));
    return this.list(req);
  }

  @Delete('ip-allowlist/:id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('roles.manage')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Remove a rule from the allowlist' })
  @ApiOkResponse({ type: MessageResponseDto })
  @NotClientScoped('The RBAC-08 network allowlist; contains no client data.')
  @Audited('ip_allowlist.remove')
  async remove(@Param('id', UuidParam) id: string, @Req() req: Request) {
    const actor = (req as Request & { admin: Admin }).admin;
    await this.allowlist.remove(id, actor, clientIp(req));
    return { message: 'Rule removed.' };
  }
}
