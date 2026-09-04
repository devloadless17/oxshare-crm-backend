import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { REVENUE_BASES, type RevenueBasis } from '../../../common/revenue-basis';

/** How a leg is priced — a percentage of revenue, or money per standard lot. */
export const IB_PAYOUT_MODES = ['percent', 'per_lot'] as const;
export type IbPayoutMode = (typeof IB_PAYOUT_MODES)[number];

/**
 * A rate, as a decimal STRING (§6.1).
 *
 * Every one of these multiplies money, and a JSON number would round-trip
 * through a float on the way here — which is how a 33.3333% share becomes
 * 33.333299999999994 before anybody has done any arithmetic with it.
 *
 * Up to four decimals, matching NUMERIC(12,4).
 */
const RATE = /^\d{1,8}(\.\d{1,4})?$/;
const RATE_MESSAGE =
  'must be a non-negative decimal with at most four places, as a string — e.g. "12.5" or "33.3333"';

/**
 * An amount per lot — money, so eight places rather than the rate's four (§6.1).
 *
 * A separate constant rather than a looser shared one: a percentage with eight
 * decimals is a typo, and an amount rounded to four is a payout that disagrees
 * with the ledger it lands in.
 */
const AMOUNT = /^\d{1,8}(\.\d{1,8})?$/;
const AMOUNT_MESSAGE =
  'must be a non-negative decimal with at most eight places, as a string — e.g. "10" or "7.50000000"';

/**
 * The deepest rung a level may name — the STRUCTURAL bound, not the policy one.
 *
 * Mirrors `ib_levels_level_range`: what the column can hold. How deep an
 * operator may actually configure is `IB_MAX_LEVELS`, which defaults to 2
 * (Feature List Rev 9, IB-17) and is enforced by the service — a decorator
 * cannot read a setting.
 */
const MAX_LEVEL = 10;

/**
 * One RUNG of the partner tree, and the terms of everybody standing on it —
 * 0112.
 *
 * ## A rung, not a card
 *
 * This replaced the programme catalogue, and the difference is where terms
 * live. A programme was assigned to a partner and keyed its rates on DEPTH —
 * hops between the trading client and the earner — so the same partner was paid
 * differently on their own clients than on a sub-partner's, from one row.
 *
 * A level is keyed on the earner's POSITION in the tree instead. Level 1 is a
 * partner dealing with the broker directly; a partner they recruit is level 2.
 * The business asked for exactly this: a static per-lot figure for the main
 * partner, a percentage for the partner under them, and a sub-partner earning
 * NOTHING from their parent's clients while the parent still earns from clients
 * under the sub-partner. That asymmetry is a property of the tree, so it is
 * expressed by where somebody stands rather than by which card they hold.
 *
 * ## Two terms on one row
 *
 * `commission*` pays the PARTNER, `rebate*` pays the trading CLIENT, and each
 * has its own mode. The three programme "modes" (`commission_only`,
 * `rebate_only`, `hybrid`) are gone: they were a label describing which of two
 * numbers were set, and the numbers say that themselves. A rung with a zero
 * commission pays no partner; one with a zero rebate returns nothing to the
 * client; one with both pays both.
 */
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
    description:
      'A disabled rung pays nobody standing on it. Disabling is refused while partners are ' +
      'there — see the service.',
  })
  enabled: boolean;

  @ApiProperty({ enum: IB_PAYOUT_MODES, description: 'How the PARTNER’s leg is priced.' })
  commissionMode: IbPayoutMode;

  @ApiProperty({
    type: 'string',
    example: '30.0000',
    description: 'The partner’s share of broker revenue, as a percentage. Read in `percent` mode.',
  })
  commissionRate: string;

  @ApiProperty({
    type: 'string',
    nullable: true,
    example: '10.00000000',
    description: 'Money per standard lot. Set in `per_lot` mode, NULL in the other.',
  })
  commissionAmountPerLot: string | null;

  @ApiProperty({ enum: IB_PAYOUT_MODES, description: 'How the CLIENT’s rebate is priced.' })
  rebateMode: IbPayoutMode;

  @ApiProperty({ type: 'string', example: '0.0000' })
  rebateRate: string;

  @ApiProperty({ type: 'string', nullable: true, example: '2.00000000' })
  rebateAmountPerLot: string | null;

  @ApiProperty({
    enum: REVENUE_BASES,
    description:
      'WHICH revenue a percentage at this rung is a share of — FR-IB-16. Ignored entirely by a ' +
      'per-lot term, which is priced from volume and never from revenue.',
  })
  revenueBasis: RevenueBasis;

  @ApiProperty({
    example: 4,
    description:
      'How many partners stand on this rung. Part of the row rather than a second call: it is ' +
      'what makes a delete refusable in the UI before the database refuses it, and what tells ' +
      'an operator how many people a rate change is about to affect.',
  })
  partnerCount: number;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}

