import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('partners')
@Controller({ path: 'partners', version: '1' })
export class PartnersController {
  @Get('ping')
  @ApiOperation({ summary: 'Health ping for partners module' })
  ping() {
    return { module: 'partners', status: 'ready' };
  }
}
