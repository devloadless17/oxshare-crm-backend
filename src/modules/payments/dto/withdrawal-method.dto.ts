import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, Length, Matches, Min } from 'class-validator';
import { NoClientFields } from '../../../common/security/client-field.decorator';
import { LOGO_URL_MESSAGE, LOGO_URL_PATTERN } from './payment-method.dto';
import { METHOD_KEY_MESSAGE, METHOD_KEY_PATTERN } from '../method-keys';

/**
 * A WITHDRAWAL method as the console manages it — one `withdrawal_payment_methods`
 * row, disabled ones included.
 *
 * ## Why these are not the deposit methods
 *
 * A rail can accept deposits and not pay out, or the reverse, and the two lists
 * are switched on and off independently. The tables were split in migration
 * 0062 for exactly that reason; until now only the deposit side had a screen,
 * so the withdrawal list could only be changed in the database.
 *
 * ## No currency here, deliberately
 *
 * A withdrawal is paid in the currency of the wallet it leaves; the method is
 * the rail, not the denomination. The deposit side names a currency because it
 * decides which wallet a payment lands in, and nothing here has that job.
 */
@NoClientFields('platform payment configuration - a payout rail, not a person')
export class AdminWithdrawalMethodDto {
  @ApiProperty({
    example: 'whish',
    description:
      'A stable machine key. Never renamed: `transactions.withdrawal_method_key` references it.',
  })
  key: string;

  @ApiProperty({ example: 'Whish Money', description: 'What the client picks from.' })
  name: string;

  @ApiProperty({ type: String, nullable: true })
  logoUrl: string | null;

  @ApiProperty({
    description:
      'Whether clients are offered it on the withdraw form. Disabling leaves requests already ' +
      'made on it untouched — the desk still settles them.',
  })
  enabled: boolean;

  @ApiProperty({ example: 0, description: 'The order clients see the methods in.' })
  sortOrder: number;

  @ApiProperty({
    example: 'Whish payouts',
    description:
      'What the desk calls the rail (admin-only, unique). The console shows it in ' +
      'place of the key.',
  })
  internalLabel: string;

  /** @deprecated Always false since 0168 — see `AdminPaymentMethodDto.builtIn`. */
  @ApiProperty({
    description:
      'Deprecated: always false. No rail is built in since payment providers (0168); ' +
      'any rail no withdrawal references can be deleted.',
  })
  builtIn: boolean;

  @ApiProperty({
    description: 'A withdrawal references this method. Such a method cannot be deleted.',
  })
  inUse: boolean;

  @ApiProperty({
    example: 'rival',
    description: 'The payment provider behind the rail (0168). Fixed at creation.',
  })
  providerCode: string;

  @ApiProperty({
    example: 'whish',
    description: 'The provider’s payout channel the rail uses. Fixed at creation.',
  })
  channelCode: string;

  @ApiProperty({
    enum: ['provider', 'desk'],
    description:
      'Who pays a request on it now: the provider (an automated payout it is switched on ' +
      'for), or the desk by hand — always for a desk or cash rail, and for an automated one ' +
      'while its provider is off or not set up.',
  })
  paidBy: 'provider' | 'desk';

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}

export class CreateWithdrawalMethodDto {
  /**
   * The payout route — which provider pays, on which of its declared payout
   * channels (0168). Fixed once the method exists. Omitted, the desk pays
   * (`manual` · `desk`), which is what every rail but Whish has always been.
   */
  @ApiPropertyOptional({ example: 'rival', maxLength: 40 })
  @IsOptional()
  @IsString()
  @Length(1, 40)
  providerCode?: string;

  @ApiPropertyOptional({ example: 'whish', maxLength: 40 })
  @IsOptional()
  @IsString()
  @Length(1, 40)
  channelCode?: string;

  @ApiPropertyOptional({
    example: 'whish',
    maxLength: 40,
    description:
      'The permanent ID. Omit it — the platform generates one (`wm_…`) and the console never ' +
      'shows it.',
  })
  @IsOptional()
  @IsString()
  @Length(2, 40)
  @Matches(METHOD_KEY_PATTERN, { message: METHOD_KEY_MESSAGE })
  key?: string;

  @ApiProperty({ example: 'Bank transfer' })
  @IsString()
  @Length(1, 80)
  name: string;

  @ApiPropertyOptional({
    maxLength: 80,
    example: 'OMT – Hamra branch',
    description:
      'What the DESK calls the method — shown, typed and renamed in the console in place of ' +
      'the key, and on every admin screen, export and bell. Unique (case-insensitive). Never ' +
      'sent to a client. Omitted, it starts as `name`.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 80)
  internalLabel?: string;

  @ApiPropertyOptional({ maxLength: 2048, example: '/v1/uploads/payment-logos/8f2c….png' })
  @IsOptional()
  @IsString()
  @Length(0, 2048)
  @Matches(LOGO_URL_PATTERN, { message: LOGO_URL_MESSAGE })
  logoUrl?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ description: 'Omitted puts it after the last one.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

/**
 * A PATCH: omitted means leave it. `key` is absent — it is the primary key, and
 * withdrawal requests reference it.
 */
export class UpdateWithdrawalMethodDto {
  @ApiPropertyOptional({
    maxLength: 80,
    example: 'OMT – Hamra branch',
    description:
      'Renames the method for the desk: one row, and every admin screen, export and bell ' +
      'follows at once. Unique (case-insensitive), never blank, never sent to a client.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 80)
  internalLabel?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 80)
  name?: string;

  @ApiPropertyOptional({ maxLength: 2048, example: '/v1/uploads/payment-logos/8f2c….png' })
  @IsOptional()
  @IsString()
  @Length(0, 2048)
  @Matches(LOGO_URL_PATTERN, { message: LOGO_URL_MESSAGE })
  logoUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
