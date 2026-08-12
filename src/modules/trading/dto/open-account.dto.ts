import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

/**
 * A client opening their own trading account.
 *
 * ONE field, and that is the design. The MT5 group, the leverage and the
 * currency are all the broker's to decide — see `SelfServiceGroups` for why a
 * client picking a group would be choosing their own commission plan out of a
 * dropdown.
 */
export class OpenOwnAccountDto {
  @ApiProperty({
    enum: ['live', 'demo'],
    description:
      'live requires a verified identity and holds real money; demo is practice money and needs ' +
      'no verification.',
  })
  @IsIn(['live', 'demo'])
  environment: 'live' | 'demo';
}
