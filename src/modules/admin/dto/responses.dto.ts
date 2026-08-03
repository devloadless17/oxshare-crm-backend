import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

// Response DTOs so /api/docs-json carries response schemas (API-CONTRACTS
// Part C). Both frontends generate TypeScript types from the Swagger JSON —
// keep these in sync with what the services actually return.

export class AdminProfileDto {
  @ApiProperty() id: string;
  @ApiProperty() email: string;
  @ApiProperty() name: string;
  @ApiProperty({ enum: ['master_admin', 'sub_admin'] }) role: 'master_admin' | 'sub_admin';
  @ApiProperty({ type: [String] }) permissions: string[];
  @ApiPropertyOptional() roleId?: string;
  @ApiProperty() createdAt: Date;
}

export class AdminLoginResponseDto {
  @ApiProperty({ type: AdminProfileDto }) admin: AdminProfileDto;
  @ApiProperty() accessToken: string;
  @ApiProperty() refreshToken: string;
}

export class KycUserDto {
  @ApiProperty() id: string;
  @ApiProperty() email: string;
  @ApiProperty() firstName: string;
  @ApiProperty() lastName: string;
}

export class KycDocumentDto {
  @ApiPropertyOptional() docType?: string;
  @ApiPropertyOptional() frontFilePath?: string;
  @ApiPropertyOptional() backFilePath?: string;
  @ApiPropertyOptional() frontFileName?: string;
  @ApiPropertyOptional() backFileName?: string;
}

export class KycSelfieDto {
  @ApiPropertyOptional() filePath?: string;
  @ApiPropertyOptional() fileName?: string;
}

export class KycAddressProofDto {
  @ApiPropertyOptional() docType?: string;
  @ApiPropertyOptional() filePath?: string;
  @ApiPropertyOptional() fileName?: string;
  @ApiPropertyOptional() page2FilePath?: string;
  @ApiPropertyOptional() page2FileName?: string;
}

export class KycSubmissionDto {
  @ApiProperty() userId: string;
  @ApiProperty({ enum: ['not_started', 'in_progress', 'submitted', 'under_review', 'approved', 'rejected'] })
  status: string;
  @ApiPropertyOptional() submittedAt?: Date;
  @ApiPropertyOptional() reviewedAt?: Date;
  @ApiPropertyOptional() reviewedBy?: string;
  @ApiPropertyOptional() rejectionReason?: string;
  @ApiPropertyOptional({ type: [String] }) rejectedFields?: string[];
  @ApiPropertyOptional({ type: 'object', additionalProperties: { type: 'string' } })
  personalInfo?: Record<string, string>;
  @ApiPropertyOptional({ type: KycDocumentDto }) document?: KycDocumentDto;
  @ApiPropertyOptional({ type: KycSelfieDto }) selfie?: KycSelfieDto;
  @ApiPropertyOptional({ type: KycAddressProofDto }) addressProof?: KycAddressProofDto;
  @ApiPropertyOptional({ type: KycUserDto, nullable: true }) user?: KycUserDto | null;
}

export class KycListResponseDto {
  @ApiProperty({ type: [KycSubmissionDto] }) items: KycSubmissionDto[];
  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'number' } })
  counts: Record<string, number>;
}

export class ClientRowDto {
  @ApiProperty() id: string;
  @ApiProperty() email: string;
  @ApiProperty() firstName: string;
  @ApiProperty() lastName: string;
  @ApiProperty({ enum: ['individual', 'referral', 'partner'] }) type: string;
  @ApiProperty({ enum: ['active', 'pending', 'suspended'] }) status: string;
  @ApiProperty({ enum: [0, 1] }) verificationLevel: number;
  @ApiPropertyOptional() country?: string;
  @ApiProperty() createdAt: Date;
}

export class ClientListResponseDto {
  @ApiProperty({ type: [ClientRowDto] }) items: ClientRowDto[];
  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
}

export class RoleResponseDto {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiPropertyOptional() description?: string;
  @ApiProperty({ type: [String] }) permissions: string[];
  @ApiProperty() isSystem: boolean;
  @ApiProperty() createdAt: Date;
}

export class RejectionReasonResponseDto {
  @ApiProperty() id: string;
  @ApiProperty({ enum: ['kyc', 'withdrawal'] }) context: string;
  @ApiProperty() label: string;
  @ApiProperty() createdAt: Date;
}

