import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { NoClientFields } from '../../../common/security/client-field.decorator';
import { IsBoolean, IsInt, IsOptional, IsString, Length, Matches, Max, Min } from 'class-validator';

/*
 * ── The money limits (0162) ─────────────────────────────────────────────────
 *
 * Six amounts, in the currency's OWN units, as decimal strings (§6.1): up to 20
 * integer digits so LBP's billions fit, up to 8 decimals because that is the
 * storage scale. The DTO checks SHAPE; `currencyLimitProblems` checks that they
 * make sense together (a floor above zero, a ceiling at least its floor), on
 * create and on the MERGED row on update.
 */
const LIMIT = /^\d{1,20}(\.\d{1,8})?$/;
const LIMIT_MESSAGE = 'must be an amount, e.g. 10 or 5000000 (up to 8 decimals)';
const limitDoc = (description: string, example: string) => ({
  type: 'string' as const,
  example,
  description: `${description} In this currency's own units.`,
});

/**
 * A currency as both apps read it.
 *
 * `decimals` is DISPLAY precision and nothing else. Storage is NUMERIC(28,8)
 * for every currency (ARCHITECTURE §6.1) — this number tells a UI how to
 * format, and any code that uses it to ROUND a stored balance is a bug.
 */
@NoClientFields('operator configuration - the currency catalogue')
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
  @ApiProperty(limitDoc('The smallest deposit a client may make.', '10.00000000'))
  minDeposit: string;
  @ApiProperty(limitDoc('The largest single deposit.', '250000.00000000'))
  maxDeposit: string;
  @ApiProperty(limitDoc('The smallest withdrawal a client may request.', '10.00000000'))
  minWithdrawal: string;
  @ApiProperty(limitDoc('The largest single withdrawal.', '50000.00000000'))
  maxWithdrawal: string;
  @ApiProperty(
    limitDoc('The most one client may withdraw in any rolling 24 hours.', '100000.00000000'),
  )
  maxWithdrawalDaily: string;
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

  @ApiPropertyOptional({ description: 'Omitted puts it after the last one.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  /** Setting this true clears the flag on whatever currently holds it. */
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  /*
   * REQUIRED on create, all six. A default would be one currency's numbers
   * handed to another — the exact bug this replaces: USD's 50,000 on LBP.
   */
  @ApiProperty(limitDoc('The smallest deposit a client may make.', '10'))
  @Matches(LIMIT, { message: `minDeposit ${LIMIT_MESSAGE}` })
  minDeposit: string;

  @ApiProperty(limitDoc('The largest single deposit.', '250000'))
  @Matches(LIMIT, { message: `maxDeposit ${LIMIT_MESSAGE}` })
  maxDeposit: string;

  @ApiProperty(limitDoc('The smallest withdrawal a client may request.', '10'))
  @Matches(LIMIT, { message: `minWithdrawal ${LIMIT_MESSAGE}` })
  minWithdrawal: string;

  @ApiProperty(limitDoc('The largest single withdrawal.', '50000'))
  @Matches(LIMIT, { message: `maxWithdrawal ${LIMIT_MESSAGE}` })
  maxWithdrawal: string;

  @ApiProperty(limitDoc('The most one client may withdraw in any rolling 24 hours.', '100000'))
  @Matches(LIMIT, { message: `maxWithdrawalDaily ${LIMIT_MESSAGE}` })
  maxWithdrawalDaily: string;
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

  @ApiPropertyOptional(limitDoc('The smallest deposit a client may make.', '10'))
  @IsOptional()
  @Matches(LIMIT, { message: `minDeposit ${LIMIT_MESSAGE}` })
  minDeposit?: string;

  @ApiPropertyOptional(limitDoc('The largest single deposit.', '250000'))
  @IsOptional()
  @Matches(LIMIT, { message: `maxDeposit ${LIMIT_MESSAGE}` })
  maxDeposit?: string;

  @ApiPropertyOptional(limitDoc('The smallest withdrawal a client may request.', '10'))
  @IsOptional()
  @Matches(LIMIT, { message: `minWithdrawal ${LIMIT_MESSAGE}` })
  minWithdrawal?: string;

  @ApiPropertyOptional(limitDoc('The largest single withdrawal.', '50000'))
  @IsOptional()
  @Matches(LIMIT, { message: `maxWithdrawal ${LIMIT_MESSAGE}` })
  maxWithdrawal?: string;

  @ApiPropertyOptional(
    limitDoc('The most one client may withdraw in any rolling 24 hours.', '100000'),
  )
  @IsOptional()
  @Matches(LIMIT, { message: `maxWithdrawalDaily ${LIMIT_MESSAGE}` })
  maxWithdrawalDaily?: string;
}