/** The bounds a rung must fit inside, read by the form rather than hardcoded. */
export class IbLevelLimitsDto {
  @ApiProperty({
    example: 2,
    description:
      'How deep the ladder may run, from `IB_MAX_LEVELS`. Read by the form so it stops offering ' +
      '"add a level" at the right point — a hardcoded copy would drift the day a broker ' +
      'negotiates a deeper structure.',
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

  @ApiPropertyOptional({ enum: IB_PAYOUT_MODES, default: 'percent' })
  @IsOptional()
  @IsIn(IB_PAYOUT_MODES)
  commissionMode?: IbPayoutMode;

  @ApiPropertyOptional({ type: 'string', example: '30.0000' })
  @IsOptional()
  @IsString()
  @Matches(RATE, { message: `commissionRate ${RATE_MESSAGE}` })
  commissionRate?: string;

  @ApiPropertyOptional({ type: 'string', example: '10.00000000' })
  @IsOptional()
  @IsString()
  @Matches(AMOUNT, { message: `commissionAmountPerLot ${AMOUNT_MESSAGE}` })
  commissionAmountPerLot?: string;

  @ApiPropertyOptional({ enum: IB_PAYOUT_MODES, default: 'percent' })
  @IsOptional()
  @IsIn(IB_PAYOUT_MODES)
  rebateMode?: IbPayoutMode;

  @ApiPropertyOptional({ type: 'string', example: '0.0000' })
  @IsOptional()
  @IsString()
  @Matches(RATE, { message: `rebateRate ${RATE_MESSAGE}` })
  rebateRate?: string;

  @ApiPropertyOptional({ type: 'string', example: '2.00000000' })
  @IsOptional()
  @IsString()
  @Matches(AMOUNT, { message: `rebateAmountPerLot ${AMOUNT_MESSAGE}` })
  rebateAmountPerLot?: string;

  @ApiPropertyOptional({ enum: REVENUE_BASES })
  @IsOptional()
  @IsIn(REVENUE_BASES)
  revenueBasis?: RevenueBasis;

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

  @ApiPropertyOptional({ enum: IB_PAYOUT_MODES })
  @IsOptional()
  @IsIn(IB_PAYOUT_MODES)
  commissionMode?: IbPayoutMode;

  @ApiPropertyOptional({ type: 'string' })
  @IsOptional()
  @IsString()
  @Matches(RATE, { message: `commissionRate ${RATE_MESSAGE}` })
  commissionRate?: string;

  @ApiPropertyOptional({ type: 'string' })
  @IsOptional()
  @IsString()
  @Matches(AMOUNT, { message: `commissionAmountPerLot ${AMOUNT_MESSAGE}` })
  commissionAmountPerLot?: string;

  @ApiPropertyOptional({ enum: IB_PAYOUT_MODES })
  @IsOptional()
  @IsIn(IB_PAYOUT_MODES)
  rebateMode?: IbPayoutMode;

  @ApiPropertyOptional({ type: 'string' })
  @IsOptional()
  @IsString()
  @Matches(RATE, { message: `rebateRate ${RATE_MESSAGE}` })
  rebateRate?: string;

  @ApiPropertyOptional({ type: 'string' })
  @IsOptional()
  @IsString()
  @Matches(AMOUNT, { message: `rebateAmountPerLot ${AMOUNT_MESSAGE}` })
  rebateAmountPerLot?: string;

  @ApiPropertyOptional({ enum: REVENUE_BASES })
  @IsOptional()
  @IsIn(REVENUE_BASES)
  revenueBasis?: RevenueBasis;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
