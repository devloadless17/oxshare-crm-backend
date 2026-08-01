import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';

@ApiTags('wallet')
@Controller({ path: 'wallet', version: '1' })
export class WalletController {
  @Get('ping')
  @ApiOperation({ summary: 'Health ping for wallet module' })
  ping() {
    return { module: 'wallet', status: 'ready' };
  }
}
