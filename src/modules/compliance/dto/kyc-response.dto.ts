import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { NoClientFields } from '../../../common/security/client-field.decorator';
import { DOCUMENT_CATALOGUE, documentFieldType } from '../../../common/kyc/document-catalogue';

// Response DTOs for the client-facing KYC surface.
//
// `KycController` carried no @ApiOkResponse, so the portal hand-wrote
// `KycStepConfig` in components/kyc/DynamicStepRenderer.tsx. Worse, a now-deleted
// lib/api/kyc.ts invented a *different* field shape for three /compliance/*
// routes that never existed, and returned hardcoded fields when they 404'd.
//
// Shapes transcribed from the live responses.

/**
 * THE DOCUMENT IS THE INPUT TYPE.
 *
 * `doc:passport` is a field type in the same sense `text` and `date` are: an
 * operator adds a field and picks what it collects. A step offering three ways
 * to prove identity is three fields — one `doc:passport`, one
 * `doc:national_id`, one `doc:driving_license` — which reads in the builder
 * exactly as it reads to the client.
 *
 * The shapes this replaced, in order, and why each fell short:
 *
 *   · a `select` plus two `file` fields — the operator wired three fields
 *     together and the PORTAL held the knowledge of which select governed which
 *     uploads, so a step built by hand could never work;
 *   · one `document` field with an `acceptedDocuments` tick-list — better, but
 *     the documents were a property hidden inside a field rather than the thing
 *     the operator was choosing.
 *
 * The `doc:` prefix keeps the union open. Every entry in
 * `common/kyc/document-catalogue.ts` is a valid type, so adding a residence
 * permit to the catalogue makes it selectable in the builder with no schema
 * change here — which a fixed enum could not do.
 */
const KYC_BASE_FIELD_TYPES = [
  'text',
  'date',
  'phone',
  'select',
  'file',
  'camera',
  'checkbox',
] as const;

const KYC_FIELD_TYPES = [
  ...KYC_BASE_FIELD_TYPES,
  ...DOCUMENT_CATALOGUE.map((doc) => documentFieldType(doc.value)),
] as const;

/**
 * The upload slots one document type needs.
 *
 * ## Why this is not a `sides: 1 | 2` count
 *
 * Researched against Sumsub, Onfido, Persona, Veriff, Jumio, Stripe Identity
 * and Trulioo (Aug 2026). Every one of them models the side as an axis
 * ORTHOGONAL to the document type — Sumsub's `idDocSubType`, Onfido's `side`,
 * Jumio's "parts", Persona's front/back/barcode checkboxes — and none encodes
 * it in the type enum. There is no `ID_CARD_FRONT`.
 *
 * A count cannot carry a label, and the labels are the point: "Photo page" for
 * a passport and "Back" for an ID card are different questions, and a UI given
 * `sides: 2` has to invent both. An ordered array of parts lets the config say
 * exactly what to ask for, and adding a third page or a barcode capture needs
 * no schema change.
 *
 * `required` per part covers the genuinely optional page — a tenancy agreement
 * whose second page is supporting evidence — which is otherwise a second
 * mechanism.
 */
@NoClientFields(
  "the CLIENT's own KYC view in the portal, which carries no admin-maskable projection",
)
export class KycDocumentPartDto {
  @ApiProperty({ description: 'Slot identifier, unique within the type.', example: 'back' })
  key: string;
  @ApiProperty({ description: 'What the client is asked to upload.', example: 'Back Side' })
  label: string;
  @ApiProperty() required: boolean;
  @ApiPropertyOptional({ example: 'Both sides must be readable.' }) hint?: string;
}

/**
 * One choice within a `select` field that governs uploads.
 *
 * The provider survey found this to be the shape everyone converges on and only
 * Sumsub and Jumio publish: the client is offered a set of accepted types, and
 * EACH type declares its own capture requirements. A passport is one page, a
 * national ID is two, a utility bill is one, a tenancy agreement may be several
 * — and no portal can know that without being told.
 */
@NoClientFields(
  "the CLIENT's own KYC view in the portal, which carries no admin-maskable projection",
)
export class KycDocumentTypeDto {
  @ApiProperty({ description: 'Stored in document.docType. Never renamed.', example: 'passport' })
  value: string;
  @ApiProperty({ example: 'Passport' }) label: string;
  @ApiProperty({ enum: ['identity', 'address'] }) category: 'identity' | 'address';
  @ApiProperty({ type: [KycDocumentPartDto] }) parts: KycDocumentPartDto[];
}

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
  /**
   * Present when this `select` chooses a DOCUMENT rather than a plain value.
   *
   * `options` says what may be picked; this says what each choice then requires
   * the client to upload. The two are not redundant — a nationality select has
   * options and no documents — so a field carrying this is what tells the
   * portal to render upload slots underneath.
   */
  /**
   * The catalogue entry a `doc:*` field collects, resolved from its `type`.
   *
   * Served so the portal needs no second request and cannot disagree about what
   * a passport requires. READ-ONLY — the type is the only stored fact, and a
   * posted `document` is ignored, so a client cannot declare that a passport
   * needs no upload.
   */
  @ApiPropertyOptional({
    type: KycDocumentTypeDto,
    description: 'Resolved from the field type. Read-only — writes are ignored.',
  })
  document?: KycDocumentTypeDto;
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

  /**
   * The client's own answers to steps beyond the four canonical ones.
   *
   * Returned to the CLIENT, not only to a reviewer, because the portal reseeds
   * a half-filled step from it: without it a custom step renders and saves
   * correctly and comes back empty, so somebody who filled half of it and
   * returned would retype their own answers — and on the last step would submit
   * a form they believed they had finished.
   */
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'object', additionalProperties: { type: 'string' } },
    description: 'Answers for configured steps beyond the four canonical ones, keyed by slug.',
  })
  stepData?: Record<string, Record<string, string | { filePath: string; fileName: string }>>;

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
