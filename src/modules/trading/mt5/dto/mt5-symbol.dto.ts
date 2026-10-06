import { ApiProperty } from '@nestjs/swagger';
import { NoClientFields } from '../../../../common/security/client-field.decorator';

/** One MT5 symbol and the folder MT5 files it under (0198). */
@NoClientFields('MT5 server configuration - a trading instrument, not a person')
export class Mt5SymbolDto {
  @ApiProperty({ example: 'BTCUSD' })
  symbol: string;

  @ApiProperty({
    example: 'Crypto\\BTCUSD',
    description: 'MT5’s own path, backslash-separated, ending in the symbol itself.',
  })
  path: string;

  @ApiProperty({ example: 'Bitcoin vs US Dollar' })
  description: string;
}

/** `GET /admin/mt5-symbols` — the mirrored list, dated. */
@NoClientFields('MT5 server configuration - a trading instrument, not a person')
export class Mt5SymbolListDto {
  @ApiProperty({ type: Mt5SymbolDto, isArray: true })
  symbols: Mt5SymbolDto[];

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When the server last confirmed the list. Null = never synced.',
  })
  lastSyncedAt: Date | null;
}
