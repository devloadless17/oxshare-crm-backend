import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, Length, Min } from 'class-validator';

/**
 * A rung on the leverage ladder.
 *
 * `ratio` is the KEY: 500 means 500:1, and it is what MT5 is told, what a
 * client picks and what `trading_accounts.leverage` stores. A surrogate id
 * would leave the number that actually matters unconstrained, and nothing would
 * stop two rows both claiming 500.
 */
export class LeverageDto {
  @ApiProperty({ example: 500, description: '500 means 500:1.' }) ratio: number;
  @ApiProperty({
    type: 'string',
    nullable: true,
    description: 'What the client reads. Null renders as `1:<ratio>`.',
  })
  label: string | null;
  @ApiProperty({ description: 'A disabled rung is not offered. Accounts already on it are kept.' })
  enabled: boolean;
  @ApiProperty({ description: 'The operator’s order, which is the order a client sees.' })
  sortOrder: number;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}

export class CreateLeverageDto {
  @ApiProperty({ minimum: 1, example: 500, description: '500 means 500:1.' })
  @IsInt()
  @Min(1)
  ratio: number;

  @ApiPropertyOptional({ maxLength: 40, description: 'Omitted renders as `1:<ratio>`.' })
  @IsOptional()
  @IsString()
  @Length(0, 40)
  label?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ description: 'Omitted appends to the end of the ladder.' })
  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

/**
 * `ratio` is deliberately ABSENT.
 *
 * It is the primary key and the identity of the rung. Renumbering it is
 * deleting one leverage and creating another — and the accounts opened at the
 * old value would be left pointing at a ratio the ladder no longer explains.
 */
export class UpdateLeverageDto {
  @ApiPropertyOptional({ maxLength: 40 })
  @IsOptional()
  @IsString()
  @Length(0, 40)
  label?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  sortOrder?: number;
}
