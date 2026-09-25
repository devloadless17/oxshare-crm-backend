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
 * One MT5 group the server currently reports, as the sync job mirrored it into
 * `mt5_groups`.
 *
 * Read from the MIRROR, never live from the bridge: this is a reference screen,
 * and a table that went blank whenever the bridge was unreachable would fail
 * exactly when an operator comes to look. Groups the server stopped reporting
 * are left out.
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

  @ApiProperty({
    type: [Mt5GroupProductDto],
    description:
      'Every product that sells this group, by name — several since 0142. Empty when no product ' +
      'does, in which case no client can open an account in it from the portal.',
  })
  products: Mt5GroupProductDto[];

  @ApiProperty({
    example: 12,
    description: 'How many trading accounts the CRM holds in this group.',
  })
  accountCount: number;
}
