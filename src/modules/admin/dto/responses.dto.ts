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
  /*
   * The admin directory rendered a hardcoded "Active" badge for every row,
   * because this field did not exist and the screen showed something rather
   * than nothing. A suspended administrator therefore displayed as active on
   * the one screen an operator would check before trusting an account.
   *
   * Suspension has always been ENFORCED — admin.guard.ts refuses a suspended
   * admin on every request — so the gap was purely in what the API admitted to.
   */
  @ApiProperty({ enum: ['active', 'suspended'] }) status: 'active' | 'suspended';
  @ApiProperty() createdAt: Date;
}

/**
 * `POST /admin/auth/login`, `/admin/auth/refresh`, `/admin/invite/accept`.
 *
 * No tokens in the body, deliberately. The session is set as httpOnly cookies on
 * the same response (PLATFORM-CONVENTIONS R-3.2); returning the tokens here as
 * well would hand JavaScript the exact credential that flag exists to keep away
 * from it, where it lands in browser memory, the network tab, proxy logs and any
 * error-reporting tool the page loads.
 *
 * This is not hypothetical: while these fields existed, an admin app running the
 * previous build kept reading them and writing its own JS-readable
 * `admin_access_token` cookie — so clearing the browser and logging in again
 * recreated the very exposure the migration removed. Removing the fields makes
 * that impossible rather than merely discouraged.
 */
export class AdminLoginResponseDto {
  @ApiProperty({ type: AdminProfileDto }) admin: AdminProfileDto;
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
  @ApiProperty({
    enum: ['not_started', 'in_progress', 'submitted', 'under_review', 'approved', 'rejected'],
  })
  status: string;
  @ApiPropertyOptional() submittedAt?: Date;
  @ApiPropertyOptional() reviewedAt?: Date;
  @ApiPropertyOptional() reviewedBy?: string;
  @ApiPropertyOptional() rejectionReason?: string;
  @ApiPropertyOptional({ type: [String] }) rejectedFields?: string[];
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  personalInfo?: Record<string, string>;
  @ApiPropertyOptional({ type: KycDocumentDto }) document?: KycDocumentDto;
  @ApiPropertyOptional({ type: KycSelfieDto }) selfie?: KycSelfieDto;
  @ApiPropertyOptional({ type: KycAddressProofDto })
  addressProof?: KycAddressProofDto;
  @ApiPropertyOptional({ type: KycUserDto, nullable: true })
  user?: KycUserDto | null;
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
  /**
   * Pass back as `?cursor=` for the next page; `null` on the last (R-2.4).
   *
   * This, not `total`, is what says whether there is more — counting is a full
   * scan of the filtered set and is only performed on request.
   */
  @ApiProperty({ type: String, nullable: true })
  nextCursor: string | null;

  @ApiPropertyOptional({
    description: 'Only when ?withTotal=true. Counting 219,000 rows is a full scan.',
  })
  total?: number;
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
  /*
   * `token` used to be declared here and is NOT returned by the service — the
   * raw token goes to the invitee's mailbox and nowhere else, deliberately, so
   * it cannot land in proxy logs or SPA memory. A response DTO that advertises
   * a credential the API does not send is worse than noise: both frontends
   * generate their types from this file, so it invited someone to read it.
   */
  @ApiPropertyOptional({
    description:
      'The accept link, echoed OUTSIDE PRODUCTION ONLY to keep local development ' +
      'workable. Absent in production — read the link from the invite email.',
  })
  inviteUrl?: string;
}

