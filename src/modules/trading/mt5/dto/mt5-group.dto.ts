import { ApiProperty } from '@nestjs/swagger';
import { NoClientFields } from '../../../../common/security/client-field.decorator';

/** The product a group is sold under, when one claims it. */
@NoClientFields('MT5 server configuration - a group path and the product it is sold as')
export class Mt5GroupProductDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Standard' })
  name: string;

  @ApiProperty({
    enum: ['live', 'demo'],
    description: 'Which environment the product offers this group in.',
  })
  environment: 'live' | 'demo';
}

/**
 * One MT5 group as the sync job last saw it — `mt5_groups`, the local mirror of
 * the server's group list.
 *
 * Read from the MIRROR, never live from the bridge: this is a reference screen,
 * and a table that goes blank whenever the bridge is unreachable is worse than
 * one that says how recently each row was confirmed. `lastSeenAt` is that
 * statement.
 */
@NoClientFields('MT5 server configuration - a group path and the product it is sold as')
export class Mt5GroupDto {
  @ApiProperty({ example: 'real\\Standard-USD', description: 'The MT5 group path.' })
  name: string;

  @ApiProperty({ example: 'USD', description: 'The deposit currency the server reports.' })
  currency: string;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 100,
    description: 'The leverage the server assigns by default, when it reports one.',
  })
  leverageDefault: number | null;

  @ApiProperty({ description: 'When the sync job first saw this group on the server.' })
  firstSeenAt: Date;

  @ApiProperty({ description: 'The last sync that saw it on the server.' })
  lastSeenAt: Date;

  @ApiProperty({
    type: Date,
    nullable: true,
    description:
      'Set when the server stopped reporting the group. Kept, not deleted: accounts opened in it ' +
      'still exist, and a group that comes back is restored rather than duplicated.',
  })
  removedAt: Date | null;

  @ApiProperty({
    type: Mt5GroupProductDto,
    nullable: true,
    description:
      'The product that sells this group, or null when no product claims it — in which case no ' +
      'client can open an account in it from the portal.',
  })
  product: Mt5GroupProductDto | null;

  @ApiProperty({
    example: 12,
    description: 'How many trading accounts the CRM holds in this group.',
  })
  accountCount: number;
}
