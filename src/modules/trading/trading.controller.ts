import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('trading')
@Controller({ path: 'trading', version: '1' })
export class TradingController {
  @Get('ping')
  @ApiOperation({ summary: 'Health ping for trading module' })
  ping() {
    return { module: 'trading', status: 'ready' };
  }
}
