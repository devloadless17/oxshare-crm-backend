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
    type: String,
    nullable: true,
  })
  /*
   * Every nullable field below states `type` EXPLICITLY.
   *
   * `@ApiPropertyOptional()` alone reflects the TypeScript type, and reflection
   * cannot see through a union — `string | null` arrives as `Object`, Swagger
   * emits an empty schema, and openapi-typescript generates
   * `Record<string, never>`. The frontend then cannot read the field at all: the
   * portal's transactions screen failed to compile on `tx.rejectionReason`,
   * which is how this was found.
   *
   * `nullable: true` rather than just optional, because these genuinely arrive
   * as null — a pending withdrawal has no providerRef and no settledAt — and a
   * consumer that treats absent and null the same will eventually meet one of
   * them it did not expect.
   */
  providerRef?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true }) destination?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) rejectionReason?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) reviewedBy?: string | null;
  @ApiPropertyOptional({ type: Date, nullable: true }) reviewedAt?: Date | null;
  @ApiPropertyOptional({ type: Date, nullable: true }) settledAt?: Date | null;
  @ApiProperty() createdAt: Date;
}
