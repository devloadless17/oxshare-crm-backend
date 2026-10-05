import { Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import type { Admin } from '../../store/admins.store';
import { PermissionsGuard, RequirePermissions } from '../admin/guards/admin.guard';
import { Audited } from '../admin/guards/audited.decorator';
import { NotClientScoped } from '../admin/guards/client-scope.decorator';
import type { AdminAssistantSettingsView } from './assistant.service';
import { AssistantService } from './assistant.service';
import { AdminAssistantSettingsDto, UpdateAssistantSettingsDto } from './dto/assistant.dto';

/**
 * The assistant's switch and limits, on the Settings page (0187).
 * `settings.view` / `settings.edit`, the same pair as the Trading terms.
 * Turning it off is the kill switch: the portal's launcher disappears and
 * every question is refused at once, with no redeploy.
 */
@ApiTags('admin')
@Controller('admin/settings/assistant')
export class AdminAssistantController {
  constructor(private readonly assistant: AssistantService) {}

  @Get()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('settings.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'The portal assistant: switch, limits and usage today',
    description: 'Usage counts answers and tokens since midnight UTC, across every client.',
  })
  @ApiOkResponse({ type: AdminAssistantSettingsDto })
  @NotClientScoped('Platform-wide switch and aggregate usage; contains no client data.')
  async get(): Promise<AdminAssistantSettingsDto> {
    return view(await this.assistant.adminSettings());
  }

  @Put()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('settings.edit')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Switch the assistant on or off, and set its daily limits' })
  @ApiOkResponse({ type: AdminAssistantSettingsDto })
  @NotClientScoped('Platform-wide switch and aggregate usage; contains no client data.')
  @Audited('settings.assistant.update')
  async set(
    @Body() dto: UpdateAssistantSettingsDto,
    @Req() req: Request & { admin: Admin },
  ): Promise<AdminAssistantSettingsDto> {
    return view(
      await this.assistant.setAdminSettings(
        {
          enabled: dto.enabled,
          dailyMessageLimit: dto.dailyMessageLimit,
          globalDailyMessageLimit: dto.globalDailyMessageLimit,
        },
        req.admin.id,
      ),
    );
  }
}

function view(settings: AdminAssistantSettingsView): AdminAssistantSettingsDto {
  return {
    enabled: settings.enabled,
    dailyMessageLimit: settings.dailyMessageLimit,
    globalDailyMessageLimit: settings.globalDailyMessageLimit,
    keyConfigured: settings.keyConfigured,
    model: settings.model,
    today: settings.today,
    updatedAt: settings.updatedAt ? settings.updatedAt.toISOString() : null,
  };
}
