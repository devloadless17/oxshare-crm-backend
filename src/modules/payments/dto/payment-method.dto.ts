import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { NoClientFields } from '../../../common/security/client-field.decorator';
import { IsBoolean, IsInt, IsOptional, IsString, Length, Matches, Min } from 'class-validator';

/**
 * A logo this API will serve, or an https one it will not.
 *
 * ## ⚠️ The path form is REQUIRED, and its absence was a live bug
 *
 * `POST /admin/payment-methods/logo` answers with `/v1/uploads/payment-logos/…`
 * — a path on this API, which is the entire point of replacing the old URL field
 * with an upload. The validator here was `@IsUrl({ protocols: ['https'] })`,
 * which refuses exactly that shape. So the admin console's own upload button
 * produced a value its own Save button rejected with a 400, and the only logo
 * that could be stored was one pasted from a third-party host.
 *
 * ## Why not simply allow any string
 *
 * This becomes an `<img src>` in every client's browser. Same reasoning as
 * `platform_links.url`: an operator-set value reaching a browser unchecked is
 * where a `javascript:` URL would land. Two shapes are allowed and nothing else
 * — a path under our own upload bucket, or an absolute https URL.
 */
/*
 * Exported: withdrawal methods (`withdrawal-method.dto.ts`) take their logos
 * through the SAME upload endpoint, so they validate against the same rule.
 */
export const LOGO_URL_PATTERN = /^(https:\/\/\S+|\/v1\/uploads\/payment-logos\/[A-Za-z0-9._-]+)$/;
export const LOGO_URL_MESSAGE =
  'logoUrl must be an https URL or a path returned by POST /admin/payment-methods/logo';

/** What a client is shown and what a deposit is checked against. */
@NoClientFields('operator configuration - the payment methods offered, not who used them')
export class PaymentMethodDto {
  @ApiProperty({ example: 'whish', description: 'A stable machine key. Never renamed.' })
  key: string;

  @ApiProperty({ example: 'Whish Money' })
  name: string;

  @ApiProperty({ example: 'USD' })
  currency: string;

  @ApiProperty({ type: 'string', nullable: true })
  logoUrl: string | null;

  /*
   * `kind` is GONE — the column was dropped in migration 0043 and nothing here
   * replaces it.
   *
   * It used to tell the portal which deposit FLOW to draw, and the portal used
   * it to print "Manual" or "Instant" beside a method. That is a fact about our
   * integration, not a choice the client makes, and it was printed beside the
   * one control they DO use: pick a method and pay. What actually decides the
   * flow is whether `POST /payments/deposits` answers with a `paymentUrl` — the
   * server knows by then, and the portal branches on the answer rather than on a
   * prediction of it.
   *
   * `payTo` and `instructions` went the same way in 0042. None of the three is
   * left on the DTO as an always-null field: a field the API advertises and
   * never fills is one a client renders an empty box for.
   */

  @ApiProperty({
    type: 'string',
    example: '10.00000000',
    description:
      'The smallest deposit this method accepts, RESOLVED SERVER-SIDE from the platform limits ' +
      '(§12.4). The same figure `POST /payments/deposits` enforces, so a client showing it cannot ' +
      'promise a floor the validator disagrees with. A decimal string, never a number (§6.1).',
  })
  minAmount: string;

  @ApiProperty({
    type: 'string',
    example: '5000.00000000',
    description:
      'The largest deposit this method accepts. Same source and same guarantee as above.',
  })
  maxAmount: string;
  @ApiProperty() enabled: boolean;
  @ApiProperty() sortOrder: number;

  @ApiProperty({
    description:
      'The client must attach a receipt: this method is paid outside the platform and an ' +
      'operator approves it by hand. The portal reads this to decide whether to ask for one, ' +
      'rather than branching on the method key.',
  })
  requiresProof: boolean;
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

  /**
   * What this method settles in — NOT NULL, and the wallet a deposit lands in.
   *
   * Required rather than defaulted to USD. A method denominated in the wrong
   * currency puts a client's money in a denomination the operator never agreed
   * to receive, and a silent default is how that happens without anybody
   * choosing it.
   */
  @ApiProperty({ example: 'USD' })
  @IsString()
  @Length(1, 10)
  currency: string;

