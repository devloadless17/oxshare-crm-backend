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

export const IB_PAYOUT_MODELS = ['revenue_share', 'per_lot'] as const;
export type IbPayoutModel = (typeof IB_PAYOUT_MODELS)[number];

/**
 * One rung of the payout ladder.
 *
 * `rateValue` crosses the wire as a STRING, like every other value that
 * multiplies money (§6.1). It is NUMERIC(12,4) in the database, and a JSON
 * number would round-trip through a float on the way here.
 *
 * Its UNIT depends on `payoutModel`: a percentage of the commission pool under
 * `revenue_share`, an amount per standard lot under `per_lot`. A client
 * rendering it must read the model — "70" means 70% in one and $70 in the
 * other, which is the kind of ambiguity a chart makes expensive.
 */
export class IbLevelDto {
  @ApiProperty({ example: 1, description: '1 is closest to the broker; higher sits further down.' })
  level: number;

  @ApiProperty({ example: 'Master Partner' })
  name: string;

  @ApiProperty({ enum: IB_PAYOUT_MODELS })
  payoutModel: IbPayoutModel;

  @ApiProperty({
    type: 'string',
    example: '70.0000',
    description:
      'A percentage of the pool under revenue_share, an amount per lot under per_lot. A decimal ' +
      'string, never a number (§6.1).',
  })
  rateValue: string;

  @ApiProperty({
    type: 'number',
    nullable: true,
    example: null,
    description: 'How many partners this level may recruit directly. Null means unlimited.',
  })
  maxDirectPartners: number | null;

  @ApiProperty({ description: 'A disabled level takes no share and accepts no new partners.' })
  enabled: boolean;

  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}

export class CreateIbLevelDto {
  /**
   * The level number, chosen by the operator rather than auto-assigned.
   *
   * Auto-incrementing would make "add a level" mean "append to the bottom",
   * which is right most of the time and impossible to undo when it is not.
   * Capped at 10 because a payout chain deeper than that is a pyramid, and the
   * resolver walks it per commission calculation.
   */
  @ApiProperty({ example: 3, minimum: 1, maximum: 10 })
  @IsInt()
  @Min(1)
  @Max(10)
  level: number;

  @ApiProperty({ example: 'Sub Partner' })
  @IsString()
  @Length(1, 80)
  name: string;

  @ApiPropertyOptional({ enum: IB_PAYOUT_MODELS, default: 'revenue_share' })
  @IsOptional()
  @IsIn(IB_PAYOUT_MODELS)
  payoutModel?: IbPayoutModel;

  /**
   * A decimal string with at most four places, matching NUMERIC(12,4).
   *
   * `@IsString` plus a pattern rather than `@IsNumber`: the moment this is
   * parsed as a number it has been through a float, which is the thing §6.1
   * exists to prevent. The service checks the RANGE, because what counts as
   * valid depends on `payoutModel` and a decorator cannot see it.
   */
  @ApiProperty({ type: 'string', example: '30.0000' })
  @IsString()
  @Matches(/^\d{1,8}(\.\d{1,4})?$/, {
    message: 'rateValue must be a decimal string with at most four decimal places, e.g. "30.0000"',
  })
  rateValue: string;

  @ApiPropertyOptional({
    type: 'number',
    nullable: true,
    description: 'Omit or send null for unlimited.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxDirectPartners?: number | null;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

/**
 * `level` is absent: it is the primary key and `ib_accounts.level` references
 * it, so renumbering is a data migration rather than an edit. Delete the level
 * and add it back if the ladder genuinely needs reshaping.
 */
export class UpdateIbLevelDto {
  @ApiPropertyOptional({ example: 'Sub Partner' })
  @IsOptional()
  @IsString()
  @Length(1, 80)
  name?: string;

  @ApiPropertyOptional({ enum: IB_PAYOUT_MODELS })
  @IsOptional()
  @IsIn(IB_PAYOUT_MODELS)
  payoutModel?: IbPayoutModel;

  @ApiPropertyOptional({ type: 'string', example: '30.0000' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{1,8}(\.\d{1,4})?$/, {
    message: 'rateValue must be a decimal string with at most four decimal places, e.g. "30.0000"',
  })
  rateValue?: string;

  @ApiPropertyOptional({ type: 'number', nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxDirectPartners?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
