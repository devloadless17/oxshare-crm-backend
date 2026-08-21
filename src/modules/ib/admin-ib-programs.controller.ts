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
import { CreateIbProgramDto, IbProgramDto, UpdateIbProgramDto } from './dto/ib-program.dto';

/**
 * The commission programme catalogue — FR-ADM-10 ("commission plans CRUD"), and
 * the configuration surface behind FR-IB-05, FR-IB-06 and FR-IB-16.
 *
 * ## Why this is a separate controller from the level ladder
 *
 * They answer different questions and are granted separately. `admin/ib-levels`
 * owns PLACEMENT — how deep the chain runs, what each rung is called, whether
 * new partners may be placed there. This owns TERMS — what a partner is paid,
 * what their client gets back, and which of those legs pay at all.
 *
 * An operator trusted to rename a rung is not automatically trusted to change
 * what every partner on it earns, which is why `ib.programs.*` are their own
 * permissions rather than a reuse of `ib.levels.*`.
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

  @Post()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('ib.programs.create')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Add a programme',
    description:
      'Every leg is a share of the same revenue, so level 1 + level 2 + the rebate must total at ' +
      'most 100% — the refusal names the three numbers and their total. Terms that pay nobody ' +
      'are refused too: they are indistinguishable from a broken engine from the partner’s side.',
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
      'Applies to the NEXT trade. Accruals record the rate they were calculated at, so nothing ' +
      'already earned is restated. Disabling one that partners are on is refused — a disabled ' +
      'programme stops paying, and their referral links would keep working while they earned ' +
      'nothing.',
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
