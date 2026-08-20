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
import { ipAllowlistEnforced } from '../../common/security/admin-network';
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

  /*
   * `settings.security.*`, NOT the `roles.manage` this shipped with before.
   *
   * That key no longer exists — the catalog was rebuilt into per-module read and
   * write keys, and deciding which networks may reach the console is a SECURITY
   * SETTING rather than a role-management power. Reading the list and changing
   * it are separate keys for the same reason every other module splits them:
   * seeing which ranges are trusted is an audit question, adding one is a change
   * that can lock every administrator out of the building.
   */
  @Get('ip-allowlist')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('settings.security.view')
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
      /*
       * BOTH conditions, because either one alone would be a lie. A non-empty
       * list with `ADMIN_IP_ALLOWLIST_ENABLED=false` is not enforcing anything,
       * and a screen that showed a green shield over it would be claiming a
       * protection that is switched off.
       */
      enforced: rules.length > 0 && ipAllowlistEnforced(),
      /*
       * Reported separately so the console can tell the two "not enforcing"
       * states apart: nobody has added a rule yet, versus somebody deliberately
       * disabled enforcement and the rules are still sitting there.
       */
      disabledByConfig: !ipAllowlistEnforced(),
      // Returned so the screen can warn before someone locks themselves out.
      yourIp: clientIp(req) ?? null,
      rules: rules.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
    };
  }

  @Post('ip-allowlist')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('settings.security.edit')
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
  @RequirePermissions('settings.security.edit')
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
