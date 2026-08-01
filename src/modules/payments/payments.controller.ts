import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('payments')
@Controller({ path: 'payments', version: '1' })
export class PaymentsController {
  @Get('ping')
  @ApiOperation({ summary: 'Health ping for payments module' })
  ping() {
    return { module: 'payments', status: 'ready' };
  }
}
