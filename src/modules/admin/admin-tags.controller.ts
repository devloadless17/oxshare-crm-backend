import { Throttle } from '@nestjs/throttler';
// Part of the `admin` controller surface, split by concern — see
// admin-clients.controller.ts for why several classes share one prefix.

import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import {
  exportFormat,
  streamCsvFromArray,
  EXPORT_RATE_LIMIT,
} from '../../common/export/export-response';
import { NotAudited } from './guards/audited.decorator';
import { AdminTagsService } from './admin-tags.service';
import { CreateClientTagDto, UpdateClientTagDto } from './dto/requests/tags.dto';
import { ClientTagAssignmentDto, ClientTagDto, ClientTagWithCountDto } from './dto/responses.dto';
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
  @RequirePermissions('tags.view', 'clients.view')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Client tags, with how many clients carry each' })
  @ApiOkResponse({ type: [ClientTagWithCountDto] })
  @NotClientScoped('The tag VOCABULARY, not the clients carrying them.')
  list(@Req() req: Request & { admin: AuthenticatedAdmin }) {
    return this.tags.list(req.admin);
  }

  /**
   * The tag vocabulary as CSV, with how many clients carry each.
   *
   * ── `@NotClientScoped`, and why the COUNT does not change that ────────────
   *
   * The rows are tags, not clients: no client is named and no client-owned row
   * is returned. `clientCount` is an aggregate over the whole client base
   * rather than over the caller's territory, exactly as `GET /admin/tags`
   * already reports it — a scoped admin reading "412" learns how many clients
   * carry the tag platform-wide, which is a property of the tag and not a way
   * to reach anybody's record.
   */
  @Get('tags/export')
  /*
   * A ceiling on a STREAMING read of the whole client base.
   *
   * Every export here is batched over the full filtered set and held open for
   * the length of the download, and none carried anything but the global
   * 120/min — which is sized for a person clicking around a console, not for
   * 120 concurrent full-table CSV streams. The limit is per route per IP, so a
   * desk exporting clients and then withdrawals is unaffected; what it bounds is
   * one caller pulling the same export in a loop.
   *
   * Six a minute: far above any human use of an Export button, far below what
   * it takes to hurt the database.
   */
  @Throttle({ default: { ttl: 60_000, limit: EXPORT_RATE_LIMIT } })
  @UseGuards(PermissionsGuard)
  // OR semantics, matching the list: anyone who can see the client index needs
  // the tag vocabulary to make sense of its chips and its filter.
  @RequirePermissions('tags.view', 'clients.view')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Export the client tag vocabulary as CSV' })
  @ApiOkResponse({
    description: 'A CSV file, named `tags-<YYYY-MM-DD>.csv`.',
    content: { 'text/csv': { schema: { type: 'string', format: 'binary' } } },
  })
  @ApiQuery({ name: 'format', required: false, enum: ['csv'] })
  @NotClientScoped(
    'The tag VOCABULARY, not the clients carrying them — the same stance the list takes.',
  )
  @NotAudited(
    'A vocabulary of operator-defined labels containing no client data. The exports worth attributing are the ones carrying PII or money.',
  )
  async exportTags(
    @Res() res: Response,
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Query('format') format?: string,
  ) {
    const chosen = exportFormat(format);
    await streamCsvFromArray(res, 'tags', chosen, TAG_EXPORT_COLUMNS, async () =>
      this.tags.list(req.admin),
    );
  }

  @Post('tags')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('tags.create')
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
  @RequirePermissions('tags.edit')
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
  @RequirePermissions('tags.delete')
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
  @RequirePermissions('clients.view')
  @ApiCookieAuth()
  @ApiOperation({ summary: "A client's tags" })
  @ApiOkResponse({ type: [ClientTagAssignmentDto] })
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
  @RequirePermissions('clients.tag')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Attach a tag to a client' })
  @ApiOkResponse({ type: [ClientTagAssignmentDto] })
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
  @RequirePermissions('clients.tag')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Detach a tag from a client' })
  @ApiOkResponse({ type: [ClientTagAssignmentDto] })
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

const TAG_EXPORT_COLUMNS = [
  { header: 'Tag ID', value: (r: TagExportRow) => r.id },
  { header: 'Slug', value: (r: TagExportRow) => r.slug },
  { header: 'Label', value: (r: TagExportRow) => r.label },
  { header: 'Description', value: (r: TagExportRow) => r.description },
  { header: 'Colour', value: (r: TagExportRow) => r.color },
  // A genuine integer count, not a monetary value.
  { header: 'Clients carrying it', value: (r: TagExportRow) => r.clientCount },
  { header: 'Created at', value: (r: TagExportRow) => r.createdAt },
] as const;

interface TagExportRow {
  id: string;
  slug: string;
  label: string;
  description?: string;
  color?: string;
  clientCount: number;
  createdAt: Date;
}