export class PermissionItemDto {
  @ApiProperty() key: string;
  @ApiProperty() label: string;
}

export class PermissionModuleDto {
  @ApiProperty() moduleName: string;
  @ApiProperty() description: string;
  @ApiProperty({ type: [PermissionItemDto] }) permissions: PermissionItemDto[];
}

export class InviteResponseDto {
  @ApiProperty() message: string;
  @ApiProperty({ description: 'Dev only — removed in production' }) token: string;
  @ApiProperty() inviteUrl: string;
}

export class AuditEntryDto {
  @ApiProperty() id: string;
  @ApiProperty() actorId: string;
  @ApiProperty() actorEmail: string;
  @ApiProperty() action: string;
  @ApiProperty() subjectType: string;
  @ApiProperty() subjectId: string;
  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  details?: Record<string, unknown>;
  @ApiProperty() createdAt: Date;
}

export class AuditListResponseDto {
  @ApiProperty({ type: [AuditEntryDto] }) items: AuditEntryDto[];
  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
}

export class MessageResponseDto {
  @ApiProperty() message: string;
}

// ── Money (ARCHITECTURE §6: every monetary field is a STRING) ────────────────

export class WithdrawalUserDto {
  @ApiProperty() id: string;
  @ApiProperty() email: string;
  @ApiProperty() firstName: string;
  @ApiProperty() lastName: string;
}

export class WithdrawalRowDto {
  @ApiProperty() id: string;
  @ApiProperty({ description: 'Monetary value — always a string, never a number' })
  amount: string;
  @ApiProperty({ enum: ['USD', 'USDT'] }) currency: string;
  @ApiProperty({ enum: ['pending', 'approved', 'success', 'failure', 'rejected'] })
  state: string;
  @ApiProperty() provider: string;
  @ApiPropertyOptional({ type: String, nullable: true }) providerRef?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) destination?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) rejectionReason?: string | null;
  @ApiProperty() requestedAt: Date;
  @ApiPropertyOptional({ type: Date, nullable: true }) reviewedAt?: Date | null;
  @ApiPropertyOptional({ type: Date, nullable: true }) settledAt?: Date | null;
  @ApiProperty({ type: WithdrawalUserDto }) user: WithdrawalUserDto;
}

export class WithdrawalListResponseDto {
  @ApiProperty({ type: [WithdrawalRowDto] }) items: WithdrawalRowDto[];
  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'number' } })
  counts: Record<string, number>;
}

export class LedgerEntryDto {
  @ApiProperty() id: string;
  @ApiProperty() walletId: string;
  @ApiProperty() userId: string;
  @ApiProperty({ description: 'Signed monetary value as a string' }) amount: string;
  @ApiProperty({ description: 'Running balance after this entry, as a string' })
  balanceAfter: string;
  @ApiProperty({ enum: ['deposit', 'withdrawal', 'commission', 'rebate', 'payout', 'adjustment'] })
  entryType: string;
  @ApiProperty() referenceType: string;
  @ApiProperty() referenceId: string;
  @ApiProperty({ enum: ['USD', 'USDT'] }) currency: string;
  @ApiProperty() createdAt: Date;
}

export class LedgerListResponseDto {
  @ApiProperty({ type: [LedgerEntryDto] }) items: LedgerEntryDto[];
  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
}

export class IbProgramDto {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiPropertyOptional({ type: String, nullable: true }) description?: string | null;
  @ApiProperty() position: number;
  @ApiProperty({ enum: ['commission', 'rebate', 'hybrid'] }) mode: string;
  @ApiProperty({ enum: ['spread_share', 'per_lot', 'fixed_per_deal'] }) method: string;
  @ApiProperty({ description: 'Percentage or money depending on method — always a string' })
  commissionValue: string;
  @ApiProperty({ description: 'Client rebate value — always a string' }) rebateValue: string;
  @ApiProperty({ description: 'L1 share of the commission pool, percent as a string' })
  l1Share: string;
  @ApiProperty({ description: 'L2 share of the commission pool, percent as a string' })
  l2Share: string;
  @ApiProperty({ description: 'Hours accruals wait before confirming (§12.6)' })
  settlementWindowHours: number;
  @ApiProperty({ description: 'Credit the client rebate on deal close instead of after the window (§12.8)' })
  rebateOnClose: boolean;
  @ApiProperty() selectable: boolean;
  @ApiProperty() active: boolean;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}
