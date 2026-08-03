import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsNumberString, IsOptional, IsString, Min } from 'class-validator';

// Request DTOs for the withdrawal lifecycle and IB commission programs.
// See the note in ./auth.dto.ts for why these moved out of the controller.
//
// ARCHITECTURE §6.1 is the reason every monetary and percentage field below is
// `@IsNumberString()` and documented as `type: 'string'`. A JS number cannot hold
// NUMERIC(28,8) — `Number('12345678901234567.89')` is already wrong. The example
// values carry the stored 8dp scale so a consumer of the generated types sees
// the real shape rather than guessing at "12.5".

const PROGRAM_MODES = ['commission', 'rebate', 'hybrid'] as const;
const PROGRAM_METHODS = ['spread_share', 'per_lot', 'fixed_per_deal'] as const;

export class WithdrawalRejectDto {
  @ApiPropertyOptional({ description: 'Free-text reason, when not using a configured reasonId.' })
  @IsString()
  @IsOptional()
  reason?: string;

  @ApiPropertyOptional({ description: 'Id of a configured rejection reason.' })
  @IsString()
  @IsOptional()
  reasonId?: string;
}

export class SettleWithdrawalDto {
  /**
   * The payment provider's own reference. Backs `UNIQUE(provider, provider_ref)`,
   * which is what makes settlement idempotent in the database rather than by a
   * check-then-insert (§6.3) — so a retried settle cannot pay twice.
   */
  @ApiProperty({ example: 'wise-tx-9f3a1c' })
  @IsString()
  providerRef: string;
}

export class ProgramDto {
  @ApiProperty({ example: 'Standard IB' })
  @IsString()
  name: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ description: 'Display order in the plan list.' })
  @IsInt()
  @IsOptional()
  position?: number;

  @ApiProperty({ enum: PROGRAM_MODES })
  @IsIn(PROGRAM_MODES)
  mode: (typeof PROGRAM_MODES)[number];

  @ApiProperty({ enum: PROGRAM_METHODS })
  @IsIn(PROGRAM_METHODS)
  method: (typeof PROGRAM_METHODS)[number];

  @ApiProperty({
    type: 'string',
    example: '12.50000000',
    description: 'Money/percent as a decimal string (§6.1) — never a number.',
  })
  @IsNumberString()
  commissionValue: string;

  @ApiPropertyOptional({ type: 'string', example: '2.00000000' })
  @IsNumberString()
  @IsOptional()
  rebateValue?: string;

  @ApiProperty({
    type: 'string',
    example: '70.00000000',
    description: 'Level-1 IB share, percent as a decimal string.',
  })
  @IsNumberString()
  l1Share: string;

  @ApiProperty({
    type: 'string',
    example: '30.00000000',
    description: 'Level-2 IB share. Resolution stops at L2 — there is no L3.',
  })
  @IsNumberString()
  l2Share: string;

  @ApiPropertyOptional({
    description: 'Hours an accrual is held before it can be confirmed.',
    minimum: 0,
  })
  @IsInt()
  @Min(0)
  @IsOptional()
  settlementWindowHours?: number;

  @ApiPropertyOptional({ description: 'Pay the rebate on position close rather than on open.' })
  @IsBoolean()
  @IsOptional()
  rebateOnClose?: boolean;

  @ApiPropertyOptional({ description: 'Offer this plan to IBs for self-selection.' })
  @IsBoolean()
  @IsOptional()
  selectable?: boolean;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  active?: boolean;
}

export class ProgramActiveDto {
  @ApiProperty()
  @IsBoolean()
  active: boolean;
}
