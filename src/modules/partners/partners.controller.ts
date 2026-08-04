import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('partners')
// The `version: '1'` argument this used to carry was inert — main.ts never
// called enableVersioning(). With setGlobalPrefix('v1') now in place it would be
// worse than inert: two version mechanisms declared, one of them fictional.
// R-2.1: do not leave both.
@Controller('partners')
export class PartnersController {
  @Get('ping')
  @ApiOperation({ summary: 'Health ping for partners module' })
  ping() {
    return { module: 'partners', status: 'ready' };
  }
}
