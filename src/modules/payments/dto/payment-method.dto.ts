import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { NoClientFields } from '../../../common/security/client-field.decorator';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Min,
  ValidateIf,
} from 'class-validator';
import { METHOD_KEY_MESSAGE, METHOD_KEY_PATTERN } from '../method-keys';

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
      'The smallest deposit this method accepts, RESOLVED SERVER-SIDE: the tighter of the ' +
      "currency's minimum deposit and the method's own (0162). The same figure " +
      '`POST /payments/deposits` enforces, so a client showing it cannot promise a floor the ' +
      'validator disagrees with. A decimal string, never a number (§6.1).',
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

/** A method's own limit: an amount, up to 20 digits and 8 decimals (§6.1). */
const OWN_LIMIT = /^\d{1,20}(\.\d{1,8})?$/;
const OWN_LIMIT_MESSAGE = 'must be an amount, e.g. 100 or 5000000 (up to 8 decimals)';

export class CreatePaymentMethodDto {
  /**
   * Lower-case, letters, digits and underscores.
   *
   * It ends up in `transactions.provider` as `manual_<key>` and in URLs, so a
   * space or a slash here becomes a bug somewhere that cannot fix it.
   */
  @ApiPropertyOptional({
    example: 'whish',
    maxLength: 40,
    description:
      'The permanent ID. Omit it — the platform generates one (`pm_…`) and the console never ' +
      'shows it. Given only to create a row the CODE dispatches on (a gateway such as whish).',
  })
  @IsOptional()
  @IsString()
  @Length(2, 40)
  @Matches(METHOD_KEY_PATTERN, { message: METHOD_KEY_MESSAGE })
  key?: string;

  @ApiProperty({ example: 'Whish Money' })
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
   * No `payTo` or `instructions` — both went in migration 0042 — and no `kind`,
   * which went in 0043. The flow is decided by whether a gateway is implemented
   * for the key. The deposit RANGE is the currency's (0162), and a method may
   * narrow it with the two optional fields below.
   */

  /*
   * The method's OWN range (0162) — optional, and it can only NARROW the
   * currency's deposit limits: a value outside them is refused under its field.
   * `null` clears it back to "the currency's limit".
   */
  @ApiPropertyOptional({
    type: 'string',
    nullable: true,
    example: '100',
    description:
      "Optional minimum for this method, tighter than the currency's minimum deposit. " +
      "Null or omitted: the currency's.",
  })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @Matches(OWN_LIMIT, { message: `ownMinAmount ${OWN_LIMIT_MESSAGE}` })
  ownMinAmount?: string | null;

  @ApiPropertyOptional({
    type: 'string',
    nullable: true,
    example: '5000',
    description:
      "Optional maximum for this method, tighter than the currency's maximum deposit. " +
      "Null or omitted: the currency's.",
  })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @Matches(OWN_LIMIT, { message: `ownMaxAmount ${OWN_LIMIT_MESSAGE}` })
  ownMaxAmount?: string | null;

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
 * `key` is absent: it is the primary key, transactions reference it and spell it
 * into `provider`, and code dispatches on it — migration 0161 records why a
 * rename was built, measured and rejected. The desk renames a method through
 * `internalLabel`, which is one row and rewrites no history.
 *
 * ## `instructions` and `payTo` are gone from HERE too
 *
 * They outlived their columns by a release. `update()` never read them — the
 * columns went in migration 0042 — so the API accepted a pay-to account and a
 * set of transfer instructions, answered 200, and stored none of it. An
 * accepted write that changes nothing is worse than a rejected one. The range
 * came back in 0162 as `ownMinAmount`/`ownMaxAmount`, and IS stored.
 */
export class UpdatePaymentMethodDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @Length(1, 80) name?: string;

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

  /*
   * The method's OWN range (0162) — optional, and it can only NARROW the
   * currency's deposit limits: a value outside them is refused under its field.
   * `null` clears it back to "the currency's limit".
   */
  @ApiPropertyOptional({
    type: 'string',
    nullable: true,
    example: '100',
    description:
      "Optional minimum for this method, tighter than the currency's minimum deposit. " +
      "Null or omitted: the currency's.",
  })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @Matches(OWN_LIMIT, { message: `ownMinAmount ${OWN_LIMIT_MESSAGE}` })
  ownMinAmount?: string | null;

  @ApiPropertyOptional({
    type: 'string',
    nullable: true,
    example: '5000',
    description:
      "Optional maximum for this method, tighter than the currency's maximum deposit. " +
      "Null or omitted: the currency's.",
  })
  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @Matches(OWN_LIMIT, { message: `ownMaxAmount ${OWN_LIMIT_MESSAGE}` })
  ownMaxAmount?: string | null;
}

/** The console's view of a method: the client shape plus what the desk may do to it. */
@NoClientFields('operator configuration - the payment methods offered, not who used them')
export class AdminPaymentMethodDto extends PaymentMethodDto {
  @ApiProperty({
    type: 'string',
    nullable: true,
    description:
      "The method's own minimum as the operator set it — null means the currency's. " +
      '`minAmount` is what clients are actually held to.',
  })
  ownMinAmount: string | null;

  @ApiProperty({
    type: 'string',
    nullable: true,
    description:
      "The method's own maximum as the operator set it — null means the currency's. " +
      '`maxAmount` is what clients are actually held to.',
  })
  ownMaxAmount: string | null;

  @ApiProperty({
    example: 'OMT – Hamra branch',
    description:
      'What the desk calls the method (admin-only, unique). The console shows it in ' +
      'place of the key.',
  })
  internalLabel: string;

  @ApiProperty({
    description:
      'The platform’s code depends on this method (a payment gateway), so it cannot be deleted.',
  })
  builtIn: boolean;

  @ApiProperty({
    description:
      'A transaction references this method. Such a method cannot be deleted — disable it.',
  })
  inUse: boolean;
}

/** What deleting a never-used payment or withdrawal method answers with. */
@NoClientFields('operator configuration - the payment methods offered, not who used them')
export class DeletedMethodDto {
  @ApiProperty({ example: 'typo_method' })
  key: string;

  @ApiProperty({ example: true })
  deleted: boolean;
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
