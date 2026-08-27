import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { REVENUE_BASES, type RevenueBasis } from '../../../common/revenue-basis';

/** FR-IB-05's three modes: which legs a programme actually pays. */
export const IB_PROGRAM_MODES = ['commission_only', 'rebate_only', 'hybrid'] as const;
export type IbProgramMode = (typeof IB_PROGRAM_MODES)[number];

/**
 * A rate, as a decimal STRING (§6.1).
 *
 * Every one of these multiplies money, and a JSON number would round-trip
 * through a float on the way here — which is how a 33.3333% share becomes
 * 33.333299999999994 before anybody has done any arithmetic with it.
 *
 * Up to four decimals, matching NUMERIC(12,4): enough for 2.5% and 33.3333%
 * alike. Anything longer is refused rather than silently rounded, because a
 * rate an operator typed and a rate the system stored must be the same number.
 */
const RATE = /^\d{1,8}(\.\d{1,4})?$/;
const RATE_MESSAGE =
  'must be a non-negative decimal with at most four places, as a string — e.g. "12.5" or "33.3333"';

/**
 * The deepest depth a tier may name — the STRUCTURAL bound, not the policy one.
 *
 * Mirrors `ib_program_tiers_depth_range` and `ABSOLUTE_IB_MAX_LEVELS`: what the
 * column can hold. How many levels an operator may actually configure is
 * `IB_MAX_LEVELS`, which defaults to 2 (Feature List Rev 9, IB-17) and is
 * enforced by the service — a decorator cannot read a setting.
 *
 * Both exist on purpose. This one refuses a depth the engine could never pay;
 * that one refuses a ladder deeper than the broker agreed to.
 */
const MAX_TIER_DEPTH = 10;

/**
 * One rung of a programme's ladder: what its holder earns at a given DEPTH.
 *
 * `depth = 1` is the partner who introduced the trading client, `depth = 2` is
 * that partner's parent, upward from there. So this is a property of the TERMS
 * and is true wherever in a chain the holder happens to stand — which is what
 * the rung-keyed ladder this replaced could not express.
 */
export class IbProgramTierDto {
  @ApiProperty({
    example: 1,
    minimum: 1,
    maximum: MAX_TIER_DEPTH,
    description:
      'Hops above the trading client. 1 is the introducer, 2 is their parent. Levels must run ' +
      '1, 2, 3 … with no gaps.',
  })
  @IsInt()
  @Min(1)
  @Max(MAX_TIER_DEPTH)
  depth: number;

  @ApiProperty({
    type: 'string',
    example: '60.0000',
    description:
      'The holder’s share of the broker’s revenue at this depth, as a percentage. A decimal ' +
      'string, never a number (§6.1). Must be above zero — a level that pays nothing is removed ' +
      'rather than zeroed, because the number of levels is what decides how far a programme pays.',
  })
  @IsString()
  @Matches(RATE, { message: `rate ${RATE_MESSAGE}` })
  rate: string;
}

/**
 * A named IB programme — the terms a partner is paid on (FR-IB-06).
 *
 * ## The ladder is a LIST, and its length is load-bearing
 *
 * `tiers` replaced a fixed `level1Rate` / `level2Rate` pair, which wrote a
 * two-level ceiling into the contract itself. The number of tiers is how far
 * this programme's earnings reach: three tiers pays the holder on their own
 * clients, their sub-partners' and their sub-sub-partners', and stops.
 *
 * FR-IB-17 puts that decision here rather than in the engine — "the exact
 * per-level split is configured per the agreed program ladder".
 */
export class IbProgramDto {
  @ApiProperty({ format: 'uuid' }) id: string;

  @ApiProperty({
    example: 'Gold',
    description: 'What an operator picks, and what a partner is on.',
  })
  name: string;

  @ApiProperty({ example: 0, description: 'Lowest first. The first ENABLED one is the default.' })
  sortOrder: number;

  @ApiProperty({
    enum: IB_PROGRAM_MODES,
    description:
      'Which legs pay. `commission_only` pays the partner, `rebate_only` pays the trading ' +
      'client and no partner, `hybrid` pays both.',
  })
  mode: IbProgramMode;

  @ApiProperty({
    enum: REVENUE_BASES,
    description:
      'Which revenue this programme’s rates are a percentage OF (FR-IB-16). ' +
      '`commission_swap` is MT5’s charged commission plus swap and is what every deployment ' +
      'computes on. `spread` prices lots against the product’s spread markup. ' +
      '⚠️ Selecting `spread` before markups are populated pays nothing on every deal that ' +
      'follows, permanently — a zero-revenue deal is marked done, not retried.',
  })
  revenueBasis: RevenueBasis;

  @ApiProperty({
    type: [IbProgramTierDto],
    description:
      'What this programme pays at each depth, shallowest first. The COUNT is how many levels ' +
      'its holder’s earnings reach. Empty on a `rebate_only` programme, which pays no partner.',
  })
  tiers: IbProgramTierDto[];

  @ApiProperty({
    type: 'string',
    example: '0.0000',
    description:
      'What returns to the TRADING CLIENT, as a percentage of the same revenue. Paid only when ' +
      '`mode` is `rebate_only` or `hybrid`. On the programme rather than per depth because there ' +
      'is one trading client per trade, in one relationship — with their introducer.',
  })
  rebateRate: string;

  @ApiProperty({
    description: 'A disabled programme pays nothing and accepts no new partners.',
  })
  enabled: boolean;

  @ApiProperty({
    example: 3,
    description:
      'How many partners are currently on it. Present so a screen can refuse a delete before ' +
      'the database does, and say how many people it would have affected.',
  })
  partnerCount: number;

  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}

