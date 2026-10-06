import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { UuidParam } from '../../common/query-params';
import { SignupLinksService } from './signup-links.service';
import { RenameSignupLinkDto } from './dto/requests/signup-links.dto';
import { MySignupLinkDto, SignupLinkRowDto, SignupLinkUrlDto } from './dto/responses.dto';
import {
  AdminGuard,
  AnyAdmin,
  PermissionsGuard,
  RequirePermissions,
  type AuthenticatedAdmin,
} from './guards/admin.guard';
import { NotClientScoped } from './guards/client-scope.decorator';
import { Audited } from './guards/audited.decorator';

/**
 * Administrators' sign-up links (0198): one each, `/join/<slug>` on the portal.
 * A client who signs up through one gets that administrator's tags as they are
 * at that moment. Counts are aggregates — never who.
 */
@ApiTags('admin')
@Controller('admin')
export class SignupLinksController {
  constructor(private readonly links: SignupLinksService) {}

  @AnyAdmin('Your OWN sign-up link — the one you hand to the clients you bring.')
  @Get('signup-links/me')
  @UseGuards(AdminGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Your own sign-up link, the tags it gives, and what it has brought' })
  @ApiOkResponse({ type: MySignupLinkDto })
  @NotClientScoped('The caller’s own link and aggregate counts; no client is named.')
  mine(@Req() req: Request & { admin: AuthenticatedAdmin }) {
    return this.links.mine(req.admin);
  }

  @Get('signup-links')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('admins.view')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Every administrator’s sign-up link, with what it has brought' })
  @ApiOkResponse({ type: [SignupLinkRowDto] })
  @NotClientScoped('Links and aggregate counts per administrator; no client is named.')
  list(@Req() req: Request & { admin: AuthenticatedAdmin }) {
    return this.links.list(req.admin);
  }

  @AnyAdmin(
    'Renaming your OWN link needs no permission; another administrator’s needs admins.edit (checked in the service).',
  )
  @Patch('signup-links/:adminId')
  @UseGuards(AdminGuard)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Rename a sign-up link (your own, or anyone’s with admins.edit)' })
  @ApiOkResponse({ type: SignupLinkUrlDto })
  @NotClientScoped('Renames an administrator’s link; touches no client row.')
  @Audited('admin.signup_link_change')
  rename(
    @Param('adminId', UuidParam) adminId: string,
    @Body() dto: RenameSignupLinkDto,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    return this.links.rename(adminId, dto.slug, req.admin);
  }

  @AnyAdmin(
    'Your OWN link needs no permission; another administrator’s needs admins.edit (checked in the service).',
  )
  @Post('signup-links/:adminId/random')
  @HttpCode(200)
  @UseGuards(AdminGuard)
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Give a sign-up link a random word made by the server (the old word stops working)',
  })
  @ApiOkResponse({ type: SignupLinkUrlDto })
  @NotClientScoped('Changes an administrator’s link; touches no client row.')
  @Audited('admin.signup_link_change')
  randomize(
    @Param('adminId', UuidParam) adminId: string,
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ) {
    return this.links.randomize(adminId, req.admin);
  }
}
