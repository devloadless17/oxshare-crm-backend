import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { ExternalLinksService } from './external-links.service';
import { ClientExternalLinkDto } from './dto/external-link.dto';

/**
 * The links the portal draws in its sidebar.
 *
 * Behind `JwtAuthGuard` but NOT `EmailVerifiedGuard`, and both halves are
 * deliberate — the same call `PlatformsController` makes.
 *
 * Authenticated at all because these are operator property: a partner's private
 * resource page, an unlisted Telegram channel, a research feed the broker pays
 * for. None of that is a thing to publish to anyone who finds the endpoint.
 *
 * Not email-verified, because the sidebar is chrome. It renders on every page a
 * signed-in client can reach, including the ones they see while their address is
 * still unconfirmed, and a 403 there would either blank the menu or paint an
 * error over a screen that is otherwise working.
 *
 * The ADMIN half is `admin-external-links.controller.ts`, which is where every
 * write lives and where the `externallinks.*` keys are required.
 */
@ApiTags('external-links')
@Controller('external-links')
export class ExternalLinksController {
  constructor(private readonly links: ExternalLinksService) {}

  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'The links on this client’s sidebar, in the operator’s order',
    description:
      'Hidden links are ABSENT rather than flagged — a client has no use for one they cannot ' +
      'open, and a portal that received them would have to remember to filter. An empty array ' +
      'is an ordinary answer: it means the operator has added no links, and the sidebar simply ' +
      'shows no extra section.',
  })
  @ApiOkResponse({ type: ClientExternalLinkDto, isArray: true })
  list() {
    return this.links.listEnabled();
  }
}
