import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import type { RejectionContext } from '../../../../store/rejection-reasons.store';
import type { KycDocumentType } from '../../../../store/kyc-config.store';
import { DOCUMENT_CATALOGUE, documentFieldType } from '../../../../common/kyc/document-catalogue';

// Request DTOs for the KYC review + step-configurator surface.
// See the note in ./auth.dto.ts for why these moved out of the controller.

const KYC_BASE_FIELD_TYPES = [
  'text',
  'date',
  'phone',
  'select',
  'file',
  'camera',
  'checkbox',
] as const;

/**
 * ⚠️ THE DOCUMENT TYPES BELONG HERE TOO, and their absence made the KYC step
 * builder unable to save at all.
 *
 * `kyc-config.store.ts` defines a field type as "a base type, or `doc:<value>`
 * for a document", and SEEDS exactly that — `doc:passport`, `doc:national_id`,
 * `doc:driving_license`, `doc:utility_bill`. GET returns them. This list did not
 * contain them, so a pure read-modify-write round trip — which is precisely what
 * the builder performs, `steps = draft ?? query.data` with no transform — came
 * back 400 VALIDATION_FAILED on every save.
 *
 * The screen reported success and nothing persisted. It was invisible because
 * the jsdom page tests mock `api.put`, so the request shape was never checked
 * against this DTO, and no browser spec clicked Save until one was written.
 *
 * DERIVED FROM THE CATALOGUE rather than hand-listed, which is what the response
 * DTO has always done (`kyc-response.dto.ts`) and what the store's own docblock
 * asks for: "the catalogue defines the document half, so a union here would have
 * to be regenerated every time one is added". Computed, so adding a document
 * cannot leave this behind again.
 */
const KYC_FIELD_TYPES = [
  ...KYC_BASE_FIELD_TYPES,
  ...DOCUMENT_CATALOGUE.map((doc) => documentFieldType(doc.value)),
] as const;

const REJECTION_CONTEXTS = ['kyc', 'withdrawal'] as const;

export class RejectDto {
  @ApiPropertyOptional({ description: 'Free-text reason, when not using a configured reasonId.' })
  @IsString()
  @IsOptional()
  reason?: string;

  @ApiPropertyOptional({ description: 'Id of a configured rejection reason.' })
  @IsString()
  @IsOptional()
  reasonId?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Field names the client must re-submit, e.g. ["doc_front"].',
  })
  @IsArray()
  @IsOptional()
  rejectedFields?: string[];
}

export class RejectionReasonDto {
  @ApiProperty({ enum: REJECTION_CONTEXTS })
  @IsIn(REJECTION_CONTEXTS)
  context: RejectionContext;

  @ApiProperty({ example: 'Document expired' })
  @IsString()
  label: string;
}

export class KycFieldDto {
  @ApiProperty()
  @IsString()
  id: string;

  @ApiProperty({ description: 'Machine name submitted by the portal.', example: 'firstName' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ example: 'First Name' })
  @IsString()
  @IsNotEmpty()
  label: string;

  // Explicit enum, not an inferred `string`: the portal renders a different
  // input per type, so a widened type here would let a typo through to the UI.
  @ApiProperty({ enum: KYC_FIELD_TYPES })
  @IsIn(KYC_FIELD_TYPES)
  type: (typeof KYC_FIELD_TYPES)[number];

  @ApiProperty()
  @IsBoolean()
  required: boolean;

  @ApiPropertyOptional({ type: [String], description: 'Choices, for type: select.' })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  options?: string[];

  @ApiPropertyOptional({ example: 'As shown on your ID' })
  @IsString()
  @IsOptional()
  hint?: string;

  /**
   * ACCEPTED AND IGNORED. The GET hydrates every document field with
   * `{ value, label, category, parts[] }`, resolved from `type` when serving and
   * explicitly NOT persisted — the store says so: "the type is the only stored
   * fact".
   *
   * Declared here so the global `whitelist` pipe does not answer "property
   * document should not exist" to a client that sent back exactly what it was
   * given. An API whose GET output its own PUT refuses is a trap for every
   * consumer, not just the builder that found it.
   *
   * Not read by anything: `type` remains the single stored fact, so sending a
   * `document` that disagrees with the type changes nothing.
   */
  @ApiPropertyOptional({
    description: 'Hydrated from `type` on read. Accepted on write and ignored.',
  })
  @IsOptional()
  document?: KycDocumentType;
}

export class KycStepDto {
  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  id?: string;

  @ApiPropertyOptional({ description: 'Server-assigned ordering; ignored on create.' })
  @IsInt()
  @IsOptional()
  stepNumber?: number;

  // FR-CORE-15 / FR-IND-03: the portal submits by slug, so 'personal',
  // 'document', 'selfie' and 'address' are mandatory and may not be re-slugged
  // (DECISIONS D-29).
  @ApiProperty({ example: 'personal' })
  @IsString()
  @IsNotEmpty()
  slug: string;

  @ApiProperty({ example: 'Personal Information' })
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ description: 'lucide icon name.', example: 'User' })
  @IsString()
  @IsOptional()
  icon?: string;

  @ApiPropertyOptional()
  @IsBoolean()
  @IsOptional()
  enabled?: boolean;

  @ApiProperty({ type: [KycFieldDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => KycFieldDto)
  fields: KycFieldDto[];
}

/**
 * Body of `PUT /admin/kyc-config`.
 *
 * Note the asymmetry with `GET /admin/kyc-config`, which returns a bare array:
 * this endpoint takes `{ steps }`. The admin app sent the bare array back for a
 * while, which 400'd on every "Save all" — documenting the wrapper here is what
 * makes that visible in the generated types.
 */
export class KycConfigDto {
  @ApiProperty({ type: [KycStepDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => KycStepDto)
  steps: KycStepDto[];
}
