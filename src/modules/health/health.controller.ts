import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { HealthService } from './health.service';
import { LivenessDto, ReadinessDto } from './dto/health.dto';

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
}
