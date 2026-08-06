import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { EmailVerifiedGuard } from '../identity/guards/email-verified.guard';
import { User } from '../../store/users.store';
import { IbApplicationsService } from './ib-applications.service';
import { CreateIbApplicationDto, IbApplicationDto, IbStatusDto } from './dto/ib-application.dto';

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
  constructor(private readonly applications: IbApplicationsService) {}

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
