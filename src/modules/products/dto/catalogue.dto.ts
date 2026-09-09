import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { NoClientFields } from '../../../common/security/client-field.decorator';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * A spread markup, as a decimal STRING (§6.1).
 *
 * It is money and it is `NUMERIC(28,8)`, so a JSON number would round-trip
 * through a float before anybody did arithmetic with it — the mistake ADM-10's
 * commission rates are spelled this way to avoid. Eight decimals, matching the
 * column; longer is refused rather than silently rounded, because a markup an
 * operator typed and a markup the system stored must be the same number.
 *
 * The upper bound is the same typo guard the CHECK constraint carries: four
 * digits before the point. 10,000 per lot is orders of magnitude past any real
 * markup and well short of the mistake that turns 1.5 into 150000.
 */
const SPREAD_MARKUP = /^\d{1,5}(\.\d{1,8})?$/;
const SPREAD_MARKUP_MESSAGE =
  'must be a non-negative decimal with at most eight places, as a string — e.g. "1.5" or "0.00000000"';

/* ── Products ─────────────────────────────────────────────────────────────── */

@NoClientFields(
  'operator configuration - the product and agency catalogue, which describes what is sold and not who bought it',
)
export class ProductGroupDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: ['live', 'demo'] })
  environment: 'live' | 'demo';

  @ApiProperty({ example: 'real\\Standard-USD', description: 'The MT5 group path.' })
  mt5Group: string;

  @ApiProperty({
    example: 'USD',
    description:
      'Cached from MT5 when the group was attached. Anything a client is shown re-reads it live.',
  })
  currency: string;
}

@NoClientFields(
  'operator configuration - the product and agency catalogue, which describes what is sold and not who bought it',
)
export class ProductDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Standard' })
  name: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  description: string | null;

  @ApiProperty({ description: 'A disabled product stops being sold and keeps its accounts.' })
  enabled: boolean;

  @ApiProperty({
    enum: ['real', 'demo'],
    description:
      'Fixed at creation. At most ONE demo product exists; it is offered to every client for ' +
      'demo accounts regardless of agency, and cannot be assigned to an agency. Real products ' +
      'carry live groups, the demo product carries demo groups.',
  })
  type: 'real' | 'demo';

  @ApiProperty({
    type: 'string',
    example: '1.50000000',
    description:
      "The broker's spread markup per standard lot, in the account currency. A COMMERCIAL " +
      'RECORD ONLY — nothing computes from it, and it is deliberately not part of the revenue ' +
      'partners are paid a share of. A decimal string, never a number: it is money.',
  })
  spreadMarkupPerLot: string;

  @ApiProperty({ example: 0 })
  sortOrder: number;

  @ApiProperty({ type: [ProductGroupDto] })
  groups: ProductGroupDto[];
}

export class UpsertProductDto {
  @ApiProperty({ example: 'Standard', maxLength: 80 })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @ApiProperty({ example: true })
  @IsBoolean()
  enabled: boolean;

  /**
   * Optional so a PUT (full replace) that omits it keeps the stored type.
   * On create it defaults to `real`; on update a value that DIFFERS from the
   * stored type is refused — the type is fixed at creation.
   */
  @ApiPropertyOptional({ enum: ['real', 'demo'] })
  @IsOptional()
  @IsIn(['real', 'demo'])
  type?: 'real' | 'demo';

  /**
   * Optional, and omitting it KEEPS the stored value rather than zeroing it.
   *
   * This is a PUT, so a client that predates the field would otherwise reset a
   * negotiated markup every time somebody renamed a product — and the audit row
   * would faithfully record a change nobody made.
   */
  @ApiPropertyOptional({ type: 'string', example: '1.50000000' })
  @IsOptional()
  @IsString()
  @Matches(SPREAD_MARKUP, { message: `spreadMarkupPerLot ${SPREAD_MARKUP_MESSAGE}` })
  spreadMarkupPerLot?: string;

