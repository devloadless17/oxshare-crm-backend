import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Matches,
  Min,
} from 'class-validator';

export const PAYMENT_METHOD_KINDS = ['manual', 'gateway', 'crypto'] as const;
export type PaymentMethodKind = (typeof PAYMENT_METHOD_KINDS)[number];

/**
 * A decimal string with at most eight places, matching NUMERIC(28,8).
 *
 * `@IsString` plus a pattern rather than `@IsNumber`: the moment a bound is
 * parsed as a number it has been through a float, and these are compared
 * against amounts (§6.1).
 */
const MONEY_PATTERN = /^\d{1,20}(\.\d{1,8})?$/;
const MONEY_MESSAGE = 'must be a decimal string with at most eight decimal places, e.g. "10.00"';

/** What a client is shown and what a deposit is checked against. */
export class PaymentMethodDto {
  @ApiProperty({ example: 'whish', description: 'A stable machine key. Never renamed.' })
  key: string;

  @ApiProperty({ example: 'Whish Money' })
  name: string;

  @ApiProperty({
    enum: PAYMENT_METHOD_KINDS,
    description:
      'Decides the deposit FLOW, so a screen branches on this rather than on the key — a screen ' +
      'that checks `key === "whish"` needs editing every time a method is added.',
  })
  kind: PaymentMethodKind;

  @ApiProperty({ example: 'USD' })
  currency: string;

  @ApiProperty({ type: 'string', nullable: true })
  logoUrl: string | null;

  @ApiProperty({
    type: 'string',
    nullable: true,
    description: "What the client must do, in the operator's words. Rendered verbatim.",
  })
  instructions: string | null;

  @ApiProperty({
    type: 'string',
    nullable: true,
    description:
      'The account the client sends to. A method with none is NOT offered — see ' +
      'PaymentMethodsService.listAvailable.',
  })
  payTo: string | null;

  @ApiProperty({ type: 'string', nullable: true }) minAmount: string | null;
  @ApiProperty({ type: 'string', nullable: true }) maxAmount: string | null;
  @ApiProperty() enabled: boolean;
  @ApiProperty() sortOrder: number;
}

export class CreatePaymentMethodDto {
  /**
   * Lower-case, letters, digits and underscores.
   *
   * It ends up in `transactions.provider` as `manual_<key>` and in URLs, so a
   * space or a slash here becomes a bug somewhere that cannot fix it.
   */
  @ApiProperty({ example: 'whish', maxLength: 40 })
  @IsString()
  @Length(2, 40)
  @Matches(/^[a-z0-9_]+$/i, {
    message: 'key may contain only letters, digits and underscores',
  })
  key: string;

  @ApiProperty({ example: 'Whish Money' })
  @IsString()
  @Length(1, 80)
  name: string;

  @ApiProperty({ enum: PAYMENT_METHOD_KINDS })
  @IsIn(PAYMENT_METHOD_KINDS)
  kind: PaymentMethodKind;

  @ApiProperty({ example: 'USD' })
  @IsString()
  @Length(1, 10)
  currency: string;

  /**
   * `@IsUrl` with https only. This becomes an `<img src>` in every client's
   * browser, so the same reasoning as `platform_links.url`: an operator-set
   * value reaching a browser unchecked is where a `javascript:` URL would land.
   */
  @ApiPropertyOptional({ maxLength: 2048 })
  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @Length(0, 2048)
  logoUrl?: string;

  @ApiPropertyOptional({ description: 'Shown verbatim on the deposit screen.' })
  @IsOptional()
  @IsString()
  @Length(0, 4000)
  instructions?: string;

  @ApiPropertyOptional({ description: 'The Whish number, IBAN or wallet address.' })
  @IsOptional()
  @IsString()
  @Length(0, 255)
  payTo?: string;

  @ApiPropertyOptional({ type: 'string', example: '10.00' })
  @IsOptional()
  @IsString()
  @Matches(MONEY_PATTERN, { message: `minAmount ${MONEY_MESSAGE}` })
  minAmount?: string;

  @ApiPropertyOptional({ type: 'string', example: '5000.00' })
  @IsOptional()
  @IsString()
  @Matches(MONEY_PATTERN, { message: `maxAmount ${MONEY_MESSAGE}` })
  maxAmount?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

/**
 * `key` is absent: it is the primary key and `transactions.method_key`
 * references it, so renaming is a data migration rather than an edit.
 */
export class UpdatePaymentMethodDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 80) name?: string;

  @ApiPropertyOptional({ enum: PAYMENT_METHOD_KINDS })
  @IsOptional()
  @IsIn(PAYMENT_METHOD_KINDS)
  kind?: PaymentMethodKind;

  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 10) currency?: string;

  @ApiPropertyOptional({ maxLength: 2048 })
  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @Length(0, 2048)
  logoUrl?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 4000) instructions?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(0, 255) payTo?: string;

  @ApiPropertyOptional({ type: 'string' })
  @IsOptional()
  @IsString()
  @Matches(MONEY_PATTERN, { message: `minAmount ${MONEY_MESSAGE}` })
  minAmount?: string;

  @ApiPropertyOptional({ type: 'string' })
  @IsOptional()
  @IsString()
  @Matches(MONEY_PATTERN, { message: `maxAmount ${MONEY_MESSAGE}` })
  maxAmount?: string;

  @ApiPropertyOptional() @IsOptional() @IsBoolean() enabled?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) sortOrder?: number;
}
