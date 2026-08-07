import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { EmailVerifiedGuard } from '../identity/guards/email-verified.guard';
import { User } from '../../store/users.store';
import { IbApplicationsService } from './ib-applications.service';
import { IbOverviewService } from './ib-overview.service';
import { CreateIbApplicationDto, IbApplicationDto, IbStatusDto } from './dto/ib-application.dto';
import { IbOverviewDto } from './dto/ib-overview.dto';

/**
 * The client's own view of the partner programme.
 *
 * `EmailVerifiedGuard` alongside the auth guard, matching KYC: an unverified
 * address cannot receive the decision email, so an application from one is a
 * review whose outcome has nowhere to go.
 *
 * The KYC requirement is NOT a guard. It is a rule about eligibility that the
 * client should be told about before they fill anything in, so `GET /ib/status`
 * reports it as `eligible: false` with a sentence, and `POST /ib/apply`
 * enforces it. Explain first, refuse second — the same split used elsewhere.
 */
@ApiTags('ib')
@Controller('ib')
@UseGuards(JwtAuthGuard, EmailVerifiedGuard)
export class IbController {
  constructor(
    private readonly applications: IbApplicationsService,
    private readonly overview: IbOverviewService,
  ) {}

  @Get('status')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Where this client stands with the partner programme',
    description:
      'Returns the partner account if they have one AND their most recent application if they ' +
      'have made one. Both, because "never applied" and "rejected, here is why" are different ' +
      'states and a client shown a blank form after a refusal has been told nothing.',
  })
  @ApiOkResponse({ type: IbStatusDto })
  status(@Req() req: Request & { user: User }) {
    return this.applications.statusFor(req.user.id);
  }

  @Get('overview')
  @ApiCookieAuth()
  @ApiOperation({
    summary:
      "An approved partner's own dashboard — level, earnings, referred clients, sub-partners",
    description:
      'Everything the partner area renders, in one request, because these figures are read ' +
      'together and a count from one instant beside a total from another is a screen that ' +
      'contradicts itself.\n\n' +
      '404s for a client who is not a partner: zeroes across the board would render as a partner ' +
      'dashboard belonging to somebody who is not one. Call GET /ib/status first.\n\n' +
      'IMPORTANT — `earnings.engineLive` is FALSE today. The commission engine was removed in ' +
      'migration 0028 and nothing writes commission entries yet, so the totals are true reads of ' +
      'an empty ledger rather than computed results. A client MUST label them as such instead of ' +
      'presenting a calculated-looking zero.',
  })
  @ApiOkResponse({ type: IbOverviewDto })
  overviewForMe(@Req() req: Request & { user: User }) {
    return this.overview.overviewFor(req.user.id);
  }

  @Post('apply')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Apply to become a partner',
    description:
      'Requires a verified identity (KYC level 1). Refuses a second application while one is ' +
      'still awaiting review, and refuses outright if the client is already a partner.',
  })
  @ApiOkResponse({ type: IbApplicationDto })
  apply(@Req() req: Request & { user: User }, @Body() dto: CreateIbApplicationDto) {
    return this.applications.apply(req.user.id, dto);
  }
}
