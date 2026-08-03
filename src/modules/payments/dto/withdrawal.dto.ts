import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsNumberString, IsString } from 'class-validator';

// Request + response DTOs for the client-facing payments surface.
// Moved out of payments.controller.ts so the shapes reach /api/docs-json and the
// portal can generate types instead of hand-writing them.

const CURRENCIES = ['USD', 'USDT'] as const;
const PROVIDERS = ['whish', 'usdt'] as const;
const DIRECTIONS = ['deposit', 'withdrawal'] as const;
const STATES = ['pending', 'approved', 'rejected', 'success', 'failed'] as const;

export class RequestWithdrawalDto {
  /**
   * Money arrives as a STRING and stays one (§6.1) — `@IsNumberString`, never
   * `@IsNumber`, so it is never parsed into a float on the way in.
   */
  @ApiProperty({ type: 'string', example: '300.00000000' })
  @IsNumberString()
  amount: string;

  @ApiProperty({ enum: CURRENCIES })
  @IsIn(CURRENCIES)
  currency: (typeof CURRENCIES)[number];

  @ApiProperty({ description: 'Payout target, e.g. an IBAN or a USDT address.' })
  @IsString()
  @IsNotEmpty()
  destination: string;

  @ApiProperty({ enum: PROVIDERS })
  @IsIn(PROVIDERS)
  provider: (typeof PROVIDERS)[number];
}

export class TransactionDto {
  @ApiProperty() id: string;
  @ApiProperty() userId: string;
  @ApiProperty() walletId: string;
  @ApiProperty({ enum: DIRECTIONS }) direction: (typeof DIRECTIONS)[number];

  @ApiProperty({ type: 'string', example: '300.00000000', description: 'Decimal string (§6.1).' })
  amount: string;

  @ApiProperty({ enum: CURRENCIES }) currency: (typeof CURRENCIES)[number];
  @ApiProperty({ enum: STATES }) state: (typeof STATES)[number];

  @ApiPropertyOptional({ enum: PROVIDERS }) provider?: (typeof PROVIDERS)[number];

  @ApiPropertyOptional({
    description:
      "The provider's own reference. Backs UNIQUE(provider, provider_ref), which is what makes settlement idempotent in the database (§6.3).",
  })
  providerRef?: string | null;

  @ApiPropertyOptional() destination?: string | null;
  @ApiPropertyOptional() rejectionReason?: string | null;
  @ApiPropertyOptional() reviewedBy?: string | null;
  @ApiPropertyOptional() reviewedAt?: Date | null;
  @ApiPropertyOptional() settledAt?: Date | null;
  @ApiProperty() createdAt: Date;
}
