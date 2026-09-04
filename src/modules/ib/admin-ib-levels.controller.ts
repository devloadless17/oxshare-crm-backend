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
  IbLevelLimitsDto,
  UpdateIbLevelDto,
} from './dto/ib-level.dto';

/**
 * The commission ladder — one rung per level of the partner tree (0112).
 *
 * ## This is the ONLY catalogue of terms
 *
 * `admin/ib-programs` used to be, and the two cannot coexist: a partner cannot
 * be paid both by the card they hold and by where they stand. The programme
 * routes are gone with this change. What is left of that catalogue is the
 * historical record on `ib_accruals.program_id` — which terms paid a commission
 * accrued before the switch — and nothing reads it to decide a new payout.
 *
 * ## `ib.levels.*` stay separate from `ib.view`
 *
 * An operator trusted to READ the ladder is not automatically trusted to change
 * what every partner on it earns. `ib.approve` and `ib.reject` are deliberately
 * NOT accepted here either: approving a partner application and rewriting the
 * payout ladder are different powers.
 *
 * ## `@NotClientScoped`, and why that is not an oversight
 *
 * Every admin route must declare a client-scope stance and
 * `client-scope-coverage.spec.ts` fails the build on one that declares neither.
 * This is platform configuration: it names no client, returns no client data,
 * and is identical for every admin who can see it.
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
    summary: 'The commission ladder, shallowest level first',
    description:
      'Includes disabled levels — managing them is the point of the screen. Each row carries ' +
      'how many partners stand on it, so a delete can be refused before the database refuses it ' +
      'and a rate change can say how many people it affects.',
  })
  @ApiOkResponse({ type: IbLevelDto, isArray: true })
  @NotClientScoped('Platform commission configuration; names no client and returns no client data.')
  list() {
    return this.levels.listAll();
  }

  /*
   * BEFORE `@Patch(':level')` and `@Delete(':level')` — a literal segment a
   * parameterised route could otherwise swallow. `ParseIntPipe` would refuse
   * "limits" anyway, but ordering it correctly means the refusal never has to
   * be the thing that saves it.
   */
  @Get('limits')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('ib.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'The bounds a level must fit inside',
    description:
      'How deep the ladder may run, from `IB_MAX_LEVELS`. Read by the form so it stops offering ' +
      '"add a level" at the right point — a hardcoded copy would drift the day a broker ' +
      'negotiates a deeper structure.',
  })
  @ApiOkResponse({ type: IbLevelLimitsDto })
  @NotClientScoped('Platform commission configuration; names no client and returns no client data.')
  limits() {
    return this.levels.limits();
  }

  @Post()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('ib.levels.create')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Add a level to the ladder',
    description:
      'The level number is chosen, not auto-assigned, and must fit under "Maximum commission ' +
      'levels". Each level carries one commission term for the partner and one rebate term for ' +
      'the client, and either may be a percentage of broker revenue or a flat amount per ' +
      'standard lot. Two percentages on one level must total at most 100% — they are shares of ' +
      'the same revenue, so they add.',
  })
  @ApiOkResponse({ type: IbLevelDto })
  @NotClientScoped('Platform commission configuration; names no client and returns no client data.')
  @Audited('ib_level.create')
  create(@Req() req: Request & { admin: AuthenticatedAdmin }, @Body() dto: CreateIbLevelDto) {
    return this.levels.create(dto, req.admin);
  }

  @Patch(':level')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('ib.levels.edit')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Update a level',
    description:
      'Applies to the NEXT trade. Accruals record the rate AND the level they were calculated ' +
      'under, so nothing already earned is restated. The level NUMBER cannot be changed — a ' +
      'level is its number, and renumbering one would silently re-price every partner standing ' +
      'on it. Disabling one that partners stand on is refused: a disabled level stops paying, ' +
      'and their referral links would keep working while they earned nothing.',
  })
  @ApiOkResponse({ type: IbLevelDto })
  @NotClientScoped('Platform commission configuration; names no client and returns no client data.')
  @Audited('ib_level.update')
  update(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Param('level', ParseIntPipe) level: number,
    @Body() dto: UpdateIbLevelDto,
  ) {
    return this.levels.update(level, dto, req.admin);
  }

  @Delete(':level')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('ib.levels.delete')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Remove the deepest level',
    description:
      'Refuses one that partners stand on, refuses level 1 — every chain starts there, so ' +
      'deleting it stops the ladder paying rather than shortening it — and refuses one with ' +
      'deeper levels below it, because the ladder runs 1, 2, 3 … with no gaps.',
  })
  @NotClientScoped('Platform commission configuration; names no client and returns no client data.')
  @Audited('ib_level.delete')
  remove(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Param('level', ParseIntPipe) level: number,
  ) {
    return this.levels.remove(level, req.admin);
  }
}
