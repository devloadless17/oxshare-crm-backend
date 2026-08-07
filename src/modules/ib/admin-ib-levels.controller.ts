import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
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
import { NotClientScoped } from '../admin/guards/client-scope.decorator';
import { Audited } from '../admin/guards/audited.decorator';
import { IbLevelsService } from './ib-levels.service';
import {
  CreateIbLevelDto,
  IbLevelDto,
  ReorderIbLevelsDto,
  UpdateIbLevelDto,
} from './dto/ib-level.dto';

/**
 * The IB payout ladder — how deep partner earnings travel and what each level
 * takes.
 *
 * ## `@NotClientScoped`, and why that is not an oversight
 *
 * Every admin route must declare a client-scope stance and
 * `client-scope-coverage.spec.ts` fails the build on one that declares neither.
 * This is platform configuration: it names no client, returns no client data,
 * and is identical for every admin who can see it. The PARTNER routes in this
 * module are the opposite — they read `ib_accounts.user_id` and will be
 * `@ScopedToClients`.
 *
 * ## Reads are `ib.view`, writes are `ib.manage`
 *
 * Matching the general-settings split. `ib.approve` and `ib.reject` are
 * deliberately NOT accepted here: approving a partner application and rewriting
 * the payout ladder are different powers, and an operator granted the first
 * should not silently acquire the second.
 */
@ApiTags('admin')
@Controller('admin/ib-levels')
export class AdminIbLevelsController {
  constructor(private readonly levels: IbLevelsService) {}

  @Get()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('ib.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'The payout ladder, shallowest level first',
    description:
      'Includes disabled levels — managing them is the point of the screen. The number of ' +
      'ENABLED levels is the depth of the payout chain.',
  })
  @ApiOkResponse({ type: IbLevelDto, isArray: true })
  @NotClientScoped('Platform payout configuration; names no client and returns no client data.')
  list() {
    return this.levels.listAll();
  }

  @Post()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('ib.manage')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Add a level to the ladder',
    description:
      'The level number is chosen, not auto-assigned. Under revenue_share the enabled levels ' +
      'must total at most 100% — the refusal names the current total and the room left.',
  })
  @ApiOkResponse({ type: IbLevelDto })
  @NotClientScoped('Platform payout configuration; names no client and returns no client data.')
  @Audited('ib_level.create')
  create(@Req() req: Request & { admin: AuthenticatedAdmin }, @Body() dto: CreateIbLevelDto) {
    return this.levels.create(dto, req.admin);
  }

  @Patch(':level')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('ib.manage')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Update a level',
    description:
      'PATCH, and `level` itself is not editable: it is the primary key and partner records ' +
      'reference it, so renumbering is a data migration rather than an edit.',
  })
  @ApiOkResponse({ type: IbLevelDto })
  @NotClientScoped('Platform payout configuration; names no client and returns no client data.')
  @Audited('ib_level.update')
  update(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Param('level', ParseIntPipe) level: number,
    @Body() dto: UpdateIbLevelDto,
  ) {
    return this.levels.update(level, dto, req.admin);
  }

  /**
   * Reorder the ladder.
   *
   * PATCH on the COLLECTION, not on a level: this renumbers every rung and
   * remaps every partner standing on them, so it is one act on the ladder
   * rather than a series of edits to individual levels. Sending it as several
   * PATCH /:level calls would let a half-applied order become a real state.
   */
  @Patch()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('ib.manage')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Renumber the ladder',
    description:
      'Takes every existing level exactly once, in the order they should appear, and renumbers ' +
      'them 1..n. Partner placements are remapped in the same transaction, so a partner keeps ' +
      'the rung they were placed on.',
  })
  @ApiOkResponse({ type: IbLevelDto, isArray: true })
  @NotClientScoped('Platform payout configuration; names no client and returns no client data.')
  @Audited('ib_level.reorder')
  reorder(@Req() req: Request & { admin: AuthenticatedAdmin }, @Body() dto: ReorderIbLevelsDto) {
    return this.levels.reorder(dto.order, req.admin);
  }

  @Delete(':level')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('ib.manage')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Remove a level',
    description:
      'Refuses to empty the ladder: a platform with no levels can approve no partners. Once ' +
      'partner records exist this will also refuse a level anybody is placed at.',
  })
  @NotClientScoped('Platform payout configuration; names no client and returns no client data.')
  @Audited('ib_level.delete')
  remove(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Param('level', ParseIntPipe) level: number,
  ) {
    return this.levels.remove(level, req.admin);
  }
}
