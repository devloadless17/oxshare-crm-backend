import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/* ── Products ─────────────────────────────────────────────────────────────── */

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

export class ProductDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Standard' })
  name: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  description: string | null;

  @ApiProperty({ description: 'A disabled product stops being sold and keeps its accounts.' })
  enabled: boolean;

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

  @ApiProperty({ example: 0, minimum: 0, maximum: 1000 })
  @IsInt()
  @Min(0)
  @Max(1000)
  sortOrder: number;
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

/* ── Agencies ─────────────────────────────────────────────────────────────── */

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

  @ApiProperty({ example: 0, minimum: 0, maximum: 1000 })
  @IsInt()
  @Min(0)
  @Max(1000)
  sortOrder: number;
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