/** An invite that has been sent and not yet accepted. Never carries the token. */
export class PendingInviteDto {
  @ApiProperty() id: string;
  @ApiProperty() email: string;
  @ApiProperty() name: string;
  @ApiPropertyOptional() roleId?: string;
  @ApiProperty({ description: 'Admin id of whoever sent it.' }) invitedBy: string;
  @ApiProperty({ description: 'After this the link is dead; re-invite to replace it.' })
  expiresAt: Date;
  @ApiProperty() createdAt: Date;
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
  /**
   * Pass back as `?cursor=` for the next page; `null` on the last (R-2.4).
   *
   * The audit log is append-only and only grows, so it reaches the depth where
   * OFFSET hurts quickly — and a trail with a gap is worse than no trail,
   * because it is believed.
   */
  @ApiProperty({ type: String, nullable: true })
  nextCursor: string | null;
  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
}

export { MessageResponseDto } from '../../../common/dto/message-response.dto';

// ── Money (ARCHITECTURE §6: every monetary field is a STRING) ────────────────

export class WithdrawalUserDto {
  @ApiProperty() id: string;
  @ApiProperty() email: string;
  @ApiProperty() firstName: string;
  @ApiProperty() lastName: string;
}

export class WithdrawalRowDto {
  @ApiProperty() id: string;
  @ApiProperty({
    description: 'Monetary value — always a string, never a number',
  })
  amount: string;
  @ApiProperty({ enum: ['USD', 'USDT'] }) currency: string;
  @ApiProperty({
    enum: ['pending', 'approved', 'success', 'failure', 'rejected'],
  })
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
  /**
   * Pass back as `?cursor=` for the next page; `null` on the last (R-2.4).
   *
   * This, not `total`, is what says whether there is more — counting is a full
   * scan of the filtered set and is only performed on request.
   */
  @ApiProperty({ type: String, nullable: true })
  nextCursor: string | null;

  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'number' } })
  counts: Record<string, number>;
}

// Ledger DTOs live in the wallet module, which owns the ledger domain; admin
// already depends on wallet. Re-exported so the schema names the admin frontend
// aliases from types.gen.ts stay exactly as they were.
export { LedgerEntryDto, LedgerListResponseDto } from '../../wallet/dto/wallet-response.dto';

export class IbProgramDto {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiPropertyOptional({ type: String, nullable: true }) description?: string | null;
  @ApiProperty() position: number;
  @ApiProperty({ enum: ['commission', 'rebate', 'hybrid'] }) mode: string;
  @ApiProperty({ enum: ['spread_share', 'per_lot', 'fixed_per_deal'] })
  method: string;
  @ApiProperty({
    description: 'Percentage or money depending on method — always a string',
  })
  commissionValue: string;
  @ApiProperty({ description: 'Client rebate value — always a string' })
  rebateValue: string;
  @ApiProperty({
    description: 'L1 share of the commission pool, percent as a string',
  })
  l1Share: string;
  @ApiProperty({
    description: 'L2 share of the commission pool, percent as a string',
  })
  l2Share: string;
  @ApiProperty({ description: 'Hours accruals wait before confirming (§12.6)' })
  settlementWindowHours: number;
  @ApiProperty({
    description: 'Credit the client rebate on deal close instead of after the window (§12.8)',
  })
  rebateOnClose: boolean;
  @ApiProperty() selectable: boolean;
  @ApiProperty() active: boolean;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
}

export class IpAllowlistRuleDto {
  @ApiProperty() id: string;
  @ApiProperty({ example: '203.0.113.0/24' }) cidr: string;
  @ApiProperty({ example: 'Beirut office' }) label: string;
  @ApiProperty() createdBy: string;
  @ApiProperty() createdAt: string;
}

export class IpAllowlistStatusDto {
  @ApiProperty({
    description:
      'False while the list is empty. An empty list deliberately means the feature is OFF, ' +
      'so the deploy that adds the table cannot lock every administrator out (RBAC-08).',
  })
  enforced: boolean;

  @ApiProperty({
    description: "The requesting admin's own address, so the UI can warn before a lockout.",
    nullable: true,
    type: String,
  })
  yourIp: string | null;

  @ApiProperty({ type: [IpAllowlistRuleDto] })
  rules: IpAllowlistRuleDto[];
}
