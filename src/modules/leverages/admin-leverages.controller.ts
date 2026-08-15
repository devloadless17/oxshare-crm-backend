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
import type { Request } from 'express';
import {
  AuthenticatedAdmin,
  PermissionsGuard,
  RequirePermissions,
} from '../admin/guards/admin.guard';
import { NotClientScoped } from '../admin/guards/client-scope.decorator';
import { Audited } from '../admin/guards/audited.decorator';
import { LeveragesService } from './leverages.service';
import { CreateLeverageDto, LeverageDto, UpdateLeverageDto } from './dto/leverage.dto';

/**
 * The leverage ladder — the operator's control over what a client may open on.
 *
 * ## Its OWN keys, like currencies
 *
 * The ladder lived on Settings → Trading until migration 0067, so `settings.*`
 * was the obvious guard — and it is the same mistake currencies made and then
 * corrected: it is how "grant somebody the support email address" also carried
 * the power to delete a currency. Leverage is a RISK control and a regulatory
 * answer; it deserves a grant an operator makes deliberately.
 *
 * The cost is real and is worth stating: `leverages.*` is a key NO existing
 * role holds, so this screen is invisible until somebody adds it to a role.
 * That is a deliberate first step rather than a surprise — a new power should
 * start ungranted.
 *
 * There is no separate "withdraw" key. Taking a rung off the menu is
 * `enabled: false`, which is an EDIT, and it is the action an operator almost
 * always wants — deleting is refused while any account is trading at the ratio.
 */
@ApiTags('admin/leverages')
@Controller('admin/leverages')
@UseGuards(PermissionsGuard)
@NotClientScoped('Platform configuration — a ladder is not a client record.')
export class AdminLeveragesController {
  constructor(private readonly leverages: LeveragesService) {}

  @Get()
  @NotClientScoped('The leverage ladder is operator configuration; it contains no client data.')
  @RequirePermissions('leverages.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'The whole ladder, operator order first',
    description:
      'Includes DISABLED rungs, unlike `GET /leverages` — an operator has to see what they have ' +
      'withdrawn in order to put it back.',
  })
  @ApiOkResponse({ type: [LeverageDto] })
  list() {
    return this.leverages.listAll();
  }

  @Post()
  @NotClientScoped('The leverage ladder is operator configuration; it contains no client data.')
  @RequirePermissions('leverages.create')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Add a rung',
    description:
      'The ratio is the identity — 500 means 500:1 — so adding one that already exists is a ' +
      'conflict rather than an update.',
  })
  @ApiOkResponse({ type: LeverageDto })
  @Audited('leverage.create')
  create(@Req() req: Request & { admin: AuthenticatedAdmin }, @Body() dto: CreateLeverageDto) {
    return this.leverages.create(dto, req.admin);
  }

  @Patch(':ratio')
  @NotClientScoped('The leverage ladder is operator configuration; it contains no client data.')
  @RequirePermissions('leverages.edit')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Rename, reorder, or withdraw a rung',
    description:
      'The RATIO cannot be changed: it is the identity of the rung, and renumbering it would ' +
      'leave accounts opened at the old value pointing at a leverage the ladder no longer ' +
      'explains. Refuses to disable the last enabled rung — an empty ladder is an ' +
      'account-opening form with no options.',
  })
  @ApiOkResponse({ type: LeverageDto })
  @Audited('leverage.update')
  update(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Param('ratio', ParseIntPipe) ratio: number,
    @Body() dto: UpdateLeverageDto,
  ) {
    return this.leverages.update(ratio, dto, req.admin);
  }

  @Delete(':ratio')
  @NotClientScoped('The leverage ladder is operator configuration; it contains no client data.')
  @RequirePermissions('leverages.delete')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Remove a rung nobody is trading on',
    description:
      'Refused while any trading account is open at this leverage. Disable it instead — that ' +
      'takes it off the menu and leaves those accounts alone.',
  })
  @Audited('leverage.delete')
  remove(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Param('ratio', ParseIntPipe) ratio: number,
  ) {
    return this.leverages.remove(ratio, req.admin);
  }
}
