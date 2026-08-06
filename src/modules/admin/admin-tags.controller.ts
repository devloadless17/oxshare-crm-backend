// Part of the `admin` controller surface, split by concern — see
// admin-clients.controller.ts for why several classes share one prefix.

import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { AdminTagsService } from './admin-tags.service';
import { CreateClientTagDto, UpdateClientTagDto } from './dto/requests/tags.dto';
import { ClientTagDto, ClientTagWithCountDto } from './dto/responses.dto';
import {
  PermissionsGuard,
  RequirePermissions,
  type AuthenticatedAdmin,
} from './guards/admin.guard';
import { UuidParam } from '../../common/query-params';
import { NotClientScoped, ScopedToClients } from './guards/client-scope.decorator';
import { Audited } from './guards/audited.decorator';

/** Client tags and their assignment — ADM-14. */
@ApiTags('admin')
@Controller('admin')
export class AdminTagsController {
  constructor(private readonly tags: AdminTagsService) {}

  @Get('tags')
  @UseGuards(PermissionsGuard)
  // OR semantics: anyone who can see the client list needs the vocabulary to
  // render its chips and its filter, so requiring `tags.view` alone would make
  // the tag column render as blank for most administrators.
  @RequirePermissions('tags.view', 'users.view')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Client tags, with how many clients carry each' })
  @ApiOkResponse({ type: [ClientTagWithCountDto] })
  @NotClientScoped('The tag VOCABULARY, not the clients carrying them.')
  list() {
    return this.tags.list();
  }

  @Post('tags')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('tags.manage')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Create a client tag' })
  @ApiOkResponse({ type: ClientTagDto })
  @NotClientScoped('Creates a tag; touches no client row.')
  @Audited('client_tag.create')
  create(@Body() dto: CreateClientTagDto, @Req() req: Request & { admin: AuthenticatedAdmin }) {
    return this.tags.create(dto, req.admin);
  }

  @Patch('tags/:id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('tags.manage')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Rename or restyle a client tag (the slug is fixed)' })
  @ApiOkResponse({ type: ClientTagDto })
  @NotClientScoped('Renames a tag; touches no client row.')
  @Audited('client_tag.update')
  update(
    @Param('id', UuidParam) id: string,
    @Body() dto: UpdateClientTagDto,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    return this.tags.update(id, dto, req.admin);
  }

  @Delete('tags/:id')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('tags.manage')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Delete a client tag and every assignment of it' })
  @NotClientScoped('Deletes a tag; refused while any admin is scoped to it.')
  @Audited('client_tag.delete')
  async remove(
    @Param('id', UuidParam) id: string,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    await this.tags.remove(id, req.admin);
    return { message: 'Tag deleted.' };
  }

  // ── Assignment ────────────────────────────────────────────────────────────
  //
  // Single-tag POST/DELETE rather than a PUT that replaces the whole set.
  //
  // A set-replace is last-writer-wins: two admins tagging the same client
  // seconds apart silently discard one another's work, and the composite
  // primary key cannot catch it because the second request is a legitimately
  // different write. Add and remove are idempotent by construction.

  @Get('clients/:id/tags')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('users.view')
  @ApiCookieAuth()
  @ApiOperation({ summary: "A client's tags" })
  @ApiOkResponse({ type: [ClientTagDto] })
  @ScopedToClients(
    'AdminTagsService.assertClientVisible → findForAdmin, so an out-of-scope client 404s.',
  )
  forClient(
    @Param('id', UuidParam) id: string,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    return this.tags.tagsForClient(id, req.admin);
  }

  @Post('clients/:id/tags/:tagId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('tags.assign')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Attach a tag to a client' })
  @ApiOkResponse({ type: [ClientTagDto] })
  @ScopedToClients(
    "AdminTagsService.assertClientVisible, plus the tag must be inside the acting admin's own scope.",
  )
  @Audited('client_tag.assign')
  assign(
    @Param('id', UuidParam) id: string,
    @Param('tagId', UuidParam) tagId: string,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    return this.tags.assign(id, tagId, req.admin);
  }

  @Delete('clients/:id/tags/:tagId')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('tags.assign')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Detach a tag from a client' })
  @ApiOkResponse({ type: [ClientTagDto] })
  @ScopedToClients(
    'assertClientVisible, plus a scoped admin may not remove the last tag keeping the client visible to them.',
  )
  @Audited('client_tag.unassign')
  unassign(
    @Param('id', UuidParam) id: string,
    @Param('tagId', UuidParam) tagId: string,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    return this.tags.unassign(id, tagId, req.admin);
  }
}
