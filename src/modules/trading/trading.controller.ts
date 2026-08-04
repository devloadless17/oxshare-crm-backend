import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('trading')
// The `version: '1'` argument this used to carry was inert — main.ts never
// called enableVersioning(). With setGlobalPrefix('v1') now in place it would be
// worse than inert: two version mechanisms declared, one of them fictional.
// R-2.1: do not leave both.
@Controller('trading')
export class TradingController {
  @Get('ping')
  @ApiOperation({ summary: 'Health ping for trading module' })
  ping() {
    return { module: 'trading', status: 'ready' };
  }
}
