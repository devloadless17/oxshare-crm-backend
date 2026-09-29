import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  PermissionsGuard,
  RequirePermissions,
  type AuthenticatedAdmin,
} from '../../admin/guards/admin.guard';
import { NotClientScoped } from '../../admin/guards/client-scope.decorator';
import { Mt5GroupSyncService } from './mt5-group-sync.service';
import { Mt5GroupDto } from './dto/mt5-group.dto';

/**
 * The MT5 Groups screen — what the group sync job has mirrored from the server.
 *
 * ## Read from the mirror, never live
 *
 * `GET /admin/mt5/groups` (on `Mt5AccountsController`) reads the bridge LIVE,
 * because it feeds the account-open picker, where a stale group is an MT5
 * failure. This is a reference screen, and it must still render when the
 * bridge is down — which is exactly when an operator comes looking.
 *
 * ## `trading.view`, like /bridge and /trading-accounts
 *
 * The three answer the same kind of question — what the MT5 side holds — and
 * an operator trusted with one is trusted with the others. Nothing here writes;
 * which product sells a group is edited on the product form.
 */
@ApiTags('admin')
@Controller('admin/mt5-groups')
export class AdminMt5GroupsController {
  constructor(private readonly groups: Mt5GroupSyncService) {}

  @Get()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('trading.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'The MT5 groups the server currently reports, as the sync job mirrored them',
    description:
      'From the local mirror (`mt5_groups`), not the bridge — it renders when the server is ' +
      'unreachable. Groups the server stopped reporting are left out. Each row names the ' +
      'product that sells the group, if any, and how many trading accounts the CRM holds in it.',
  })
  @ApiOkResponse({ type: Mt5GroupDto, isArray: true })
  @NotClientScoped(
    'MT5 server configuration; names no client. Account counts are split by the reader’s ' +
      'territory — a count, never who (D-81 R2).',
  )
  list(@Req() req: Request & { admin: AuthenticatedAdmin }) {
    return this.groups.listForAdmin(req.admin.clientScope);
  }
}
