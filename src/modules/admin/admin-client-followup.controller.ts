import { Body, Controller, Get, Param, Put, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { ClientRefPipe } from '../../common/client-ref.pipe';
import { AnnouncesChange } from '../../common/realtime/announces-change.decorator';
import { AdminClientFollowupService } from './admin-client-followup.service';
import { ClientFollowUpDto, UpdateClientFollowUpDto } from './dto/client-followup.dto';
import { Audited } from './guards/audited.decorator';
import { AuthenticatedAdmin, PermissionsGuard, RequirePermissions } from './guards/admin.guard';
import { ScopedToClients } from './guards/client-scope.decorator';

const SCOPED = 'UsersStore.findForAdmin(id, scope) — an out-of-scope client is 404, never 403.';

/** A client's Follow-up and Result — the staff's two notes (0212). */
@ApiTags('admin')
@Controller('admin')
export class AdminClientFollowupController {
  constructor(private readonly followups: AdminClientFollowupService) {}

  @Get('clients/:id/followup')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('clients.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: "A client's Follow-up and Result notes",
    description:
      'The staff’s working notes about a client: what to do next (with an optional date) and ' +
      'how the last contact went. Never shown to the client. A client with no notes reads as ' +
      'both empty, version 0.',
  })
  @ApiOkResponse({ type: ClientFollowUpDto })
  @ScopedToClients(SCOPED)
  get(@Param('id', ClientRefPipe) id: number, @Req() req: Request & { admin: AuthenticatedAdmin }) {
    return this.followups.get(id, req.admin);
  }

  @Put('clients/:id/followup')
  @AnnouncesChange('clients')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('clients.followup.edit')
  @ApiCookieAuth()
  @ApiOperation({
    summary: "Save a client's Follow-up and Result (requires clients.followup.edit)",
    description:
      'Both notes and the date, together. Send back the `version` the GET returned: a save made ' +
      'from an older version answers **409 FOLLOWUP_STALE** and changes nothing, so a ' +
      'colleague’s words are never silently replaced. A save that changes nothing succeeds ' +
      'whatever its version. Every change is recorded in the audit log as ' +
      '`client.followup_update`, before and after.',
  })
  @ApiOkResponse({ type: ClientFollowUpDto })
  @ScopedToClients(SCOPED)
  @Audited('client.followup_update')
  save(
    @Param('id', ClientRefPipe) id: number,
    @Body() dto: UpdateClientFollowUpDto,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    return this.followups.save(
      id,
      {
        followUp: dto.followUp,
        result: dto.result,
        followUpAt: dto.followUpAt,
        version: dto.version,
      },
      req.admin,
    );
  }
}
