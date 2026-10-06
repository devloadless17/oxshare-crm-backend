import { Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { PermissionsGuard, RequirePermissions } from '../../admin/guards/admin.guard';
import { NotClientScoped } from '../../admin/guards/client-scope.decorator';
import { NotAudited } from '../../admin/guards/audited.decorator';
import { Mt5SymbolSyncService } from './mt5-symbol-sync.service';
import { Mt5SymbolListDto } from './dto/mt5-symbol.dto';

/**
 * MT5's symbols and their folders (0198) — what a commission type's
 * exclusions are chosen from.
 */
@ApiTags('admin')
@Controller('admin/mt5-symbols')
export class AdminMt5SymbolsController {
  constructor(private readonly symbols: Mt5SymbolSyncService) {}

  @Get()
  @UseGuards(PermissionsGuard)
  @RequirePermissions('ib.view')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'MT5 symbols with their folders, as last synced',
    description:
      'From the local mirror (`mt5_symbols`), so it renders when the server is unreachable. ' +
      'Symbols the server stopped reporting are left out.',
  })
  @ApiOkResponse({ type: Mt5SymbolListDto })
  @NotClientScoped('MT5 server configuration; names no client.')
  list() {
    return this.symbols.listForAdmin();
  }

  @Post('sync')
  @UseGuards(PermissionsGuard)
  @RequirePermissions('ib.commission_types.edit')
  @Throttle({ default: { ttl: 60_000, limit: 3 } })
  @HttpCode(HttpStatus.OK)
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Re-read the symbol list from MT5 now',
    description:
      'The same sync the scheduled MT5 job runs. Answers the refreshed list. Slow on a large ' +
      'server: the bridge reads one symbol per round trip, then caches the list.',
  })
  @ApiOkResponse({ type: Mt5SymbolListDto })
  @NotClientScoped('MT5 server configuration; names no client.')
  @NotAudited(
    'Copies what the MT5 server reports into a read-only mirror; it changes no configuration ' +
      'and no money, and the scheduled job does the same thing hourly.',
  )
  async sync() {
    await this.symbols.sync();
    return this.symbols.listForAdmin();
  }
}
