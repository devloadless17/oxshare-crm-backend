import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { NoClientFields } from '../../../common/security/client-field.decorator';
import { OptionalArabicText } from '../../../common/dto/arabic-text';
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
  ValidateIf,
} from 'class-validator';

/** An amount as typed: digits, up to 8 decimals. Above zero is the service's rule. */
const MIN_DEPOSIT = /^\d{1,20}(\.\d{1,8})?$/;
const MIN_DEPOSIT_MESSAGE = 'minDeposit must be an amount, e.g. 100 or 250.50 (up to 8 decimals)';
const minDepositDoc = {
  type: 'string' as const,
  nullable: true,
  example: '100',
  description:
    'The least a client may move into an account on this group per transfer, in the ' +
    "group's currency (0201). Null = no minimum. Live groups only.",
};

/*
 * `SPREAD_MARKUP` stood here until 0140. The product's spread markup is gone —
 * it was a commercial record that drove nothing — and what a product pays
 * partners is now the COMMISSION TYPE it points at (`commissionTypeId`), whose
 * amounts are validated on its own DTO.
 */
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

  @ApiProperty(minDepositDoc)
  minDeposit: string | null;
}

@NoClientFields(
  'operator configuration - the product and agency catalogue, which describes what is sold and not who bought it',
)
export class ProductDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Standard' })
  name: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'قياسي',
    description: 'The name in Arabic (0179); null = not translated, show `name`.',
  })
  nameAr: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  description: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The description in Arabic (0179); null = not translated, show `description`.',
  })
  descriptionAr: string | null;

  @ApiProperty({ description: 'A disabled product stops being sold and keeps its accounts.' })
  enabled: boolean;

  @ApiProperty({
    enum: ['real', 'demo'],
    description:
      'Fixed at creation. Any number of demo products may exist (0201); every enabled one is ' +
      'offered to every client for demo accounts regardless of agency, and none can be ' +
      'assigned to an agency. Real products carry live groups, demo products demo groups.',
  })
  type: 'real' | 'demo';

  @ApiProperty({
    type: 'string',
    format: 'uuid',
    nullable: true,
    description:
      'The commission type this product pays partners on (0140) — the rate card whose per-lot ' +
      'amounts each level takes a share of. NULL means the product pays no partner ' +
      'commission at all; a demo product never carries one.',
  })
  commissionTypeId: string | null;

  @ApiProperty({ example: 0 })
  sortOrder: number;

  @ApiProperty({
    example: 5,
    minimum: 1,
    maximum: 100,
    description:
      'How many accounts one client may hold under this product (0201). Closed accounts do ' +
      'not count.',
  })
  maxAccountsPerClient: number;

  @ApiProperty({ type: [ProductGroupDto] })
  groups: ProductGroupDto[];
}

export class UpsertProductDto {
  @ApiProperty({ example: 'Standard', maxLength: 80 })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name: string;

  /** A PUT that omits it keeps the stored Arabic; null or blank clears it. */
  @OptionalArabicText(80, 'قياسي')
  nameAr?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  /** A PUT that omits it keeps the stored Arabic; null or blank clears it. */
  @OptionalArabicText(2000, 'حسابات بفروق أسعار منخفضة وعمولة ثابتة.')
  descriptionAr?: string | null;

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
   * OMITTED keeps the stored type; an explicit NULL clears it.
   *
   * This is a PUT, so a client that predates the field would otherwise strip a
   * product's terms every time somebody renamed it — and the audit row would
   * faithfully record a change nobody made. Refused on the demo product, which
   * never accrues, and refused when the id names no type.
   */
  @ApiPropertyOptional({ type: 'string', format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID()
  commissionTypeId?: string | null;

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

  /**
   * OMITTED keeps the stored cap (5 on create): the list's on/off switch sends
   * only name, description and enabled, and must not reset it.
   */
  @ApiPropertyOptional({ example: 5, minimum: 1, maximum: 100 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  maxAccountsPerClient?: number;
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

  @ApiPropertyOptional(minDepositDoc)
  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @Matches(MIN_DEPOSIT, { message: MIN_DEPOSIT_MESSAGE })
  minDeposit?: string | null;
}

/** `PATCH admin/products/:id/groups/:groupId` — a saved group's minimum (0201). */
export class UpdateProductGroupDto {
  @ApiProperty(minDepositDoc)
  @ValidateIf((_o, value) => value !== null)
  @Matches(MIN_DEPOSIT, { message: MIN_DEPOSIT_MESSAGE })
  minDeposit: string | null;
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
      'True when some product already sells it. Informational since 0142 — a group may back ' +
      'several products — so the form notes it rather than refusing it.',
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

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'الوكالة الذهبية',
    description: 'The name in Arabic (0179); null = not translated, show `name`.',
  })
  nameAr: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Read by an applicant deciding which agency to request. Worth writing well.',
  })
  description: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The description in Arabic (0179); null = not translated, show `description`.',
  })
  descriptionAr: string | null;

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

  /** A PUT that omits it keeps the stored Arabic; null or blank clears it. */
  @OptionalArabicText(80, 'الوكالة الذهبية')
  nameAr?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  /** A PUT that omits it keeps the stored Arabic; null or blank clears it. */
  @OptionalArabicText(2000)
  descriptionAr?: string | null;

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

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'الوكالة الذهبية',
    description: 'The name in Arabic (0179); null = not translated, show `name`.',
  })
  nameAr: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  description: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The description in Arabic (0179); null = not translated, show `description`.',
  })
  descriptionAr: string | null;

  @ApiProperty({
    type: [String],
    example: ['Standard', 'ECN'],
    description: 'Product NAMES, not ids — the applicant is reading, not selecting.',
  })
  products: string[];

  @ApiProperty({
    type: 'array',
    items: { type: 'string', nullable: true },
    example: ['قياسي', null],
    description:
      'The same products in Arabic (0179), index for index with `products`; a null item is ' +
      'untranslated — show that index of `products`.',
  })
  productsAr: (string | null)[];
}