  /** An upload path or an https URL — see `LOGO_URL_PATTERN`. */
  @ApiPropertyOptional({ maxLength: 2048, example: '/v1/uploads/payment-logos/8f2c….png' })
  @IsOptional()
  @IsString()
  @Length(0, 2048)
  @Matches(LOGO_URL_PATTERN, { message: LOGO_URL_MESSAGE })
  logoUrl?: string;

  /*
   * No `payTo`, `instructions`, `minAmount` or `maxAmount` — all four columns
   * went in migration 0042 — and no `kind`, which went in 0043. An operator
   * configures a method by naming it, giving it a logo and switching it on; the
   * bounds are the platform's and apply to every method equally, and the flow is
   * decided by whether a gateway is implemented for the key.
   */

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ description: 'Omitted puts it after the last one.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @ApiPropertyOptional({
    /*
     * No `default:` here, deliberately. A default makes openapi-typescript
     * generate the property as REQUIRED — which is why `enabled` and `sortOrder`
     * are required in the generated create body despite being optional on the
     * wire — and every existing caller that omits it stops compiling. The column
     * default (false) is where the default belongs.
     */
    description:
      'OFFLINE: the client pays outside the platform and must attach a receipt. Such a deposit ' +
      'is filed through POST /payments/deposits/offline and settles when an operator approves ' +
      'it — the JSON deposit route refuses the method. Cannot be combined with a gateway key.',
  })
  @IsOptional()
  @IsBoolean()
  requiresProof?: boolean;
}

/**
 * `key` is absent: it is the primary key and `transactions.method_key`
 * references it, so renaming is a data migration rather than an edit.
 *
 * ## `instructions`, `payTo`, `minAmount` and `maxAmount` are gone from HERE too
 *
 * They outlived their columns by a release. `update()` never read them — the
 * columns went in migration 0042 — so the API accepted a pay-to account, a set
 * of transfer instructions and a pair of deposit bounds, answered 200, and
 * stored none of it. An accepted write that changes nothing is worse than a
 * rejected one: the operator has been told their change took effect.
 */
export class UpdatePaymentMethodDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 80) name?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 10) currency?: string;

  /** An upload path or an https URL — see `LOGO_URL_PATTERN`. */
  @ApiPropertyOptional({ maxLength: 2048, example: '/v1/uploads/payment-logos/8f2c….png' })
  @IsOptional()
  @IsString()
  @Length(0, 2048)
  @Matches(LOGO_URL_PATTERN, { message: LOGO_URL_MESSAGE })
  logoUrl?: string;

  @ApiPropertyOptional() @IsOptional() @IsBoolean() enabled?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) sortOrder?: number;

  @ApiPropertyOptional({
    /*
     * No `default:` here, deliberately. A default makes openapi-typescript
     * generate the property as REQUIRED — which is why `enabled` and `sortOrder`
     * are required in the generated create body despite being optional on the
     * wire — and every existing caller that omits it stops compiling. The column
     * default (false) is where the default belongs.
     */
    description:
      'OFFLINE: the client pays outside the platform and must attach a receipt. Such a deposit ' +
      'is filed through POST /payments/deposits/offline and settles when an operator approves ' +
      'it — the JSON deposit route refuses the method. Cannot be combined with a gateway key.',
  })
  @IsOptional()
  @IsBoolean()
  requiresProof?: boolean;
}

/**
 * What a logo upload answers with.
 *
 * The URL ONLY — the upload does not write it to the method. The operator is
 * still editing a form they may cancel, and an upload that mutated the row
 * would change what every client sees on the deposit screen before Save was
 * ever pressed.
 */
@NoClientFields('operator configuration - the payment methods offered, not who used them')
export class PaymentLogoResponseDto {
  @ApiProperty({
    example: '/v1/uploads/payment-logos/8f2c….png',
    description:
      'A path on THIS API, not a third-party host. Put it on the method’s `logoUrl` when saving.',
  })
  logoUrl: string;
}
