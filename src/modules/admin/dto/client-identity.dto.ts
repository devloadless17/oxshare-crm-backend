import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { NotClientField } from '../../../common/security/client-field.decorator';

/**
 * A client's identity RECORD as the console shows it (identity-core plan,
 * slice 8): every document and selfie they ever presented or are working on,
 * and every verification decision. It describes the record rather than the
 * person — the same stance the profile's `documents` list takes — so nothing
 * here is a maskable client field; the details (name, date of birth, …) stay
 * on the profile, under their masks.
 */

const RECORD =
  'not a client-owned attribute — the identity record describes documents and decisions';

export class ClientIdentityPageDto {
  @ApiProperty({ example: 0 })
  @NotClientField(RECORD)
  part: number;

  @ApiProperty({ example: 'Photo Page' })
  @NotClientField(RECORD)
  label: string;

  @ApiProperty({
    example: 'uploads/kyc/2f0c….jpg',
    description: 'Opened through GET /uploads/kyc/:file, which checks the reader and audits it.',
  })
  @NotClientField(RECORD)
  path: string;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'The name it was uploaded as.',
  })
  @NotClientField(RECORD)
  fileName: string | null;
}

export class ClientIdentityVersionDto {
  @ApiProperty()
  @NotClientField(RECORD)
  id: string;

  @ApiPropertyOptional({ nullable: true, type: String, example: 'passport' })
  @NotClientField(RECORD)
  docType: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, example: 'Passport' })
  @NotClientField(RECORD)
  docLabel: string | null;

  @ApiProperty({
    enum: ['draft', 'awaiting_review', 'verified', 'returned', 'reverification_requested'],
    description:
      'Read from the verification log: a draft; presented and awaiting review; or the outcome ' +
      'of the latest decision that covered it.',
  })
  @NotClientField(RECORD)
  status: 'draft' | 'awaiting_review' | 'verified' | 'returned' | 'reverification_requested';

  @ApiProperty({
    type: [String],
    example: ['doc_back'],
    description: 'Which of its pages that decision returned.',
  })
  @NotClientField(RECORD)
  returnedPages: string[];

  @ApiProperty({ type: String, format: 'date-time' })
  @NotClientField(RECORD)
  createdAt: Date;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    format: 'date-time',
    description: 'When it was presented for review; null for a draft.',
  })
  @NotClientField(RECORD)
  presentedAt: Date | null;

  @ApiProperty({ type: [ClientIdentityPageDto] })
  @NotClientField(RECORD)
  pages: ClientIdentityPageDto[];
}

export class ClientIdentityDocumentDto {
  @ApiProperty({ example: 'identity', description: 'identity | address | selfie | other:<field>' })
  @NotClientField(RECORD)
  slot: string;

  @ApiProperty({ example: 'Identity document' })
  @NotClientField(RECORD)
  label: string;

  @ApiProperty({ type: [ClientIdentityVersionDto], description: 'Newest first.' })
  @NotClientField(RECORD)
  versions: ClientIdentityVersionDto[];
}

export class ClientVerificationDto {
  @ApiProperty()
  @NotClientField(RECORD)
  seq: number;

  @ApiProperty({ enum: ['verified', 'returned', 'reverification_requested'] })
  @NotClientField(RECORD)
  outcome: 'verified' | 'returned' | 'reverification_requested';

  @ApiProperty({ example: 1 })
  @NotClientField(RECORD)
  levelAfter: number;

  @ApiProperty({
    example: 'manual_review',
    description: 'manual_review | legacy | fixture | import | provider',
  })
  @NotClientField(RECORD)
  method: string;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: "The reviewer's email as it was when they decided.",
  })
  @NotClientField(RECORD)
  decidedBy: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  @NotClientField(RECORD)
  reason: string | null;

  @ApiProperty({ type: [String], example: ['doc_front'] })
  @NotClientField(RECORD)
  returnedItems: string[];

  @ApiProperty({
    type: [String],
    example: ['Identity document — first page'],
    description: 'returnedItems as a person reads them, in the same order.',
  })
  @NotClientField(RECORD)
  returnedLabels: string[];

  @ApiProperty({ type: String, format: 'date-time' })
  @NotClientField(RECORD)
  decidedAt: Date;
}

export class ClientIdentityRecordDto {
  @ApiPropertyOptional({
    type: [ClientIdentityDocumentDto],
    description: 'Absent without kyc.documents.view (or kyc.review).',
  })
  @NotClientField(RECORD)
  documents?: ClientIdentityDocumentDto[];

  @ApiPropertyOptional({
    type: [ClientVerificationDto],
    description: 'Newest first. Absent without kyc.view.',
  })
  @NotClientField(RECORD)
  verifications?: ClientVerificationDto[];
}