export class CreateIbProgramDto {
  @ApiProperty({ example: 'Gold' })
  @IsString()
  @Length(2, 80)
  name: string;

  @ApiPropertyOptional({ example: 10, description: 'Appended to the end when omitted.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @ApiPropertyOptional({ enum: IB_PROGRAM_MODES, default: 'commission_only' })
  @IsOptional()
  @IsIn(IB_PROGRAM_MODES)
  mode?: IbProgramMode;
  /**
   * FR-IB-16 (0106). Omitted means `commission_swap` on create and "leave it
   * alone" on update — the safe reading in both directions, because the other
   * two bases can only pay LESS on a platform whose markups are unset.
   */
  @ApiPropertyOptional({ enum: REVENUE_BASES, default: 'commission_swap' })
  @IsOptional()
  @IsIn(REVENUE_BASES)
  revenueBasis?: RevenueBasis;

  /**
   * `@ValidateNested({ each: true })` WITH `@Type`, and both are required.
   *
   * Without `@Type` the global `ValidationPipe`'s `transform` leaves these as
   * plain objects, class-validator finds no metadata to reflect on, and every
   * nested rule passes by never running — so `depth: "banana"` reaches the
   * service. This is the one validation failure that looks exactly like success.
   */
  @ApiPropertyOptional({
    type: [IbProgramTierDto],
    description: 'The ladder, 1..N with no gaps. Omit for a rebate-only programme.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_TIER_DEPTH)
  @ValidateNested({ each: true })
  @Type(() => IbProgramTierDto)
  tiers?: IbProgramTierDto[];

  @ApiPropertyOptional({ type: 'string', example: '0' })
  @IsOptional()
  @IsString()
  @Matches(RATE, { message: `rebateRate ${RATE_MESSAGE}` })
  rebateRate?: string;

  /*
   * No `default:` here — `openapi-typescript` emits any property carrying one as
   * REQUIRED, which is right for a response and wrong for a request body.
   * Defaults to true; see the service.
   */
  @ApiPropertyOptional({ description: 'Defaults to true.' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

/**
 * PATCH, so an operator changing one rate does not have to resend the others.
 *
 * `name` is editable and `id` is not: partners reference the id, so renaming is
 * an edit and re-identifying is a migration.
 */
export class UpdateIbProgramDto {
  @ApiPropertyOptional({ example: 'Gold' })
  @IsOptional()
  @IsString()
  @Length(2, 80)
  name?: string;

  @ApiPropertyOptional({ example: 10 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @ApiPropertyOptional({ enum: IB_PROGRAM_MODES })
  @IsOptional()
  @IsIn(IB_PROGRAM_MODES)
  mode?: IbProgramMode;
  /**
   * FR-IB-16 (0106). Omitted means `commission_swap` on create and "leave it
   * alone" on update — the safe reading in both directions, because the other
   * two bases can only pay LESS on a platform whose markups are unset.
   */
  /*
   * NO `default` HERE, unlike the create DTO above, and it is a correctness
   * fix rather than a codegen workaround: on a PATCH, omitting this LEAVES THE
   * STORED VALUE. Documenting a default of `commission_swap` would say that
   * omitting it RESETS a spread-priced programme to charges — the opposite of
   * what happens, and a re-pricing nobody asked for.
   *
   * It also stops `openapi-typescript` emitting the field as required, which a
   * property carrying a default is treated as.
   */
  @ApiPropertyOptional({ enum: REVENUE_BASES })
  @IsOptional()
  @IsIn(REVENUE_BASES)
  revenueBasis?: RevenueBasis;

  /**
   * ⚠️ REPLACE-ALL, not a merge — the one field on this PATCH that is not
   * "change just this".
   *
   * A ladder is read as a whole because its LENGTH decides how far the
   * programme pays. Merging would make "the ladder is now just level 1"
   * inexpressible, which is precisely the edit an operator shortening a
   * programme is trying to make. Send the ladder you want; omit the field to
   * leave it untouched.
   */
  @ApiPropertyOptional({
    type: [IbProgramTierDto],
    description:
      'REPLACES the whole ladder. Send every level you want to keep; omit the field to leave ' +
      'the existing ladder alone. An empty array removes every level.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_TIER_DEPTH)
  @ValidateNested({ each: true })
  @Type(() => IbProgramTierDto)
  tiers?: IbProgramTierDto[];

  @ApiPropertyOptional({ type: 'string', example: '0' })
  @IsOptional()
  @IsString()
  @Matches(RATE, { message: `rebateRate ${RATE_MESSAGE}` })
  rebateRate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

/**
 * The bounds a screen needs before it can offer the controls — `GET
 * /admin/ib-programs/limits`.
 *
 * ## Why this is an endpoint rather than a number in the frontend
 *
 * The ladder ceiling is `IB_MAX_LEVELS`, a deployment setting. A console that
 * hardcoded it would drift the moment a broker negotiated a third level: the
 * form would keep refusing at two while the API accepted three, and the
 * operator would be told "at most 2 levels" by a screen that was simply out of
 * date. That is precisely the console-versus-engine disagreement the setting
 * was introduced to end, so it is READ rather than assumed.
 *
 * Its own route rather than a field on every programme row: the ceiling is a
 * property of the platform, and hanging it off each item in a list would state
 * one fact N times and invite a reader to wonder which one won.
 */
export class IbProgramLimitsDto {
  @ApiProperty({
    example: 2,
    minimum: 1,
    maximum: MAX_TIER_DEPTH,
    description:
      'The most levels a programme may define, from `IB_MAX_LEVELS`. Defaults to 2 — the ' +
      'committed two-level structure (Feature List Rev 9, IB-17). Raising it is a commercial ' +
      'decision, not a deploy-time accident.',
  })
  maxLevels: number;
}
