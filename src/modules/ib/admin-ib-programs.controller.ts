import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import {
  AuthenticatedAdmin,
  PermissionsGuard,
  RequirePermissions,
} from '../admin/guards/admin.guard';
import { NotClientScoped } from '../admin/guards/client-scope.decorator';
import { Audited } from '../admin/guards/audited.decorator';
import { IbProgramsService } from './ib-programs.service';
import {
  CreateIbProgramDto,
  IbProgramDto,
  IbProgramLimitsDto,
  UpdateIbProgramDto,
} from './dto/ib-program.dto';

/**
 * The commission programme catalogue — FR-ADM-10 ("commission plans CRUD"), and
 * the configuration surface behind FR-IB-05, FR-IB-06 and FR-IB-16.
 *
 * ## This is the ONLY catalogue of terms
 *
 * `admin/ib-levels` used to sit beside it, owning PLACEMENT — how deep the
 * chain ran, what each rung was called, whether new partners could be placed
 * there. Both halves live here now: a programme's tier ladder decides how far
 * its holder's earnings reach, and its rates decide what they are paid, so
 * there is no second screen that can disagree with this one. 0102 removed it;
 * whoever held `ib.levels.*` was granted `ib.programs.*` in its place.
 *
 * `ib.programs.*` stay separate from `ib.view` for the reason they always were:
 * an operator trusted to READ the catalogue is not automatically trusted to
 * change what every partner on it earns.
 *
 * ## `@NotClientScoped`, and why that is not an oversight
 *
 * Every admin route must declare a client-scope stance and
 * `client-scope-coverage.spec.ts` fails the build on one that declares neither.
 * This is platform configuration: it names no client, returns no client data,
 * and is identical for every admin who can see it.
 */
@ApiTags('admin')
@Controller('admin/ib-programs')
export class AdminIbProgramsController {
  constructor(private readonly programs: IbProgramsService) {}

  @Get()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('ib.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'The commission programmes, in ladder order',
    description:
      'Includes disabled ones — managing them is the point of the screen. Each row carries how ' +
      'many partners are on it, so a delete can be refused before the database refuses it and a ' +
      'rate change can say how many people it affects.',
  })
  @ApiOkResponse({ type: IbProgramDto, isArray: true })
  @NotClientScoped('Platform commission configuration; names no client and returns no client data.')
  list() {
    return this.programs.listAll();
  }

  /*
   * BEFORE `@Get(':id')` would be, if this controller had one — a literal
   * segment that a parameterised route could otherwise swallow. There is no
   * by-id route here today; the ordering is kept so adding one later cannot
   * quietly turn this into a lookup for a programme named "limits".
   */
  @Get('limits')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('ib.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'The bounds a programme must fit inside',
    description:
      'How many levels a ladder may reach, from `IB_MAX_LEVELS`. Read by the form so it stops ' +
      'offering "add a level" at the right point — a hardcoded copy would drift the day a ' +
      'broker negotiates a deeper structure.',
  })
  @ApiOkResponse({ type: IbProgramLimitsDto })
  @NotClientScoped('Platform commission configuration; names no client and returns no client data.')
  limits() {
    return this.programs.limits();
  }

  @Post()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('ib.programs.create')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Add a programme',
    description:
      'The ladder runs 1, 2, 3 … with no gaps, and its LENGTH is how many levels this ' +
      'programme’s earnings reach. Every leg is a share of the same revenue, so the levels plus ' +
      'the rebate must total at most 100% — the refusal names each number and the total. Terms ' +
      'that pay nobody are refused too: from the partner’s side they are indistinguishable from ' +
      'a broken engine.',
  })
  @ApiOkResponse({ type: IbProgramDto })
  @NotClientScoped('Platform commission configuration; names no client and returns no client data.')
  @Audited('ib_program.create')
  create(@Req() req: Request & { admin: AuthenticatedAdmin }, @Body() dto: CreateIbProgramDto) {
    return this.programs.create(dto, req.admin);
  }

  @Patch(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('ib.programs.edit')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Update a programme',
    description:
      'Applies to the NEXT trade. Accruals record the rate AND the programme they were ' +
      'calculated under, so nothing already earned is restated. `tiers` REPLACES the whole ' +
      'ladder — send every level you want to keep, or omit the field to leave it alone. ' +
      'Disabling one that partners are on is refused: a disabled programme stops paying, and ' +
      'their referral links would keep working while they earned nothing.',
  })
  @ApiOkResponse({ type: IbProgramDto })
  @NotClientScoped('Platform commission configuration; names no client and returns no client data.')
  @Audited('ib_program.update')
  update(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Param('id') id: string,
    @Body() dto: UpdateIbProgramDto,
  ) {
    return this.programs.update(id, dto, req.admin);
  }

  @Delete(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('ib.programs.delete')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Remove a programme',
    description:
      'Refuses one that partners are on, and refuses the last enabled one: approval places a new ' +
      'partner on the first enabled programme, so an empty catalogue turns every future approval ' +
      'into a refusal.',
  })
  @NotClientScoped('Platform commission configuration; names no client and returns no client data.')
  @Audited('ib_program.delete')
  remove(@Req() req: Request & { admin: AuthenticatedAdmin }, @Param('id') id: string) {
    return this.programs.remove(id, req.admin);
  }
}
