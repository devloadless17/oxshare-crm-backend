import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { NoClientFields } from '../../../common/security/client-field.decorator';
import { IsBoolean, IsInt, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';

/**
 * An amount per lot — money, so eight places (§6.1), as a decimal STRING.
 *
 * A JSON number would round-trip through a float between the form and the
 * column, and a "1.5" that arrives as 1.4999999999 is the kind of wrong that
 * survives review because it looks almost right. The regex bounds the digits;
 * `ib_commission_types_*_range` bounds the value.
 */
export const AMOUNT_PER_LOT = /^\d{1,8}(\.\d{1,8})?$/;
export const AMOUNT_PER_LOT_MESSAGE =
  'must be a non-negative decimal with at most eight places, as a string — e.g. "10" or "7.50000000"';

/**
 * A COMMISSION TYPE — the rate card a product is sold on (0140).
 *
 * Money per standard lot for the partners' commission and for the client's
 * rebate. Each rung of the ladder takes a percentage of these two figures, so
 * "which type is this product on" and "which rung is this partner on" together
 * decide every payout, and neither has to know about the other.
 */
@NoClientFields('a product rate card - amounts per lot, not a person')
export class IbCommissionTypeDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Standard terms' })
  name: string;

  @ApiProperty({ type: 'string', nullable: true })
  description: string | null;

  @ApiProperty({
    description:
      'A disabled type pays nobody on the products sold on it. Disabling is refused while ' +
      'products are assigned — move them first.',
  })
  enabled: boolean;

  @ApiProperty({
    type: 'string',
    example: '10.00000000',
    description:
      'Money per standard lot for the PARTNERS, before each level’s share. A decimal string.',
  })
  commissionPerLot: string;

  @ApiProperty({
    type: 'string',
    example: '3.00000000',
    description:
      'Money per standard lot returned to the trading CLIENT, before the introducer level’s ' +
      'share. A decimal string.',
  })
  rebatePerLot: string;

  @ApiProperty({ example: 0 })
  sortOrder: number;

  @ApiProperty({
    type: [String],
    description:
      'The products sold on this type, by name. Part of the row so a delete or a disable can ' +
      'be refused on the screen before the API refuses it.',
  })
  productNames: string[];

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}

export class CreateIbCommissionTypeDto {
  @ApiProperty({ example: 'Standard terms', minLength: 1, maxLength: 80 })
  @IsString()
  @Length(1, 80)
  name: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 })
  @IsOptional()
  @IsString()
  @Length(0, 2000)
  description?: string | null;

  @ApiProperty({ type: 'string', example: '10' })
  @IsString()
  @Matches(AMOUNT_PER_LOT, { message: `commissionPerLot ${AMOUNT_PER_LOT_MESSAGE}` })
  commissionPerLot: string;

  @ApiProperty({ type: 'string', example: '3' })
  @IsString()
  @Matches(AMOUNT_PER_LOT, { message: `rebatePerLot ${AMOUNT_PER_LOT_MESSAGE}` })
  rebatePerLot: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ example: 0, minimum: 0, maximum: 1000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  sortOrder?: number;
}

/** A PATCH: omitted means leave it. */
export class UpdateIbCommissionTypeDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 80 })
  @IsOptional()
  @IsString()
  @Length(1, 80)
  name?: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 })
  @IsOptional()
  @IsString()
  @Length(0, 2000)
  description?: string | null;

  @ApiPropertyOptional({ type: 'string' })
  @IsOptional()
  @IsString()
  @Matches(AMOUNT_PER_LOT, { message: `commissionPerLot ${AMOUNT_PER_LOT_MESSAGE}` })
  commissionPerLot?: string;

  @ApiPropertyOptional({ type: 'string' })
  @IsOptional()
  @IsString()
  @Matches(AMOUNT_PER_LOT, { message: `rebatePerLot ${AMOUNT_PER_LOT_MESSAGE}` })
  rebatePerLot?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ minimum: 0, maximum: 1000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  sortOrder?: number;
}
