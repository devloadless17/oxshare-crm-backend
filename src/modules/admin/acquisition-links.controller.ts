import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { UuidParam } from '../../common/query-params';
import { AcquisitionLinksService } from './acquisition-links.service';
import {
  CreateAcquisitionLinkDto,
  UpdateAcquisitionLinkDto,
} from './dto/requests/acquisition-links.dto';
import { AcquisitionLinkDto } from './dto/responses.dto';
import {
  PermissionsGuard,
  RequirePermissions,
  type AuthenticatedAdmin,
} from './guards/admin.guard';
import { NotClientScoped } from './guards/client-scope.decorator';
import { Audited } from './guards/audited.decorator';

/**
 * Administrators' sign-up links (0195): `/join/<code>` on the portal. A client
 * who signs up through one arrives carrying its tags — in its owner's book.
 *
 * Counts per link are aggregates (sign-ups, verified, funded), never who:
 * the owner's ruling of 28 Sep 2026, "a count, no identity".
 */
@ApiTags('admin')
@Controller('admin')
export class AcquisitionLinksController {
  constructor(private readonly links: AcquisitionLinksService) {}

  @Get('acquisition-links')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('links.view')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Sign-up links, with what each has brought (counts only)' })
  @ApiOkResponse({ type: [AcquisitionLinkDto] })
  @NotClientScoped('Links and aggregate counts; no client is named.')
  list() {
    return this.links.list();
  }

  @Post('acquisition-links')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('links.create', 'links.manage')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Create a sign-up link' })
  @ApiOkResponse({ type: AcquisitionLinkDto })
  @NotClientScoped('Creates a link; touches no client row.')
  @Audited('acquisition_link.create')
  create(
    @Body() dto: CreateAcquisitionLinkDto,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    return this.links.create(dto, req.admin);
  }

  @Patch('acquisition-links/:id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('links.create', 'links.manage')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Rename, re-tag, hand over, or switch a sign-up link off/on' })
  @ApiOkResponse({ type: AcquisitionLinkDto })
  @NotClientScoped('Edits a link; clients already signed up keep their tags.')
  @Audited('acquisition_link.update')
  update(
    @Param('id', UuidParam) id: string,
    @Body() dto: UpdateAcquisitionLinkDto,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    return this.links.update(id, dto, req.admin);
  }
}
