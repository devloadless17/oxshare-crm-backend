import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { NoClientFields } from '../../../common/security/client-field.decorator';
import { IsBoolean, IsInt, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';

/**
 * A SHARE, as a decimal STRING (§6.1).
 *
 * Every one of these multiplies money, and a JSON number would round-trip
 * through a float on the way here — which is how a 33.3333% share becomes
 * 33.333299999999994 before anybody has done any arithmetic with it.
 *
 * Up to four decimals, matching NUMERIC(12,4). The regex bounds the DIGITS;
 * the service and the CHECK bound the VALUE to 100.
 */
export const SHARE = /^\d{1,3}(\.\d{1,4})?$/;
export const SHARE_MESSAGE =
  'must be a percentage between 0 and 100 with at most four places, as a string — e.g. "70" or "33.3333"';

/**
 * The deepest rung a level may name — the STRUCTURAL bound, not the policy one.
 * Mirrors `ib_levels_level_range`: what the column can hold.
 */
const MAX_LEVEL = 10;

/**
 * One RUNG of the partner tree, and the terms of everybody standing on it.
 *
 * ## A rung, not a card, and a share, not an amount (0112, 0140)
 *
 * A level is keyed on the earner's POSITION in the tree: level 1 is a partner
 * dealing with the broker directly, and a partner they recruit is level 2. A
 * level 1 partner takes their level 1 share on everything that reaches them,
 * however deep.
 *
 * What a rung holds is a PERCENTAGE of the product's commission type — the
 * rate card carrying the money per lot. Until 0140 the amount itself sat here,
 * which meant one ladder could describe only one product. Now one ladder
 * prices the whole catalogue, and a product's terms are read off the type.
 *
 * ## Two shares on one row, of two different pools
 *
 * `commissionShare` is the PARTNER's cut of the type's `commissionPerLot`.
 * `rebateShare` is what the trading CLIENT gets of the type's `rebatePerLot`,
 * read from the introducer's rung only. A rung with a zero commission share
 * pays no partner; one with a zero rebate share returns nothing to the client.
 */
@NoClientFields(
  'commission terms for a RUNG - shares of the product type, not the partners standing on it',
)
export class IbLevelDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    example: 1,
    minimum: 1,
    maximum: MAX_LEVEL,
    description:
      'The rung. 1 is a partner dealing with the broker directly; a partner they recruit is 2. ' +
      'Unique — a level IS its number.',
  })
  level: number;

  @ApiProperty({ example: 'Main Partner' })
  name: string;

  @ApiProperty({
    type: 'string',
    nullable: true,
    description: 'What this tier is for, in the desk’s own words. Nothing computes with it.',
  })
  description: string | null;

  @ApiProperty({
    description:
      'A disabled rung pays nobody standing on it. Disabling is refused while partners are ' +
      'there — see the service.',
  })
  enabled: boolean;

  @ApiProperty({
    type: 'string',
    example: '70.0000',
    description:
      'The partner’s percentage of the product’s commission per lot. Paid on every trade that ' +
      'reaches this rung, independently of the shares on the rungs beneath it.',
  })
  commissionShare: string;

  @ApiProperty({
    type: 'string',
    example: '50.0000',
    description:
      'The client’s percentage of the product’s rebate per lot, read from the introducer’s rung.',
  })
  rebateShare: string;

  @ApiProperty({
    example: 4,
    description:
      'How many partners stand on this rung in the reader’s territory. Part of the row rather ' +
      'than a second call: with `partnersOutsideScope` it is what makes a delete refusable in ' +
      'the UI before the database refuses it, and what tells an operator how many people a rate ' +
      'change is about to affect.',
  })
  partnerCount: number;

  @ApiProperty({
    type: 'integer',
    example: 0,
    description:
      'How many partners stand on this rung OUTSIDE the reader’s territory — a count, never who ' +
      '(D-81 R2). Zero for a reader who sees every client. The rung is emptied only when both ' +
      'this and `partnerCount` are zero.',
  })
  partnersOutsideScope: number;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}

/** The bounds a rung must fit inside, read by the form rather than hardcoded. */
@NoClientFields(
  'commission terms for a RUNG - shares of the product type, not the partners standing on it',
)
export class IbLevelLimitsDto {
  @ApiProperty({
    example: 10,
    description:
      'How deep the ladder may run. Read by the form so it stops offering "add a level" at ' +
      'the right point — a hardcoded copy would drift the day the engine changes.',
  })
  maxLevels: number;

  @ApiProperty({
    example: 10,
    description: 'The structural ceiling the column itself can hold, whatever the setting says.',
  })
  absoluteMaxLevels: number;
}

export class CreateIbLevelDto {
  @ApiProperty({ example: 2, minimum: 1, maximum: MAX_LEVEL })
  @IsInt()
  @Min(1)
  @Max(MAX_LEVEL)
  level: number;

  @ApiProperty({ example: 'Sub Partner', minLength: 1, maxLength: 80 })
  @IsString()
  @Length(1, 80)
  name: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 })
  @IsOptional()
  @IsString()
  @Length(0, 2000)
  description?: string | null;

  @ApiPropertyOptional({ type: 'string', example: '30.0000', default: '0' })
  @IsOptional()
  @IsString()
  @Matches(SHARE, { message: `commissionShare ${SHARE_MESSAGE}` })
  commissionShare?: string;

  @ApiPropertyOptional({ type: 'string', example: '50.0000', default: '0' })
  @IsOptional()
  @IsString()
  @Matches(SHARE, { message: `rebateShare ${SHARE_MESSAGE}` })
  rebateShare?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

/**
 * A PATCH: omitted means leave it.
 *
 * `level` is absent on purpose — a rung IS its number, and renumbering one would
 * silently re-price every partner standing on it. Moving somebody between rungs
 * is a partner edit, not a level edit.
 */
export class UpdateIbLevelDto {
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
  @Matches(SHARE, { message: `commissionShare ${SHARE_MESSAGE}` })
  commissionShare?: string;

  @ApiPropertyOptional({ type: 'string' })
  @IsOptional()
  @IsString()
  @Matches(SHARE, { message: `rebateShare ${SHARE_MESSAGE}` })
  rebateShare?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
