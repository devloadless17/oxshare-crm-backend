import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('admin')
@Controller({ path: 'admin', version: '1' })
export class AdminController {
  @Get('ping')
  @ApiOperation({ summary: 'Health ping for admin module' })
  ping() {
    return { module: 'admin', status: 'ready' };
  }
}
