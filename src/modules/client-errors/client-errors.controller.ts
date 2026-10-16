import { Body, Controller, HttpCode, HttpStatus, Logger, Post, Req } from '@nestjs/common';
import { ApiNoContentResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { NoCsrf } from '../../common/security/csrf.guard';
import { ClientErrorReportDto } from './dto/client-error-report.dto';
import { clientErrorLogLine } from './client-error-report';

/**
 * Crashes that happen INSIDE a browser, written to the API log.
 *
 * A client-side crash shows the generic error screen and leaves no trace on any
 * server: on 16 Oct 2026 a client's sign-up crashed and the only evidence was
 * their screenshot. The error screens of both frontends now send what they
 * caught here, and it becomes one `client.crash` warning in the log.
 *
 * Public because a crash happens signed out as often as signed in (sign-up,
 * login). It stores nothing and reads nothing, so it cannot leak; what it
 * protects against is noise: the Origin check still runs (only our frontends
 * can post), the body is capped field by field, and each address may send a
 * few a minute. Nothing that names a person is kept: the query string is
 * dropped, and emails and long digit runs are blanked from message and stack.
 */
@ApiTags('client-errors')
@Controller('client-errors')
export class ClientErrorsController {
  private readonly logger = new Logger('ClientCrash');

  @Post()
  @NoCsrf(
    'Logging only: it changes no state a forged request could abuse, and a crashed tab ' +
      'may hold no anti-forgery token. The Origin check still applies.',
  )
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Report a crash a frontend's error screen caught" })
  @ApiNoContentResponse()
  report(@Body() dto: ClientErrorReportDto, @Req() req: Request): void {
    this.logger.warn(clientErrorLogLine(dto, req.get('user-agent')));
  }
}
