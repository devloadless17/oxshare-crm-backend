import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { PlatformLinksService } from './platform-links.service';
import { PlatformLinkDto } from './dto/platform-link.dto';

/**
 * Where a client downloads the trading terminal.
 *
 * Behind `JwtAuthGuard` but NOT `EmailVerifiedGuard`, and the distinction is
 * deliberate. Downloading the terminal is something a client can reasonably do
 * while their KYC is still in review — the software is useless without a funded
 * account anyway, so gating the download buys nothing and delays the one part of
 * onboarding they could otherwise get on with.
 *
 * Authenticated at all because these links are operator property: build URLs,
 * partner-hosted binaries and TestFlight invitations are not things to publish
 * to anyone who finds the endpoint.
 */
@ApiTags('platforms')
@Controller('platforms')
export class PlatformsController {
  constructor(private readonly platforms: PlatformLinksService) {}

  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Download links for the trading terminal',
    description:
      'Always returns every platform the portal offers, in presentation order. A platform the ' +
      'operator has not configured has a null url — which the portal renders as "not available ' +
      'yet" rather than as a link that goes nowhere.',
  })
  @ApiOkResponse({ type: PlatformLinkDto, isArray: true })
  list() {
    return this.platforms.list();
  }
}
