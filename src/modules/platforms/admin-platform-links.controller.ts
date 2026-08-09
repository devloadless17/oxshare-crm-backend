import { Body, Controller, Get, Param, Put, Req, UseGuards } from '@nestjs/common';
import { NotClientScoped } from '../../modules/admin/guards/client-scope.decorator';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { Admin } from '../../store/admins.store';
import { PermissionsGuard, RequirePermissions } from '../admin/guards/admin.guard';
import { PlatformLinksService } from './platform-links.service';
import { PlatformLinkDto, SetPlatformLinkDto } from './dto/platform-link.dto';
import { Audited } from '../admin/guards/audited.decorator';

/**
 * The operator's control over the download links.
 *
 * A PERMISSION (`settings.edit`), not `MasterAdminGuard`, and that is the
 * opposite call from `admin-security-settings.controller.ts` — deliberately.
 *
 * That controller is master-admin-only because what it switches off is the
 * control standing between a stolen client session and that client's balance,
 * and some capabilities should not be delegatable at all. A download URL is not
 * that. It is routine operational content that changes with every terminal
 * build, and the person who does it is exactly the sub-admin RBAC-02 exists to
 * describe. Forcing a master admin to paste a URL is how the master credential
 * ends up shared.
 *
 * It is not unguarded, though: the value becomes an `href` in every client's
 * browser, which is why the service refuses anything that is not `https:`.
 */
@ApiTags('admin')
@Controller('admin')
export class AdminPlatformLinksController {
  constructor(private readonly platforms: PlatformLinksService) {}

  @Get('platforms')
  // PermissionsGuard, not AdminGuard: only PermissionsGuard reads
  // PERMISSIONS_KEY, so the decorator below was inert and any authenticated
  // admin could reach these routes — including the PUT, which sets the
  // executable download URL every client is handed.
  @UseGuards(PermissionsGuard)
  @RequirePermissions('settings.edit')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Download links for every platform, configured or not' })
  @ApiOkResponse({ type: PlatformLinkDto, isArray: true })
  @NotClientScoped('Client-facing download links; configuration, not client data.')
  list() {
    return this.platforms.list();
  }

  @Put('platforms/:key')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('settings.edit')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Set or clear one download link',
    description:
      'An empty url clears the link, and the portal then shows that platform as not available ' +
      'yet. Only https is accepted: this link is how a client obtains an executable.',
  })
  @ApiOkResponse({ type: PlatformLinkDto })
  @NotClientScoped('Client-facing download links; configuration, not client data.')
  @Audited('platform_link.set')
  set(
    @Param('key') key: string,
    @Body() dto: SetPlatformLinkDto,
    @Req() req: Request & { admin: Admin },
  ) {
    return this.platforms.set(key, dto.url ?? null, req.admin);
  }
}
