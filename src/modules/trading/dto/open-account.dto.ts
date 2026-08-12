import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/**
 * A client opening their own trading account.
 *
 * The MT5 GROUP, the leverage and the currency are absent on purpose — those are
 * the broker's to decide, and a client picking a group would be choosing their
 * own commission plan out of a dropdown. See `SelfServiceGroups`.
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

  /**
   * A label for the account, shown in MT5 and in the portal.
   *
   * Optional: a client who does not care gets their own name, which is what MT5
   * expects and what an operator looking at the manager terminal can act on. It
   * matters once somebody holds several — "Swing" and "Scalping" beat two rows
   * reading the same thing.
   */
  @ApiPropertyOptional({
    maxLength: 64,
    example: 'Swing trading',
    description: "Defaults to the client's own name.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  name?: string;

  /**
   * Starting balance, DEMO ONLY.
   *
   * A demo account with no money cannot demonstrate anything, and making a
   * client ask an operator to fund practice money would be absurd. On a LIVE
   * account this is refused outright rather than ignored — quietly dropping a
   * number somebody typed into a funding box is the worst available behaviour.
   *
   * A decimal STRING, like every other amount that crosses this boundary: the
   * CRM stores money as strings and `Number('10000.5')` is where precision
   * starts to go.
   */
  @ApiPropertyOptional({
    example: '10000.00',
    description: 'Demo accounts only. Positive decimal string, capped by the API.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d+(\.\d{1,2})?$/, {
    message: 'startingBalance must be a positive decimal with up to 2 places',
  })
  startingBalance?: string;
}
