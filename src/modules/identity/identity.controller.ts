import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('identity')
@Controller({ path: 'identity', version: '1' })
export class IdentityController {
  @Get('ping')
  @ApiOperation({ summary: 'Health ping for identity module' })
  ping() {
    return { module: 'identity', status: 'ready' };
  }
}
