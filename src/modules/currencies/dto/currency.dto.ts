import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';

/**
 * A currency as both apps read it.
 *
 * `decimals` is DISPLAY precision and nothing else. Storage is NUMERIC(28,8)
 * for every currency (ARCHITECTURE §6.1) — this number tells a UI how to
 * format, and any code that uses it to ROUND a stored balance is a bug.
 */
export class CurrencyDto {
  @ApiProperty({ example: 'USD' }) code: string;
  @ApiProperty({ example: 'US Dollar' }) name: string;
  @ApiProperty({ example: '$' }) symbol: string;
  @ApiProperty({ example: 2, description: 'Display precision only; storage is always 8dp.' })
  decimals: number;
  @ApiProperty({ description: 'Disabled currencies keep their wallets but accept no new ones.' })
  enabled: boolean;
  @ApiProperty({ description: "The currency a new client's first wallet opens in." })
  isDefault: boolean;
  @ApiProperty() sortOrder: number;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}

export class CreateCurrencyDto {
  /**
   * Upper-case letters and digits only.
   *
   * Not a free string: this value becomes a foreign key on every wallet and
   * every ledger-bearing transaction, it is compared for equality all over the
   * system, and ' usd ' or 'Usd' would each create a SECOND currency that looks
   * identical to a human and matches nothing. The service upper-cases and trims
   * before this runs, so the pattern is the last line rather than the only one.
   */
  @ApiProperty({ example: 'EUR' })
  @IsString()
  @Length(2, 10)
  @Matches(/^[A-Z0-9]+$/, {
    message: 'code must be upper-case letters and digits only, e.g. EUR or USDT',
  })
  code: string;

  @ApiProperty({ example: 'Euro' })
  @IsString()
  @Length(1, 80)
  name: string;

  @ApiProperty({ example: '€' })
  @IsString()
  @Length(1, 8)
  symbol: string;

  /**
   * Capped at 8 because that is the storage scale. A currency declaring 10
   * display decimals would render two digits the database cannot hold, which
   * reads as a rounding bug in the balance rather than a bad configuration.
   */
  @ApiPropertyOptional({ default: 2, minimum: 0, maximum: 8 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(8)
  decimals?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  /** Setting this true clears the flag on whatever currently holds it. */
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

/**
 * `code` is absent, and that is deliberate rather than an oversight.
 *
 * The code is the primary key and it is referenced by wallets, transactions,
 * transfers and commission accruals. Renaming it is not an edit, it is a data
 * migration across four money tables — so the API does not offer it as one.
 */
export class UpdateCurrencyDto {
  @ApiPropertyOptional({ example: 'Euro' })
  @IsOptional()
  @IsString()
  @Length(1, 80)
  name?: string;

  @ApiPropertyOptional({ example: '€' })
  @IsOptional()
  @IsString()
  @Length(1, 8)
  symbol?: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 8 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(8)
  decimals?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}
