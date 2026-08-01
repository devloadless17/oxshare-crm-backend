import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('compliance')
@Controller({ path: 'compliance', version: '1' })
export class ComplianceController {
  @Get('ping')
  @ApiOperation({ summary: 'Health ping for compliance module' })
  ping() {
    return { module: 'compliance', status: 'ready' };
  }
}
