import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import {
  AuthenticatedAdmin,
  PermissionsGuard,
  RequirePermissions,
} from '../admin/guards/admin.guard';
import { ScopedToClients } from '../admin/guards/client-scope.decorator';
import { Audited } from '../admin/guards/audited.decorator';
import { IbApplicationsService } from './ib-applications.service';
import {
  ApproveIbApplicationDto,
  IbAccountDto,
  IbApplicationDto,
  IB_APPLICATION_STATUSES,
  RejectIbApplicationDto,
  type IbApplicationStatusDto,
} from './dto/ib-application.dto';

/**
 * Reviewing partner applications.
 *
 * ## `@ScopedToClients`, unlike the levels controller
 *
 * Every route here reaches a CLIENT — an application names the person who made
 * it — so an admin restricted to a subset of the client base must not see or
 * decide one from outside it. The list applies the predicate in its query; the
 * decisions ask `ClientVisibilityService` first, and get a 404 rather than a
 * 403 so the id cannot be used to enumerate the clients they were denied.
 *
 * ## Approve and reject are SEPARATE permissions
 *
 * `ib.approve` and `ib.reject`, not one `ib.decide`. Granting somebody the
 * ability to turn applications down is a smaller act of trust than granting
 * them the ability to create partners who will be paid, and a single key makes
 * that distinction unavailable to whoever configures a role.
 *
 * Neither one implies `ib.manage`: rewriting the payout ladder is a different
 * power from deciding who joins it.
 */
@ApiTags('admin')
@Controller('admin/ib')
export class AdminIbController {
  constructor(private readonly applications: IbApplicationsService) {}

  @Get('applications')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('ib.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'The partner application queue',
    description:
      'Paginated, newest first, with per-status counts for the tab labels. Both the rows and ' +
      'the counts respect the reviewing admin’s client scope.',
  })
  @ScopedToClients('IbStore.findPageWithUsers applies the predicate to ib_applications.user_id.')
  list(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.applications.list(
      {
        // `ib_application_status` is a Postgres enum, so an unrecognised value
        // would error in the database rather than at the edge.
        status: parseStatus(status),
        page: parsePositive(page),
        limit: parsePositive(limit),
      },
      req.admin.clientScope,
    );
  }

  @Patch('applications/:id/approve')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('ib.approve')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Approve an application and create the partner account',
    description:
      'One transaction: the application moves out of pending and the account is created ' +
      'together, so there is no state where a client has been told they were accepted and has ' +
      'no referral code. Refuses if another reviewer already decided it.',
  })
  @ApiOkResponse({ type: IbAccountDto })
  @ScopedToClients('Decides on one client’s application; out-of-scope 404s like a missing one.')
  @Audited('ib.approve')
  approve(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveIbApplicationDto,
  ) {
    return this.applications.approve(id, req.admin.id, req.admin.clientScope, {
      level: dto.level,
      parentIbUserId: dto.parentIbUserId ?? null,
    });
  }

  @Patch('applications/:id/reject')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('ib.reject')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Reject an application, with a reason',
    description:
      'The reason is required and composed server-side from a configured label plus an optional ' +
      'note. It is stored already composed, because that is the sentence the client is shown.',
  })
  @ApiOkResponse({ type: IbApplicationDto })
  @ScopedToClients('Decides on one client’s application; out-of-scope 404s like a missing one.')
  @Audited('ib.reject')
  reject(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectIbApplicationDto,
  ) {
    return this.applications.reject(id, req.admin.id, req.admin.clientScope, dto);
  }
}

/** An unrecognised status is ignored rather than 500ing in the database. */
function parseStatus(value?: string): IbApplicationStatusDto | undefined {
  return IB_APPLICATION_STATUSES.find((s) => s === value);
}

function parsePositive(value?: string): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
