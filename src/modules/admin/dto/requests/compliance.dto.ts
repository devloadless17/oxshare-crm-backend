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

// Request DTOs for the KYC review + step-configurator surface.
// See the note in ./auth.dto.ts for why these moved out of the controller.

const KYC_FIELD_TYPES = ['text', 'date', 'phone', 'select', 'file', 'camera', 'checkbox'] as const;

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
