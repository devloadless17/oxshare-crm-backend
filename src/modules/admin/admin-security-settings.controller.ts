// Part of the `admin` controller surface, split by concern — see the note in
// admin-audit.controller.ts.

import { Body, Controller, Get, Param, Put, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { Admin } from '../../store/admins.store';
import { SecuritySettingsService } from './security-settings.service';
import { MasterAdminGuard } from './guards/admin.guard';
import { SecuritySwitchDto, SetSecuritySwitchDto } from './dto/requests/security-settings.dto';
import { NotClientScoped } from './guards/client-scope.decorator';
import { Audited } from './guards/audited.decorator';

/**
 * The operator's switches for security controls — master admin only.
 *
 * NOT a permission (`@RequirePermissions('settings.security')` or similar), and
 * that is the decision worth defending. RBAC-02 exists so a sub-admin holds only
 * what was explicitly granted, and the thing being granted here is the ability
 * to switch off the control standing between a stolen client session and that
 * client's balance. `MasterAdminGuard` is the same treatment the audit log gets,
 * for the same reason: some capabilities should not be delegatable at all, and
 * making them a permission key means somebody eventually puts them in a role
 * called "Operations".
 */
@ApiTags('admin')
@Controller('admin')
export class AdminSecuritySettingsController {
  constructor(private readonly settings: SecuritySettingsService) {}

  @Get('security-settings')
  @UseGuards(MasterAdminGuard)
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Security controls and whether each is currently on (master admin only)',
  })
  @ApiOkResponse({ type: [SecuritySwitchDto] })
  @NotClientScoped('Operational security switches; contains no client data.')
  list() {
    return this.settings.list();
  }

  @Put('security-settings/:key')
  @UseGuards(MasterAdminGuard)
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Turn a security control on or off (master admin only)',
    description:
      'Every change is written to the admin action log with its before and after value, and ' +
      'turning a control OFF raises an alert — once at the moment of the change, and again on ' +
      'every request made while it stays off.',
  })
  @ApiOkResponse({ type: SecuritySwitchDto })
  @NotClientScoped('Operational security switches; contains no client data.')
  @Audited('security.control.set')
  set(
    @Param('key') key: string,
    @Body() dto: SetSecuritySwitchDto,
    @Req() req: Request & { admin: Admin },
  ) {
    return this.settings.set(key, dto.enabled, req.admin);
  }
}
