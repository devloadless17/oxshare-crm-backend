import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { NoClientFields } from '../../../common/security/client-field.decorator';

/*
 * ── A client's DOCUMENTS, in one list (owner, 29 Sep 2026) ───────────────────
 *
 * The profile's Documents tab: every file the client has handed the platform —
 * identity documents, proof of address, the selfie, a broker's own KYC uploads,
 * and the receipts attached to offline deposits — each with where it stands.
 *
 * The statuses are the SOURCES', translated to one vocabulary, never a second
 * decision: a KYC version reads its review outcome, a receipt reads its
 * deposit's state — so a receipt on a rejected deposit reads REJECTED.
 */

export const CLIENT_DOCUMENT_CATEGORIES = [
  'identity',
  'address',
  'selfie',
  'kyc_other',
  'deposit_receipt',
] as const;
export type ClientDocumentCategory = (typeof CLIENT_DOCUMENT_CATEGORIES)[number];

export const CLIENT_DOCUMENT_STATUSES = [
  'draft',
  'pending',
  'approved',
  'rejected',
  'reverification_requested',
] as const;
export type ClientDocumentStatus = (typeof CLIENT_DOCUMENT_STATUSES)[number];

@NoClientFields('a file reference inside an already scoped client record, not a client attribute')
export class ClientDocumentFileDto {
  @ApiProperty({ example: 'Identity document — first page' }) label: string;
  @ApiProperty({
    example: 'uploads/kyc/2f0c….jpg',
    description:
      'Opened through GET /v1/<path>, which checks the reader against the file and audits it.',
  })
  path: string;
}

@NoClientFields('a document record inside an already scoped client record, not a client attribute')
export class ClientDocumentDto {
  @ApiProperty({ description: 'The KYC version id, or the deposit transaction id.' })
  id: string;

  @ApiProperty({ enum: CLIENT_DOCUMENT_CATEGORIES })
  category: ClientDocumentCategory;

  @ApiProperty({ example: 'Identity document', description: 'What the document is.' })
  title: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Passport',
    description: 'The document type, or for a receipt the deposit it proves.',
  })
  detail: string | null;

  @ApiProperty({
    enum: CLIENT_DOCUMENT_STATUSES,
    description:
      'KYC: draft (not presented) · pending (awaiting review) · approved (verified) · rejected ' +
      '(returned) · reverification_requested. Receipt: its DEPOSIT — pending, approved (credited) ' +
      'or rejected (refused or failed).',
  })
  status: ClientDocumentStatus;

  @ApiProperty({
    description:
      'False for an older KYC version the client has since replaced; always true for a receipt.',
  })
  current: boolean;

  @ApiProperty({ type: [ClientDocumentFileDto] })
  files: ClientDocumentFileDto[];

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Why it was rejected, when the source recorded one (a refused deposit).',
  })
  reason: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'For a receipt: the deposit transaction it belongs to.',
  })
  transactionId: string | null;

  @ApiProperty({ description: 'When it was uploaded (a KYC version) or filed (a deposit).' })
  uploadedAt: Date;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: 'Omar Farah',
    description:
      'The administrator who uploaded a KYC version for the client ("Complete KYC"); null when ' +
      'the client uploaded it, and for a receipt.',
  })
  uploadedByStaff: string | null;
}

@NoClientFields('a list envelope around already scoped document records')
export class ClientDocumentListDto {
  @ApiProperty({ type: [ClientDocumentDto], description: 'Newest first.' })
  items: ClientDocumentDto[];

  @ApiProperty({
    type: [String],
    example: ['deposit_receipt'],
    description:
      'Categories left OUT because the reader lacks the permission that guards those files ' +
      '(KYC: kyc.documents.view or kyc.review; receipts: deposits.proofs.view or ' +
      'deposits.approve), so an empty list is never mistaken for "has none".',
  })
  hidden: ClientDocumentCategory[];
}
