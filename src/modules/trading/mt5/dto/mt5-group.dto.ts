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

/** One tier of an MT5 group commission rule. Amounts are decimal strings. */
@NoClientFields('MT5 server configuration - a group commission rule')
export class Mt5GroupCommissionTierDto {
  @ApiProperty({
    enum: [
      'deposit_currency',
      'specified_currency',
      'base_currency',
      'profit_currency',
      'margin_currency',
      'points',
      'percent',
      'unknown',
    ],
    description:
      'The unit of `value`: the group deposit currency, the currency in `currency`, a symbol ' +
      'currency, points, or a percentage of turnover.',
  })
  mode: string;

  @ApiProperty({ enum: ['per_lot', 'per_deal', 'unknown'] })
  type: string;

  @ApiProperty({ example: '3.00000000' })
  value: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Only set for "specified_currency".',
  })
  currency: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The smallest charge. MT5 uses zero for "no minimum".',
  })
  minimal: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The largest charge. MT5 uses zero for "no maximum".',
  })
  maximal: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Where the tier band starts.' })
  rangeFrom: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Where the tier band ends; null when it is open-ended.',
  })
  rangeTo: string | null;
}

/**
 * One commission rule MT5 applies to a group's deals, as the bridge reported
 * it at the last group sync. Set by the broker in MT5, not in the CRM.
 */
@NoClientFields('MT5 server configuration - a group commission rule')
export class Mt5GroupCommissionDto {
  @ApiProperty({ example: 'Standard commission' })
  name: string;

  @ApiProperty({ example: '' })
  description: string;

  @ApiProperty({
    example: 'Forex\\*',
    description: 'The symbols it applies to, as an MT5 path mask.',
  })
  symbolPath: string;

  @ApiProperty({
    enum: ['standard', 'agent', 'unknown'],
    description: '"standard" is charged to the client; "agent" is paid to an agent account.',
  })
  mode: string;

  @ApiProperty({ enum: ['volume', 'turnover_money', 'turnover_volume', 'unknown'] })
  rangeMode: string;

  @ApiProperty({
    enum: ['instant', 'daily', 'monthly', 'unknown'],
    description: 'When MT5 takes it: with the deal, or at the end of the day or month.',
  })
  chargeMode: string;

  @ApiProperty({
    enum: ['all', 'in', 'out', 'unknown'],
    description: 'Which deals pay it: every deal, opening deals or closing deals.',
  })
  entryMode: string;

  @ApiProperty({ type: [Mt5GroupCommissionTierDto] })
  tiers: Mt5GroupCommissionTierDto[];
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
    type: [Mt5GroupCommissionDto],
    nullable: true,
    description:
      "MT5's own commission rules on this group — what the trading server takes from a " +
      "client's deals, set by the broker in MT5 and separate from the partner commission " +
      'types. Empty when the group charges none; null when the bridge has not reported them.',
  })
  commissions: Mt5GroupCommissionDto[] | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '100.00000000',
    description: 'The margin-call level, in the unit marginStopOutMode names.',
  })
  marginCall: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '50.00000000',
    description: 'The stop-out level, in the unit marginStopOutMode names.',
  })
  marginStopOut: string | null;

  @ApiProperty({
    type: String,
    enum: ['percent', 'money'],
    nullable: true,
    description: '"percent" is a margin level; "money" is an equity in the group currency.',
  })
  marginStopOutMode: string | null;

  @ApiProperty({
    type: [Mt5GroupProductDto],
    description:
      'Every product that sells this group, by name — several since 0142. Empty when no product ' +
      'does, in which case no client can open an account in it from the portal.',
  })
  products: Mt5GroupProductDto[];

  @ApiProperty({
    example: 12,
    description:
      'How many trading accounts the CRM holds in this group, in the reader’s territory.',
  })
  accountCount: number;

  @ApiProperty({
    type: 'integer',
    example: 0,
    description:
      'How many it holds OUTSIDE the reader’s territory — a count, never who (D-81 R2). Zero ' +
      'for a reader who sees every client.',
  })
  accountsOutsideScope: number;
}
