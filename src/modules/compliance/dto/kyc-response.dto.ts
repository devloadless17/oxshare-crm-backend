import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// Response DTOs for the client-facing KYC surface.
//
// `KycController` carried no @ApiOkResponse, so the portal hand-wrote
// `KycStepConfig` in components/kyc/DynamicStepRenderer.tsx. Worse, a now-deleted
// lib/api/kyc.ts invented a *different* field shape for three /compliance/*
// routes that never existed, and returned hardcoded fields when they 404'd.
//
// Shapes transcribed from the live responses.

const KYC_FIELD_TYPES = ['text', 'date', 'phone', 'select', 'file', 'camera', 'checkbox'] as const;

const KYC_STATUSES = [
  'not_started',
  'in_progress',
  'submitted',
  'under_review',
  'approved',
  'rejected',
] as const;

export class KycFieldConfigDto {
  @ApiProperty({ example: 'f-1' }) id: string;
  @ApiProperty({ description: 'Machine name the portal submits.', example: 'firstName' })
  name: string;
  @ApiProperty({ example: 'First Name' }) label: string;
  @ApiProperty({ enum: KYC_FIELD_TYPES }) type: (typeof KYC_FIELD_TYPES)[number];
  @ApiProperty() required: boolean;
  @ApiPropertyOptional({ type: [String], description: 'Choices, for type: select.' })
  options?: string[];
  @ApiPropertyOptional({ example: 'As on your ID' }) hint?: string;
}

/**
 * One onboarding step. `GET /kyc/config` returns a bare **array** of these,
 * already filtered to `enabled`, ordered by `stepNumber`.
 *
 * An empty array is not a valid "no config" state to render — the portal must
 * treat a failed fetch as an error, never as a form with no fields.
 */
export class KycStepConfigDto {
  @ApiProperty({ example: 'step-1' }) id: string;
  @ApiProperty({ example: 1 }) stepNumber: number;
  @ApiProperty({
    description: 'Submitted as the `step` key on POST /kyc/step.',
    example: 'personal',
  })
  slug: string;
  @ApiProperty({ example: 'Personal Information' }) title: string;
  @ApiPropertyOptional() description?: string;
  @ApiPropertyOptional({ description: 'lucide icon name.', example: 'User' }) icon?: string;
  @ApiProperty() enabled: boolean;
  @ApiProperty({ type: [KycFieldConfigDto] }) fields: KycFieldConfigDto[];
}

export class KycDocumentStateDto {
  @ApiPropertyOptional({ example: 'passport' }) docType?: string;
  @ApiPropertyOptional() frontFilePath?: string;
  @ApiPropertyOptional() frontFileName?: string;
  @ApiPropertyOptional() backFilePath?: string;
  @ApiPropertyOptional() backFileName?: string;
}

export class KycFileStateDto {
  @ApiPropertyOptional() filePath?: string;
  @ApiPropertyOptional() fileName?: string;
  @ApiPropertyOptional({ example: 'utility_bill' }) docType?: string;
  @ApiPropertyOptional({ description: 'Second page, for multi-page address proof.' })
  page2FilePath?: string;
}

export class KycStatusDto {
  @ApiProperty() userId: string;
  @ApiProperty({ enum: KYC_STATUSES }) status: (typeof KYC_STATUSES)[number];

  @ApiPropertyOptional({
    description: 'Free-form key/value bag whose keys come from the step configuration.',
    type: 'object',
    additionalProperties: true,
  })
  personalInfo?: Record<string, unknown>;

  @ApiPropertyOptional({ type: KycDocumentStateDto }) document?: KycDocumentStateDto;
  @ApiPropertyOptional({ type: KycFileStateDto }) selfie?: KycFileStateDto;
  @ApiPropertyOptional({ type: KycFileStateDto }) addressProof?: KycFileStateDto;

  @ApiPropertyOptional({ description: 'Set when status is rejected.' }) rejectionReason?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Field names the client must re-submit.',
  })
  rejectedFields?: string[];

  @ApiPropertyOptional() submittedAt?: Date;
  @ApiPropertyOptional() reviewedBy?: string;
  @ApiPropertyOptional() reviewedAt?: Date;
  @ApiProperty() createdAt: Date;
}
