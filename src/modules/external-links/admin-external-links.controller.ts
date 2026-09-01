import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
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
import { ExternalLinksService } from './external-links.service';
import {
  CreateExternalLinkDto,
  ExternalLinkDto,
  UpdateExternalLinkDto,
} from './dto/external-link.dto';

/**
 * The operator's control over what appears in the client portal's sidebar.
 *
 * ## Its OWN keys, like currencies and leverages
 *
 * `settings.edit` would have been the easy guard — it is what the platform
 * download links use — and it is the mistake those two catalogues each made and
 * then corrected: it is how "grant somebody the support email address" also
 * carried the power to delete a currency.
 *
 * The reason to spend a new key here is what the value DOES. A row on this table
 * puts a destination of the operator's choosing in front of every client on the
 * platform, in the chrome of a page they have signed in to. That is closer to
 * `platform_link.set` — which the audit catalogue already singles out as easy to
 * underrate — than it is to a support address, and it deserves a grant somebody
 * makes deliberately.
 *
 * The cost is the same one `leverages.*` records and is worth stating: these are
 * keys NO existing role holds, so this screen is invisible until somebody adds
 * them to a role. Migration 0110 grants them to `Administrator` and to the two
 * seeded accounts; every other role starts without, which is where a new power
 * should start.
 *
 * There is no separate "hide" key. Taking a link off the client menu is an EDIT
 * (`enabled: false`) and it is the action an operator almost always wants,
 * because it keeps the title, the description and the position for when the link
 * comes back.
 */
@ApiTags('admin/external-links')
@Controller('admin/external-links')
@UseGuards(PermissionsGuard)
@NotClientScoped('Portal chrome — a sidebar link is not a client record.')
export class AdminExternalLinksController {
  constructor(private readonly links: ExternalLinksService) {}

  @Get()
  @NotClientScoped('Portal chrome — a sidebar link is not a client record.')
  @RequirePermissions('externallinks.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Every link, operator order first',
    description:
      'Includes HIDDEN links, unlike `GET /external-links` — an operator has to see what they ' +
      'took down in order to put it back.',
  })
  @ApiOkResponse({ type: [ExternalLinkDto] })
  list() {
    return this.links.listAll();
  }

  @Post()
  @NotClientScoped('Portal chrome — a sidebar link is not a client record.')
  @RequirePermissions('externallinks.create')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Add a link',
    description:
      'Only http and https are accepted: this URL becomes an `href` in every client’s browser, ' +
      'and `javascript:` there would be stored XSS against all of them. Omitting `sortOrder` ' +
      'appends to the end of the menu.',
  })
  @ApiOkResponse({ type: ExternalLinkDto })
  @Audited('external_link.create')
  create(@Req() req: Request & { admin: AuthenticatedAdmin }, @Body() dto: CreateExternalLinkDto) {
    return this.links.create(dto, req.admin);
  }

  @Patch(':id')
  @NotClientScoped('Portal chrome — a sidebar link is not a client record.')
  @RequirePermissions('externallinks.edit')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Edit, reorder, or hide a link',
    description:
      'Only the fields sent are changed. `enabled: false` takes the link off the client menu and ' +
      'keeps everything about it, which is the ordinary way to withdraw one. An empty ' +
      '`description` clears it.',
  })
  @ApiOkResponse({ type: ExternalLinkDto })
  @Audited('external_link.update')
  update(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateExternalLinkDto,
  ) {
    return this.links.update(id, dto, req.admin);
  }

  @Delete(':id')
  @NotClientScoped('Portal chrome — a sidebar link is not a client record.')
  @RequirePermissions('externallinks.delete')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Remove a link for good',
    description:
      'Nothing references a link, so this orphans nothing — but the title, description and ' +
      'position go with it. To take one off the client menu and keep it, hide it instead. The ' +
      'remaining links close up the gap in the ordering.',
  })
  @Audited('external_link.delete')
  remove(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.links.remove(id, req.admin);
  }
}
