import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Min,
} from 'class-validator';

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
 * A named IB programme — the terms a partner is paid on (FR-IB-06).
 *
 * ## The two rates are per DEPTH, not per rung
 *
 * `level1Rate` is what the holder earns from their OWN clients; `level2Rate`
 * what they earn from a sub-partner's. Read either as "the rate for partners at
 * level N" and a sub-partner introducing their own client is paid the wrong one.
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
    type: 'string',
    example: '60.0000',
    description:
      'The holder’s share of the broker’s revenue on their OWN client’s closed trade, as a ' +
      'percentage. A decimal string, never a number (§6.1).',
  })
  level1Rate: string;

  @ApiProperty({
    type: 'string',
    example: '40.0000',
    description: 'Their share when the trade belongs to a SUB-partner’s client.',
  })
  level2Rate: string;

  @ApiProperty({
    type: 'string',
    example: '0.0000',
    description:
      'What returns to the TRADING CLIENT, as a percentage of the same revenue. Paid only when ' +
      '`mode` is `rebate_only` or `hybrid`.',
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

  @ApiPropertyOptional({ type: 'string', example: '60' })
  @IsOptional()
  @IsString()
  @Matches(RATE, { message: `level1Rate ${RATE_MESSAGE}` })
  level1Rate?: string;

  @ApiPropertyOptional({ type: 'string', example: '40' })
  @IsOptional()
  @IsString()
  @Matches(RATE, { message: `level2Rate ${RATE_MESSAGE}` })
  level2Rate?: string;

  @ApiPropertyOptional({ type: 'string', example: '0' })
  @IsOptional()
  @IsString()
  @Matches(RATE, { message: `rebateRate ${RATE_MESSAGE}` })
  rebateRate?: string;

  @ApiPropertyOptional({ default: true })
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

  @ApiPropertyOptional({ type: 'string', example: '60' })
  @IsOptional()
  @IsString()
  @Matches(RATE, { message: `level1Rate ${RATE_MESSAGE}` })
  level1Rate?: string;

  @ApiPropertyOptional({ type: 'string', example: '40' })
  @IsOptional()
  @IsString()
  @Matches(RATE, { message: `level2Rate ${RATE_MESSAGE}` })
  level2Rate?: string;

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
