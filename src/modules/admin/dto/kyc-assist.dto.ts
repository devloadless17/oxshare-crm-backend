import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ClientField,
  ClientFieldMap,
  NoClientFields,
  NotClientField,
} from '../../../common/security/client-field.decorator';
import { PROFILE_FIELD_KEYS } from '../../../common/profile/client-profile';
import { KycOwedDto } from '../../compliance/dto/kyc-response.dto';

/*
 * "Complete KYC" (0210) — the page staff fill a client's KYC on, laid out by
 * the server (`compliance/kyc-assist-view.ts`). The layout classes describe
 * the FORM — its questions, documents and upload slots — and never hold an
 * answer: the answers travel in `personalInfo` and `stepData`, the two maps
 * RBAC-03 already masks on the review page, marked the same way here.
 */

const LAYOUT = "the KYC form's layout - questions, documents and upload slots, never an answer";

@NoClientFields(LAYOUT)
export class KycAssistTargetDto {
  @ApiProperty({ description: 'Send back as `field` on the upload.', example: 'doc_back' })
  field: string;
  @ApiPropertyOptional({
    description: 'Send back as `docType` on the upload.',
    example: 'passport',
  })
  docType?: string;
}

@NoClientFields(LAYOUT)
export class KycAssistUploadDto {
  @ApiProperty({ type: KycAssistTargetDto }) target: KycAssistTargetDto;
  @ApiPropertyOptional({
    description: 'The file on file — a stored-document reference, never its contents.',
    example: 'uploads/kyc/1f0c….jpg',
  })
  filePath?: string;
  @ApiProperty({ description: 'The reviewer returned it and it has not been replaced.' })
  returned: boolean;
}

@NoClientFields(LAYOUT)
export class KycAssistSelfieDto extends KycAssistUploadDto {
  @ApiProperty({ description: 'The broker made the selfie optional.' }) optional: boolean;
}

@NoClientFields(LAYOUT)
export class KycAssistPageDto extends KycAssistUploadDto {
  @ApiProperty({ example: 'back' }) key: string;
  @ApiProperty({ example: 'Back Side' }) label: string;
  @ApiProperty() required: boolean;
  @ApiPropertyOptional() hint?: string;
}

@NoClientFields(LAYOUT)
export class KycAssistDocumentTypeDto {
  @ApiProperty({ example: 'national_id' }) value: string;
  @ApiProperty({ example: 'National ID' }) label: string;
  @ApiProperty({ type: [KycAssistPageDto] }) pages: KycAssistPageDto[];
}

@NoClientFields(LAYOUT)
export class KycAssistDocumentDto {
  @ApiProperty({ enum: ['identity', 'address'] }) category: 'identity' | 'address';
  @ApiPropertyOptional({ description: 'The document on file, or chosen with nothing uploaded.' })
  docType?: string;
  @ApiProperty({ description: 'The broker made this evidence optional.' }) optional: boolean;
  @ApiProperty({ type: [KycAssistDocumentTypeDto], description: 'The types the broker accepts.' })
  types: KycAssistDocumentTypeDto[];
}

@NoClientFields(LAYOUT)
export class KycAssistFieldDto {
  @ApiProperty({ example: 'dateOfBirth' }) name: string;
  @ApiProperty({ example: 'Date of Birth' }) label: string;
  @ApiProperty({
    example: 'date',
    description: 'text, date, phone, select, checkbox, file, camera.',
  })
  type: string;
  @ApiProperty() required: boolean;
  @ApiPropertyOptional({ type: [String] }) options?: string[];
  @ApiPropertyOptional() hint?: string;
  @ApiPropertyOptional({ description: "One of the client's identity details (their profile)." })
  system?: boolean;
  @ApiProperty({ description: "Hidden from this reader's role: shown as hidden, never sent." })
  hidden: boolean;
  @ApiPropertyOptional({ type: KycAssistUploadDto, description: 'For an upload question.' })
  upload?: KycAssistUploadDto;
}

@NoClientFields(LAYOUT)
export class KycAssistStepDto {
  @ApiProperty({ example: 'document' }) slug: string;
  @ApiProperty({ example: 'Identity Document' }) title: string;
  @ApiPropertyOptional() description?: string;
  @ApiProperty({ description: 'Nothing owed and nothing returned that blocks.' })
  complete: boolean;
  @ApiProperty({ type: [KycOwedDto], description: 'What is still needed, in step order.' })
  missing: KycOwedDto[];
  @ApiProperty({ type: [KycOwedDto], description: 'What the reviewer returned, still unanswered.' })
  returned: KycOwedDto[];
  @ApiProperty({ type: [KycAssistFieldDto] }) fields: KycAssistFieldDto[];
  @ApiPropertyOptional({ type: KycAssistDocumentDto }) document?: KycAssistDocumentDto;
  @ApiPropertyOptional({ type: KycAssistSelfieDto }) selfie?: KycAssistSelfieDto;
}

export class KycAssistViewDto {
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty({ type: 'integer', description: 'The Portal ID.' })
  userId: number;

  @NotClientField('a lifecycle state the desk acts on, not client-owned data')
  @ApiProperty({
    enum: ['not_started', 'in_progress', 'submitted', 'under_review', 'approved', 'rejected'],
  })
  status: string;

  @NotClientField('a property of the record: whether it may still be changed')
  @ApiProperty({ description: 'Open: not waiting for review and not approved.' })
  editable: boolean;

  @NotClientField("the judge's verdict on the record, not client-owned data")
  @ApiProperty({ description: 'Every step has what it needs — Submit would be accepted.' })
  complete: boolean;

  @NotClientField('a lifecycle state the desk acts on, not client-owned data')
  @ApiProperty({
    description:
      "The client's account is suspended: nothing here may change until it is reactivated.",
  })
  suspended: boolean;

  @NotClientField('not a client-owned attribute - the reason describes the record')
  @ApiPropertyOptional()
  rejectionReason?: string;

  @NotClientField('a timestamp the system recorded, describing the record rather than the client')
  @ApiPropertyOptional({ type: Date })
  reverificationRequestedAt?: Date;

  @NotClientField('a timestamp the system recorded, describing the record rather than the client')
  @ApiPropertyOptional({ type: Date })
  submittedAt?: Date;

  @NotClientField('an ADMINISTRATOR attribute - who submitted it for the client, never a client')
  @ApiPropertyOptional({ type: String, nullable: true })
  submittedByName?: string | null;

  @NotClientField(LAYOUT)
  @ApiProperty({ type: [KycAssistStepDto] })
  steps: KycAssistStepDto[];

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string' },
    description:
      "The personal step's answers — the client's identity details and its own questions.",
  })
  @ClientFieldMap('kyc.personalInfo', { others: 'kyc.stepData', named: PROFILE_FIELD_KEYS })
  personalInfo?: Record<string, string>;

  @ClientField('kyc.stepData')
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'object', additionalProperties: true },
    description:
      "Every other step's answers by slug, then field name: a string, or `{ filePath }` for an upload.",
  })
  stepData?: Record<string, Record<string, string | { filePath: string }>>;

  @NotClientField('the mask reporting on ITSELF, so the screen can say hidden rather than empty')
  @ApiPropertyOptional({ type: [String] })
  maskedFields?: string[];
}