  /**
   * Where this row sits, or OMITTED for "wherever" — which appends.
   *
   * Optional since ordering became an INSERT rather than a stored sort key:
   * taking a position now pushes the rows below it down, so `0` is a real
   * instruction ("put this first") and was the one every create silently gave.
   * A form that could not express "just add it" had no way to say the ordinary
   * thing. See `common/ordering.ts`.
   */
  @ApiPropertyOptional({ example: 0, minimum: 0, maximum: 1000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  sortOrder?: number;
}

export class AttachGroupDto {
  @ApiProperty({ enum: ['live', 'demo'] })
  @IsIn(['live', 'demo'])
  environment: 'live' | 'demo';

  /**
   * Validated against the groups MT5 actually reports, not just for length.
   *
   * An operator typing `real\Standrd-USD` gets an error on this screen instead
   * of a client discovering it at their first account open — and the group is
   * also where a product's whole commercial identity lives, so a wrong one is
   * not a cosmetic mistake.
   */
  @ApiProperty({ example: 'real\\Standard-USD', maxLength: 100 })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  mt5Group: string;
}

/** One group the MT5 server reports, and whether a product already has it. */
@NoClientFields(
  'operator configuration - the product and agency catalogue, which describes what is sold and not who bought it',
)
export class AvailableGroupDto {
  @ApiProperty({ example: 'real\\Standard-USD' })
  name: string;

  @ApiProperty({ example: 'USD', description: 'Read live from the server.' })
  currency: string;

  @ApiProperty({
    description:
      'True when another product already claims it. Shown disabled with the reason rather than ' +
      'hidden, so an operator can tell "not offered" from "already taken".',
  })
  claimed: boolean;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'NULL when this list was read live from MT5, which is the normal case. A date means the ' +
      'server could not be reached and this row came from the synced catalogue instead — it is ' +
      'when that group was last confirmed to exist. Surface it: a stale picker that cannot say ' +
      'how stale it is reads exactly like a current one.',
  })
  lastSeenAt: string | null;
}

/* ── Agencies ─────────────────────────────────────────────────────────────── */

@NoClientFields(
  'operator configuration - the product and agency catalogue, which describes what is sold and not who bought it',
)
export class AgencyDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    example: 'Gold Agency',
    description: 'وكالة — the package a partner sells under.',
  })
  name: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Read by an applicant deciding which agency to request. Worth writing well.',
  })
  description: string | null;

  @ApiProperty({
    description: 'A disabled agency stops taking applications and keeps its partners.',
  })
  enabled: boolean;

  @ApiProperty({ example: 0 })
  sortOrder: number;

  /*
   * `@ApiProperty`, not `@ApiPropertyOptional` — the key is ALWAYS present on a
   * response and its VALUE may be null. Marking it optional generated
   * `string | null | undefined` on the frontend, which forced every reader to
   * handle a third state the API never sends.
   */
  /*
   * ── `defaultProgramId` IS GONE (0112) ────────────────────────────────────
   *
   * An agency named the commission programme its partners were appointed on.
   * Terms come from a partner's RUNG now, derived from who recruited them, so
   * an agency has no opinion about what anybody is paid. It still bounds what
   * they may SELL, through its products.
   */

  @ApiProperty({ type: [String], format: 'uuid', description: 'The products this agency sells.' })
  productIds: string[];
}

export class UpsertAgencyDto {
  @ApiProperty({ example: 'Gold Agency', maxLength: 80 })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @ApiProperty({ example: true })
  @IsBoolean()
  enabled: boolean;

  /**
   * Where this row sits, or OMITTED for "wherever" — which appends.
   *
   * Optional since ordering became an INSERT rather than a stored sort key:
   * taking a position now pushes the rows below it down, so `0` is a real
   * instruction ("put this first") and was the one every create silently gave.
   * A form that could not express "just add it" had no way to say the ordinary
   * thing. See `common/ordering.ts`.
   */
  @ApiPropertyOptional({ example: 0, minimum: 0, maximum: 1000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  sortOrder?: number;
}

export class SetAgencyProductsDto {
  /**
   * The complete set, not a delta.
   *
   * A PUT of the whole list rather than add/remove calls, because the operator
   * edits it as a set of checkboxes and two clients doing add-then-remove
   * concurrently on a delta API leave a set neither of them chose.
   *
   * An EMPTY list is legal and means the agency sells nothing yet — which the
   * partner screen shows as a warning rather than treating as "sells
   * everything". Falling back to the full catalogue here would let an operator
   * hand out an agency that quietly grants more than they picked.
   */
  @ApiProperty({ type: [String], format: 'uuid' })
  @IsArray()
  @IsUUID('4', { each: true })
  productIds: string[];
}

/** What the portal shows an applicant choosing which agency to apply to. */
export class PublicAgencyDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Gold Agency' })
  name: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  description: string | null;

  @ApiProperty({
    type: [String],
    example: ['Standard', 'ECN'],
    description: 'Product NAMES, not ids — the applicant is reading, not selecting.',
  })
  products: string[];
}
