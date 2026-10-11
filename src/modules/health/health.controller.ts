import { Controller, Get, HttpStatus, Req, Res } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { HealthService } from './health.service';
import { EdgeDto, LivenessDto, ReadinessDto } from './dto/health.dto';
import { clientIp } from '../../common/security/client-ip';
import { edgeFactsOf, proxyMarkersOf } from '../../common/security/edge-trust';

// PLATFORM-CONVENTIONS R-6.4. The `version: '1'` this controller used to declare
// was inert — main.ts calls neither setGlobalPrefix() nor enableVersioning() —
// and health should stay unversioned regardless: uptime checks and load-balancer
// probes must not have to track API versions.
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  @ApiOperation({
    summary: 'Liveness — is the process up? Checks no dependencies, by design.',
    description:
      'Dependency-free deliberately: restarting a healthy process because the database is briefly slow turns a blip into an outage. Use /health/ready to decide whether to send traffic.',
  })
  @ApiOkResponse({ type: LivenessDto })
  liveness(): LivenessDto {
    return this.health.liveness();
  }

  @Get('ready')
  @ApiOperation({
    summary: 'Readiness — can this instance actually serve? Probes every dependency.',
  })
  @ApiOkResponse({ type: ReadinessDto, description: 'Every required dependency is up.' })
  @ApiResponse({
    status: HttpStatus.SERVICE_UNAVAILABLE,
    type: ReadinessDto,
    description: 'At least one required dependency is down. Same body, 503 status.',
  })
  async readiness(@Res({ passthrough: true }) res: Response): Promise<ReadinessDto> {
    const report = await this.health.readiness();

    // passthrough + res.status rather than throwing ServiceUnavailableException:
    // the exception path runs through AllExceptionsFilter, which reshapes the
    // body into the standard error envelope and discards the per-dependency
    // detail — the only part of this response worth having during an incident.
    res.status(report.status === 'ready' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return report;
  }

  /*
   * "Who does the API think I am?" — the one question to ask after ANY change to
   * DNS, a CDN or a server. It answers the caller with their own address and
   * nothing about anyone else, so it needs no session. If `address` is not the
   * caller's public address, every per-address control is reading the wrong
   * thing (11 Oct 2026: it would have said Cloudflare's).
   */
  @Get('edge')
  @ApiOperation({
    summary: 'The address the API resolved for the caller, and how the request arrived.',
  })
  @ApiOkResponse({ type: EdgeDto })
  edge(@Req() req: Request, @Res({ passthrough: true }) res: Response): EdgeDto {
    res.setHeader('Cache-Control', 'no-store');
    const facts = edgeFactsOf(req, clientIp(req));
    return {
      address: facts.address,
      peerTrusted: facts.peerTrusted,
      forwardedChain: facts.forwardedChain,
      proxyHeaders: proxyMarkersOf(req, facts),
    };
  }
}
