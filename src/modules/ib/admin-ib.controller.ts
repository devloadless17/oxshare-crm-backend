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
  ChangeIbLevelDto,
  IbAccountDto,
  IbApplicationDto,
  IB_APPLICATION_STATUSES,
  ReassignIbParentDto,
  RejectIbApplicationDto,
  SetIbActiveDto,
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

  // ── partners, once they exist ──────────────────────────────────────────────

  @Get('partners')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('ib.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'The partner list',
    description: 'Joined to the person and their level, newest approval first.',
  })
  @ScopedToClients('IbStore.findPartnersPage applies the predicate to ib_accounts.user_id.')
  listPartners(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.applications.listPartners(
      { page: parsePositive(page), limit: parsePositive(limit) },
      req.admin.clientScope,
    );
  }

  @Patch('partners/:userId/level')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('ib.manage')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Move a partner to a different level',
    description:
      'The target level must be ENABLED — a disabled one takes no share, so placing somebody on ' +
      'it stops their earnings silently rather than demoting them visibly.',
  })
  @ApiOkResponse({ type: IbAccountDto })
  @ScopedToClients('Acts on one client’s partner account; out-of-scope 404s like a missing one.')
  @Audited('ib.level_change')
  changeLevel(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: ChangeIbLevelDto,
  ) {
    return this.applications.changeLevel(userId, dto.level, req.admin.clientScope);
  }

  @Patch('partners/:userId/parent')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('ib.manage')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Reassign a partner’s parent',
    description:
      'Refuses a change that would put a partner beneath their own descendant. A self-FK cannot ' +
      'catch that — Postgres accepts A→B→A — and the payout walk climbs parents until it runs ' +
      'out, so a loop is a walk that never does.',
  })
  @ApiOkResponse({ type: IbAccountDto })
  @ScopedToClients('Acts on one client’s partner account; out-of-scope 404s like a missing one.')
  @Audited('ib.parent_change')
  reassignParent(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: ReassignIbParentDto,
  ) {
    return this.applications.reassignParent(userId, dto.parentIbUserId, req.admin.clientScope);
  }

  @Patch('partners/:userId/active')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('ib.manage')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Suspend or reactivate a partner',
    description:
      'Suspension keeps the referral code and the tree and stops the earning. There is no ' +
      'delete: removing the row would orphan every client and partner attributed beneath them.',
  })
  @ApiOkResponse({ type: IbAccountDto })
  @ScopedToClients('Acts on one client’s partner account; out-of-scope 404s like a missing one.')
  @Audited('ib.suspend')
  setActive(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: SetIbActiveDto,
  ) {
    return this.applications.setActive(userId, dto.active, req.admin.clientScope);
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
