import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
} from 'class-validator';

/*
 * `IB_PAYOUT_MODELS` / `IbPayoutModel` are gone with migration 0055, which
 * dropped the `ib_payout_model` column and its enum type. A rate is a
 * percentage of the broker's revenue and nothing else, so there is no model to
 * name.
 */

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

  @ApiProperty({
    type: 'string',
    example: '70.0000',
    description:
      'The percentage of the broker’s revenue on a closed trade that this rung takes. A decimal ' +
      'string, never a number (§6.1).',
  })
  rateValue: string;

  @ApiProperty({ description: 'A disabled level takes no share and accepts no new partners.' })
  enabled: boolean;

  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}

export class CreateIbLevelDto {
  /**
   * The level number — OPTIONAL, and appended to the bottom when omitted.
   *
   * This used to be required, on the reasoning that auto-incrementing makes
   * "add a level" mean "append to the bottom", which is right most of the time
   * and impossible to undo when it is not.
   *
   * The console no longer asks. A ladder is read top-down and a rung's number is
   * its POSITION in that ladder, not a property an operator has an opinion
   * about — and the form made them supply one before they had named the thing.
   * Appending is what they meant every time; the field's real job was to let
   * them get it wrong.
   *
   * Still accepted, because it is the only way to fill a gap left by a delete,
   * and because removing it from the contract would break any caller that sends
   * it. Capped at 10: a payout chain deeper than that is a pyramid, and the
   * resolver walks it per commission calculation.
   */
  @ApiPropertyOptional({
    example: 3,
    minimum: 1,
    maximum: 10,
    description: 'Omit to append one below the deepest existing level.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  level?: number;

  @ApiProperty({ example: 'Sub Partner' })
  @IsString()
  @Length(1, 80)
  name: string;

  /**
   * A decimal string with at most four places, matching NUMERIC(12,4).
   *
   * `@IsString` plus a pattern rather than `@IsNumber`: the moment this is
   * parsed as a number it has been through a float, which is the thing §6.1
   * exists to prevent. The service checks the RANGE — a percentage above 100 is
   * a unit error — because a decorator cannot also see the other enabled levels
   * it has to fit beside.
   */
  @ApiProperty({ type: 'string', example: '30.0000' })
  @IsString()
  @Matches(/^\d{1,8}(\.\d{1,4})?$/, {
    message: 'rateValue must be a decimal string with at most four decimal places, e.g. "30.0000"',
  })
  rateValue: string;

  /*
   * No `default:` here either — `openapi-typescript` emits any property
   * carrying one as REQUIRED, which is right for a response and wrong for a
   * request body. Defaults to true; see the service.
   */
  @ApiPropertyOptional({ description: 'Defaults to true.' })
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

  @ApiPropertyOptional({ type: 'string', example: '30.0000' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{1,8}(\.\d{1,4})?$/, {
    message: 'rateValue must be a decimal string with at most four decimal places, e.g. "30.0000"',
  })
  rateValue?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

/**
 * The ladder's new order, top rung first.
 *
 * Every existing level, exactly once — a partial list is rejected rather than
 * interpreted, because "the ones I did not mention keep their numbers" has no
 * consistent answer when the mentioned ones take those numbers.
 *
 * These are the levels' CURRENT numbers. The service renumbers them to 1..n in
 * the sequence given, and remaps every partner in the same transaction.
 */
export class ReorderIbLevelsDto {
  @ApiProperty({
    type: [Number],
    example: [2, 1],
    description: 'Current level numbers, in the order they should now appear.',
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  @Min(1, { each: true })
  order: number[];
}
