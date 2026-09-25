import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * A client opening their own trading account.
 *
 * The group and the leverage ARE the client's to choose, from a list the broker
 * curates — an earlier version of this refused both on the grounds that picking
 * a group means picking your own commission plan. That is true of the whole
 * group tree and false of the two or three products a broker actually sells
 * online. `SelfServiceGroups` holds the offer and validates every choice against
 * it, which is the part that reasoning was protecting.
 *
 * The CURRENCY is still absent, and that one is not a policy: an MT5 group is
 * denominated in one currency, so choosing the product chooses the currency. A
 * separate field would imply the two vary independently.
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
   * The product the client chose — validated with the group against the offered
   * pairs in `SelfServiceGroups.resolve` (0142).
   */
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'The product the client chose, from GET /trading/accounts/self-service. A group may back ' +
      'several products (0142), so this identifies the offer — and the product decides the ' +
      'account’s commission type. Omitted, the first offered product carrying the group is used.',
  })
  @IsOptional()
  @IsUUID()
  productId?: string;

  /**
   * The account type, as an MT5 group path.
   *
   * VALIDATED against the list the broker offers for this environment — see
   * `SelfServiceGroups.resolve`. The portal's dropdown is a convenience; that
   * check is the control, because this field arrives from a browser and an
   * unchecked group would let a client open an institutional account.
   *
   * Omitted means the first offered type, which is the common case when a
   * broker sells exactly one.
   */
  @ApiPropertyOptional({ maxLength: 128, example: 'real\\Standard' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  group?: string;

  /**
   * Chosen from the offered ladder, not a free number.
   *
   * MT5 clamps to the group's own maximum regardless, so a free field would
   * show the client one figure and give them another.
   */
  @ApiPropertyOptional({ example: 100 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10_000)
  leverage?: number;

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
