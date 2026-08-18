import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { rejectionContextEnum } from '../../../database/schema';
import type { RejectionContext } from '../../../store/rejection-reasons.store';

// Response DTOs so /api/docs-json carries response schemas (API-CONTRACTS
// Part C). Both frontends generate TypeScript types from the Swagger JSON —
// keep these in sync with what the services actually return.

/** A tag an administrator's client view is restricted to. */
export class AdminScopeTagDto {
  @ApiProperty() tagId: string;
  @ApiProperty() slug: string;
  @ApiProperty() label: string;
}

export class AdminProfileDto {
  @ApiProperty() id: string;
  @ApiProperty() email: string;
  @ApiProperty() name: string;
  @ApiProperty({ enum: ['master_admin', 'sub_admin'] }) role: 'master_admin' | 'sub_admin';
  @ApiProperty({ type: [String] }) permissions: string[];
  @ApiPropertyOptional() roleId?: string;
  /**
   * The role's display name — what the console shows beside the operator's own.
   *
   * `roleId` alone was useless for that: resolving it meant fetching the roles
   * list, which requires `roles.view`, so every administrator without it saw
   * their email address where their job title should be. Absent when the admin
   * is on no role, which is a real state and must not be guessed at.
   */
  @ApiPropertyOptional() roleName?: string;
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

  /**
   * RBAC-03 — the client fields this administrator cannot see RIGHT NOW, role
   * and per-person override already combined.
   *
   * The resolved answer rather than the raw column: a directory row showing
   * "nothing hidden" for somebody whose ROLE hides four fields would be a
   * confident lie, and the row is exactly where an operator checks before
   * trusting an account.
   */
  @ApiProperty({ type: [String] }) maskedFields: string[];

  /**
   * The STORED override — `null` when this administrator follows their role.
   *
   * Distinct from `maskedFields` above, and the edit screen needs both: without
   * this it cannot tell "inherits the role" from "has an identical override",
   * and so could never offer to put somebody back on their role.
   */
  @ApiPropertyOptional({ type: [String], nullable: true })
  maskedFieldsOverride?: string[] | null;

  /**
   * RBAC-03 territory — the client tags this administrator is restricted to.
   *
   * EMPTY MEANS UNRESTRICTED, not "sees nothing" (D-10). Any screen rendering
   * this has to say so in words; it is not inferable from an empty array.
   */
  @ApiProperty({ type: [AdminScopeTagDto] }) scopedTags: AdminScopeTagDto[];

  /**
   * D-60 — sees the intake pool: clients with no tag assignments yet.
   * "Untriaged" is a DERIVED state, not a tag; this grant is the flag beside
   * the territory list. Meaningful only when the admin is scoped.
   */
  @ApiProperty() seesUntriaged: boolean;

  /**
   * The profile photo, on `me` rather than behind a profile endpoint of its
   * own — the sidebar renders it on every page, so a second call would be a
   * round trip per navigation to draw one 32px circle.
   */
  @ApiPropertyOptional({ type: String, nullable: true, example: '/uploads/avatars/6f1c.png' })
  avatarUrl?: string | null;

  /**
   * When this administrator last changed their own password.
   *
   * `null` for every account predating the column, which is NOT "never
   * changed" — the profile screen words it as unknown rather than guessing.
   */
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  passwordChangedAt?: Date | null;

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

/**
 * The client, as a REVIEWER may see them.
 *
 * Mirrors `reviewerView()` in `kyc.service.ts`, which is an allow-list written
 * after spreading the whole record sent every admin the client's password hash.
 *
 * The four required fields are what BOTH endpoints return. The optional ones are
 * returned by `GET /admin/kyc/:userId` and not by the paginated list, which
 * selects a narrower projection in SQL — so they are genuinely absent there
 * rather than merely undocumented.
 *
 * They were missing from this DTO entirely, which meant the API sent them and
 * the contract denied they existed: the admin app could not render "is this
 * email verified" or "how old is this account" without a hand-written type,
 * i.e. without giving up the one mechanism that turns backend drift into a
 * compile error (R-1.1). Those are ordinary fraud signals on a review screen,
 * and the reviewer was being asked to decide without them.
 */
export class KycUserDto {
  @ApiProperty() id: string;
  @ApiProperty() email: string;
  @ApiProperty() firstName: string;
  @ApiProperty() lastName: string;
  @ApiPropertyOptional({ enum: ['individual', 'referral', 'partner'] }) type?: string;
  @ApiPropertyOptional({ enum: ['active', 'pending', 'suspended'] }) status?: string;
  @ApiPropertyOptional({ enum: [0, 1] }) verificationLevel?: number;
  @ApiPropertyOptional() emailVerified?: boolean;
  @ApiPropertyOptional() country?: string;
  @ApiPropertyOptional() phone?: string;
  @ApiPropertyOptional({ type: String, format: 'date-time' }) createdAt?: string;
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

/**
 * One previously DECIDED attempt, as it stood when the decision was made.
 *
 * Not a `KycSubmissionDto`: this is a historical record, so `status` is narrowed
 * to the two terminal values it can actually hold, there is no `user` (the
 * caller already knows whose history they asked for), and `attemptNo` is what
 * makes "the third try" a thing the UI can say.
 */
export class KycAttemptDto {
  @ApiProperty({ description: 'Dense from 1, per client.' }) attemptNo: number;
  @ApiProperty({ enum: ['approved', 'rejected'] }) status: string;
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
  @ApiProperty() archivedAt: Date;
}

export class KycListResponseDto {
  @ApiProperty({ type: [KycSubmissionDto] }) items: KycSubmissionDto[];
  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'number' } })
  counts: Record<string, number>;
}

/** RBAC-03 — one maskable (or deliberately unmaskable) client field. */
export class ClientFieldDto {
  @ApiProperty({ description: 'Path-qualified, e.g. client.email or kyc.personalInfo.phone.' })
  key: string;
  @ApiProperty() label: string;
  @ApiProperty({ description: 'False for fields the admin screens structurally need.' })
  maskable: boolean;
  @ApiPropertyOptional({ description: 'Why an unmaskable field cannot be hidden.' })
  reason?: string;
}

export class ClientFieldGroupDto {
  @ApiProperty() groupName: string;
  @ApiProperty() description: string;
  @ApiProperty({ type: [ClientFieldDto] }) fields: ClientFieldDto[];
}

/** ADM-14 — an arbitrary client label. */
export class ClientTagDto {
  @ApiProperty() id: string;
  @ApiProperty({
    description: 'Stable machine name. Filter with ?tag=<slug>; a rename does not change it.',
  })
  slug: string;
  @ApiProperty() label: string;
  @ApiPropertyOptional() color?: string;
  @ApiPropertyOptional() description?: string;
  @ApiProperty({
    description:
      'A tag the platform itself assigns (new-client intake, D-60). Undeletable; label and ' +
      'colour editable; un-assigning from a client is how they are triaged out of it.',
  })
  isSystem: boolean;
  @ApiProperty() createdAt: Date;
}

export class ClientTagWithCountDto extends ClientTagDto {
  @ApiProperty({ description: 'How many clients carry this tag.' })
  clientCount: number;
}

/**
 * Every field below the id is OPTIONAL, and that is the RBAC-03 wire contract
 * rather than laxity: a field the caller may not see is OMITTED, and the
 * response's `maskedFields` says which. Null already means "no value on file",
 * so overloading it would collapse "hidden from you" into "this client has
 * none" — two answers an operator must be able to tell apart.
 */
export class ClientRowDto {
  @ApiProperty() id: string;
  @ApiPropertyOptional() email?: string;
  @ApiPropertyOptional() firstName?: string;
  @ApiPropertyOptional() lastName?: string;
  @ApiProperty({ enum: ['individual', 'referral', 'partner'] }) type: string;
  @ApiProperty({
    enum: ['active', 'pending', 'suspended'],
    description:
      'The ACCOUNT state, and only that: whether this person may sign in. It is deliberately not a verification state — read `emailVerified` and `kycStatus` for those. "pending" here means the account itself is not yet active, and says nothing about documents.',
  })
  status: string;

  @ApiProperty({
    description:
      'Whether the client confirmed the address they registered with. Separate from KYC: an unconfirmed email is a self-service problem the client can fix, while a KYC decision is work for a reviewer.',
  })
  emailVerified: boolean;

  @ApiProperty({
    enum: ['not_started', 'in_progress', 'submitted', 'under_review', 'approved', 'rejected'],
    description:
      "The client's identity-verification state, joined from kyc_submissions. Total: a client who never began verification reads as 'not_started' rather than null.",
  })
  kycStatus: string;

  @ApiProperty({
    enum: [0, 1],
    description:
      'The verification TIER the account has reached (0 or 1), which gates what the client may do. Not a synonym for `kycStatus`: a rejected submission leaves the level at 0, and the reason lives in the status.',
  })
  verificationLevel: number;

  @ApiPropertyOptional() country?: string;
  @ApiPropertyOptional() createdAt?: Date;
  @ApiPropertyOptional({ type: [ClientTagDto] }) tags?: ClientTagDto[];
}

export class ProfileTradingAccountDto {
  @ApiProperty() id: string;
  @ApiProperty() mt5Login: string;
  @ApiPropertyOptional() mt5Group?: string;
  @ApiProperty({ enum: ['live', 'demo'] }) environment: string;
  @ApiPropertyOptional() tier?: string;
  @ApiPropertyOptional() leverage?: number;
  @ApiProperty() createdAt: Date;
}

export class ProfileReferrerDto {
  @ApiProperty() ibUserId: string;
  @ApiProperty() email: string;
  @ApiProperty() firstName: string;
  @ApiProperty() lastName: string;
  @ApiProperty({ description: 'False when the attribution was switched off.' })
  active: boolean;
  @ApiProperty() since: Date;
}

export class ProfileReferredClientDto {
  @ApiProperty() clientUserId: string;
  @ApiProperty() email: string;
  @ApiProperty() firstName: string;
  @ApiProperty() lastName: string;
  @ApiProperty() active: boolean;
  @ApiProperty() since: Date;
}

export class ProfileKycDto {
  @ApiProperty({ enum: ['none', 'pending', 'in_review', 'approved', 'rejected'] })
  status: string;
  @ApiPropertyOptional() submittedAt?: Date;
  @ApiPropertyOptional() reviewedAt?: Date;
  @ApiPropertyOptional() rejectionReason?: string;
  @ApiProperty({ description: 'How many documents the submission carries.' })
  documentCount: number;
}

/**
 * FR-ADM-01's full client profile.
 *
 * EVERY SECTION IS OPTIONAL, and absence is meaningful in two different ways
 * the frontend must not collapse:
 *
 *   - the key is ABSENT because the caller lacks the permission that section
 *     needs (`kyc.view`, `kyc.documents.view`, `trading.view`, `partners.view`);
 *   - the key is PRESENT and empty because the client genuinely has none.
 *
 * A compliance reviewer shown no documents will conclude none were uploaded, so
 * the screen has to be able to say "hidden by your permissions" instead — which
 * it can only do if these two states arrive differently.
 *
 * `maskedFields` is the third kind of absence: a field the viewer may not see,
 * omitted from the client object with its key listed here.
 */
export class ClientProfileDto {
  @ApiProperty() id: string;
  @ApiPropertyOptional() email?: string;
  @ApiPropertyOptional() firstName?: string;
  @ApiPropertyOptional() lastName?: string;
  @ApiProperty({ enum: ['individual', 'referral', 'partner'] }) type: string;
  @ApiProperty({ enum: ['active', 'pending', 'suspended'] }) status: string;
  @ApiProperty({ enum: [0, 1] }) verificationLevel: number;
  @ApiProperty() emailVerified: boolean;
  @ApiPropertyOptional() country?: string;
  @ApiPropertyOptional() phone?: string;
  @ApiPropertyOptional() createdAt?: Date;

  @ApiProperty({ type: [ClientTagDto] }) tags: ClientTagDto[];

  @ApiPropertyOptional({ type: ProfileKycDto, description: 'Absent without kyc.view.' })
  kyc?: ProfileKycDto;

  @ApiPropertyOptional({
    type: [String],
    description: 'Document filenames. Absent without kyc.documents.view.',
  })
  documents?: string[];

  @ApiPropertyOptional({
    type: [ProfileTradingAccountDto],
    description: 'Absent without trading.view.',
  })
  tradingAccounts?: ProfileTradingAccountDto[];

  @ApiPropertyOptional({ type: ProfileReferrerDto, description: 'Absent without partners.view.' })
  referrer?: ProfileReferrerDto;

  @ApiPropertyOptional({
    type: [ProfileReferredClientDto],
    description: 'Capped — see referredTotal. Absent without partners.view.',
  })
  referredClients?: ProfileReferredClientDto[];

  @ApiPropertyOptional({
    description: 'How many referredClients were returned; the list is capped for one screen.',
  })
  referredShown?: number;

  @ApiProperty({ type: [String] }) maskedFields: string[];
}

export class ClientListResponseDto {
  @ApiProperty({ type: [ClientRowDto] }) items: ClientRowDto[];

  /**
   * The client fields THIS VIEWER cannot see — RBAC-03.
   *
   * A property of the viewer, not of a row: every item in the response carries
   * the same set, so it is sent once here rather than repeated 25 times. The UI
   * uses it to render "hidden by your permissions" instead of an em dash, which
   * is the difference between "you are not allowed to see this" and "this
   * client has not given us one".
   */
  @ApiProperty({ type: [String] })
  maskedFields: string[];
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
  /**
   * RBAC-03 — the client fields holders of this role may not see.
   *
   * On the response because the role editor has to PRE-FILL it: a form that
   * could set a mask but never read one back would silently clear it on the
   * next save of an unrelated field, which is the worst possible shape for a
   * control over who sees client PII.
   */
  @ApiProperty({ type: [String] }) maskedFields: string[];
  @ApiProperty() isSystem: boolean;
  @ApiProperty() createdAt: Date;
}

export class RejectionReasonResponseDto {
  @ApiProperty() id: string;
  /*
   * The enum comes from the SCHEMA, not from a list restated here.
   *
   * This was `['kyc', 'withdrawal']` written out by hand, and it went stale the
   * moment 'partner' was added to `rejection_context` — so both frontends
   * generated a union that could not hold a value the API was already
   * returning, and the admin's own reject dialog would not compile against it.
   * Reading `enumValues` off the column means the next context added is carried
   * into openapi.json without anybody remembering to come here.
   */
  @ApiProperty({ enum: rejectionContextEnum.enumValues })
  context: RejectionContext;
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

/**
 * `GET /admin/invite/validate` — what the accept screen may pre-fill.
 *
 * This route had no response DTO, so it generated into the OpenAPI document
 * with no schema and the admin app hand-declared the shape it expected. That is
 * the one mechanism protecting these two repos from drifting apart
 * (API-CONTRACTS Part C), and this endpoint was outside it.
 *
 * Deliberately narrow: the invitee is UNAUTHENTICATED here — they hold a token
 * and nothing else — so this returns only what the form needs to greet them. It
 * must never grow to carry the permissions or role id the invite confers, which
 * would hand the whole grant to anyone who guessed a token.
 */
export class InviteValidationDto {
  @ApiProperty({ description: 'The address the invite was sent to; the form shows it read-only.' })
  email: string;
  @ApiProperty({ description: 'Used only to greet the invitee by name.' })
  name: string;
  @ApiProperty({
    enum: ['sub_admin'],
    description: 'Always sub_admin — an invite cannot mint a master.',
  })
  role: 'sub_admin';
}

/**
 * `POST /admin/invite/accept` — the account it just created.
 *
 * No tokens in the body, like every other session-establishing response here:
 * the cookies are set on the response and the admin app reads none of them.
 */
export class AcceptInviteResponseDto {
  @ApiProperty({ example: 'Account created. Welcome aboard!' }) message: string;
  @ApiProperty({ type: AdminProfileDto }) admin: AdminProfileDto;
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

/** One entry in the action-filter vocabulary — see audit-actions.catalog.ts. */
export class AuditActionDto {
  @ApiProperty() action: string;
  @ApiProperty() label: string;
  @ApiProperty({ description: 'Groups the filter, so 30+ entries stay readable.' })
  group: string;
}

export class AuditEntryDto {
  @ApiProperty() id: string;
  @ApiProperty() actorId: string;
  @ApiProperty() actorEmail: string;
  /*
   * WHO KIND of actor, and from WHERE. Both were stored, returned by the store,
   * and absent from this contract — so the API sent them and the document
   * denied they existed, which meant the admin screen could not render them
   * without hand-writing a type and giving up the one mechanism that turns
   * backend drift into a compile error (R-1.1).
   *
   * "Which address did this administrator approve the payout from" is a routine
   * question after an incident on a money system, and `audit_log.ip_address`
   * has been populated all along (`AuditLogStore.record` fills it from the
   * request context). It was answerable in SQL and nowhere else.
   */
  @ApiProperty({
    enum: ['admin', 'client', 'system', 'provider'],
    description: 'A background job records as `system`, with a named identity — never anonymously.',
  })
  actorKind: string;
  @ApiPropertyOptional({
    // `type` is not decoration here: without it, `nullable: true` generates as
    // `Record<string, never> | null` in the frontends' types — a shape nothing
    // can render — so the contract would document the field and still be
    // unusable, which is the state this whole change exists to fix.
    type: String,
    nullable: true,
    description:
      'The address the action came from. Null for an action with no request context, such as ' +
      'a scheduled job.',
  })
  ipAddress?: string | null;
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
  // A CODE, not a fixed set — currencies are operator data (see WalletDto).
  @ApiProperty({ description: 'A currency code.', example: 'USD' }) currency: string;
  @ApiProperty({
    enum: ['pending', 'approved', 'success', 'failure', 'rejected'],
  })
  state: string;
  @ApiProperty() provider: string;
  /**
   * What to CALL the payout rail on screen — 'Whish Money'.
   *
   * Resolved server-side from `withdrawal_payment_methods.name`, so a renamed
   * method is renamed everywhere at once and the desk never reads a machine
   * key. NOT optional and never null: it falls back to `provider` for rows
   * written before migration 0062, which named no method — an em dash there
   * would claim money went out through nothing.
   *
   * Deliberately NOT a translated label, for the reason `TransactionDto`
   * records: it is the operator's own name for their own rail — a brand, which
   * does not translate.
   */
  @ApiProperty({ example: 'Whish Money' }) methodName: string;
  @ApiPropertyOptional({ type: String, nullable: true }) providerRef?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) destination?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) rejectionReason?: string | null;
  @ApiProperty() requestedAt: Date;
  @ApiPropertyOptional({ type: Date, nullable: true }) reviewedAt?: Date | null;
  @ApiPropertyOptional({ type: Date, nullable: true }) settledAt?: Date | null;
  /*
   * The Rival payout leg, for the desk's badges. `rivalWithdrawalId` set =
   * submitted and awaiting Rival's decision; `rivalSubmittedAt` without an id
   * = a submission whose outcome is being reconciled (do not resubmit);
   * `rivalNeedsAttention` = a human must look — submission refused, or the
   * two platforms' terminal states disagree.
   */
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'The payment platform’s withdrawal id, once submitted. Null before.',
  })
  rivalWithdrawalId?: string | null;
  @ApiPropertyOptional({
    type: Date,
    nullable: true,
    description: 'When the submission claim was taken. Set with no id = outcome being reconciled.',
  })
  rivalSubmittedAt?: Date | null;
  @ApiProperty({
    description: 'A human must reconcile this row against the payment platform.',
  })
  rivalNeedsAttention: boolean;
  @ApiPropertyOptional({
    type: 'string',
    nullable: true,
    description:
      'WHY the row needs attention, in words the operator can act on. Written whenever ' +
      'rivalNeedsAttention flips true; null once a retry lands or the flag was never raised.',
  })
  rivalAttentionReason?: string | null;
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

// ── Client holdings: wallets and trading accounts ───────────────────────────
//
// Both carry a `NUMERIC(28,8)` balance, and both declare it as a STRING with an
// example that says so. `@ApiProperty({ type: 'string' })` is not decoration
// here: it is what makes the generated frontend type say `string`, which is
// what stops a screen writing `Number(balance)` and being wrong past the eighth
// decimal place (ARCHITECTURE §6.1, and the admin app's own money lint rule).

/** The owner a holding is displayed against. Joined, never fetched per row. */
export class HoldingOwnerDto {
  @ApiProperty() id: string;
  @ApiProperty() email: string;
  @ApiProperty() firstName: string;
  @ApiProperty() lastName: string;
}

export class WalletRowDto {
  @ApiProperty() id: string;
  @ApiProperty({
    type: 'string',
    example: '250.00000000',
    description:
      'Monetary value — ALWAYS a string, never a number. NUMERIC(28,8) exceeds what a ' +
      'JavaScript number represents exactly, so Number()/parseFloat lose value before any ' +
      'formatting starts (§6.1).',
  })
  balance: string;
  @ApiProperty({
    type: 'string',
    example: '0.00000000',
    description:
      'Reserved against a pending transfer — a string for the same reason as `balance`. ' +
      'Available = balance − onHold, and that subtraction belongs in decimal arithmetic.',
  })
  onHold: string;
  @ApiProperty({ example: 'USD' }) currency: string;
  /**
   * WHICH wallet of this owner's, in this currency — `main` or `commission`.
   *
   * ## Without it this list shows one client two identical rows
   *
   * A partner holds a main USD wallet AND a commission USD wallet, and every
   * other column an operator can see on them is the same shape. Two rows
   * reading "USD · $700" and "USD · $120" against one name, with nothing saying
   * which is which, is the failure `/accounts/[id]` records in the portal: two
   * money figures that differ and no way to tell them apart, so half the readers
   * act on the wrong one. On an operator screen that means adjusting the wrong
   * balance.
   *
   * Not filtered out of the admin list, deliberately. A commission balance IS
   * the platform's liability to that partner, so a holdings total that omitted
   * it would understate what is owed — the fix is to LABEL it, not to hide it.
   */
  @ApiProperty({
    enum: ['main', 'commission'],
    description:
      "`main` is the client's own money — deposits, withdrawals, trading transfers. " +
      "`commission` holds a partner's earnings until they move them across; it is invisible to " +
      'GET /wallet and reachable only through POST /ib/wallet/transfer.',
  })
  kind: 'main' | 'commission';
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
  @ApiProperty({ type: HoldingOwnerDto }) user: HoldingOwnerDto;
}

export class WalletListResponseDto {
  @ApiProperty({ type: [WalletRowDto] }) items: WalletRowDto[];
  /** Pass back as `?cursor=` for the next page; `null` on the last (R-2.4). */
  @ApiProperty({ type: String, nullable: true }) nextCursor: string | null;
  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
}

export class TradingAccountRowDto {
  @ApiProperty() id: string;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'The MT5 login, once there is an MT5 to issue one. NULL until assigned, and a STRING ' +
      'rather than a number because leading zeros are significant to the bridge.',
  })
  login?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true }) mt5Group?: string | null;
  @ApiProperty({ enum: ['live', 'demo'] }) environment: string;
  @ApiProperty({ example: 'USD' }) currency: string;
  @ApiProperty({
    type: 'string',
    example: '1000.00000000',
    description:
      'Monetary value — ALWAYS a string. CRM-owned until the MT5 bridge lands, at which ' +
      'point it becomes a mirror of MT5 or is removed (see the schema comment).',
  })
  balance: string;
  @ApiPropertyOptional({ type: String, nullable: true }) tier?: string | null;
  @ApiPropertyOptional({ type: Number, nullable: true }) leverage?: number | null;
  @ApiProperty({ enum: ['active', 'suspended', 'closed'] }) status: string;
  @ApiProperty() createdAt: Date;
  @ApiProperty() updatedAt: Date;
  @ApiProperty({ type: HoldingOwnerDto }) user: HoldingOwnerDto;
}

export class TradingAccountListResponseDto {
  @ApiProperty({ type: [TradingAccountRowDto] }) items: TradingAccountRowDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor: string | null;
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

/*
 * Re-exported rather than redeclared.
 *
 * `LedgerEntryDto` was briefly declared in TWO places, and Swagger keys schemas
 * by class name — so one definition silently overwrote the other and whichever
 * lost produced a wrong type in both generated frontends. One declaration, in
 * the module that owns the ledger, surfaced here for the admin routes.
 */
export { LedgerEntryDto, LedgerListResponseDto } from '../../wallet/dto/wallet-response.dto';

/**
 * An API key as the list screen sees it — everything EXCEPT the secret.
 *
 * There is no field here that could authenticate. `prefix` is the non-secret
 * leading characters, which is what lets an operator tell two keys apart and
 * match one found in a log against a row; the secret itself exists only as a
 * SHA-256 hash at rest and is returned exactly once, by `POST`.
 */
export class ApiKeyDto {
  @ApiProperty() id: string;
  @ApiProperty({ example: 'Nightly reporting job' }) name: string;

  @ApiProperty({
    example: 'oxs_live_a1b2c3',
    description: 'The non-secret leading characters. Never enough to authenticate with.',
  })
  prefix: string;

  @ApiProperty({ type: [String], example: ['users.view'] })
  permissions: string[];

  /*
   * `type: 'string'` is STATED on every nullable field below, and it is not
   * decoration.
   *
   * A `string | null` property with no explicit type reflects as `Object`, and
   * Nest emits `"type": "object"` — which openapi-typescript then generates as
   * `Record<string, never>`, so the admin console got an unusable type for
   * every date on this screen. The union is invisible to `emitDecoratorMeta-
   * data`; only the decorator can carry it.
   */
  @ApiProperty({
    type: 'string',
    nullable: true,
    description: 'Null when the creating admin has been deleted.',
  })
  createdByName: string | null;

  @ApiProperty({
    type: 'string',
    format: 'date-time',
    nullable: true,
    description: 'Null means this key never expires.',
  })
  expiresAt: string | null;

  @ApiProperty({
    type: 'string',
    format: 'date-time',
    nullable: true,
    description: 'Set once revoked; the row is kept for the audit.',
  })
  revokedAt: string | null;

  @ApiProperty({
    type: 'string',
    format: 'date-time',
    nullable: true,
    description:
      'Best effort, written at most once an hour — an update per request would put a write on ' +
      'the hot path of every integration.',
  })
  lastUsedAt: string | null;

  @ApiProperty({ type: 'string', format: 'date-time' }) createdAt: string;
}

/**
 * The response to creating a key — the ONLY time the secret is ever returned.
 *
 * It is not stored in any recoverable form, so an operator who does not copy it
 * now must issue a new key. That is the intended trade: a secret this system
 * could show twice is one a database dump could show an attacker.
 */
export class IssuedApiKeyDto {
  @ApiProperty({ type: ApiKeyDto })
  key: ApiKeyDto;

  @ApiProperty({
    example: 'oxs_live_x7Kd9…',
    description:
      'THE PLAINTEXT KEY, shown exactly once. Never stored, never recoverable, never logged.',
  })
  plaintext: string;
}

/**
 * One wallet whose balance disagrees with the sum of its own ledger.
 *
 * Every amount is a STRING, for the reason §6.1 gives and this report makes
 * especially sharp: a discrepancy is the one number nobody may see rounded. A
 * float here could render a real 0.00000001 drift as a clean 0 — reporting
 * "balanced" for the exact condition this screen exists to catch.
 */
export class WalletDiscrepancyDto {
  @ApiProperty() walletId: string;
  @ApiProperty() userId: string;
  @ApiProperty() currency: string;

  @ApiProperty({
    type: 'string',
    example: '150.00000000',
    description: 'What the wallet row claims. Monetary value — always a string.',
  })
  balance: string;

  @ApiProperty({
    type: 'string',
    example: '149.00000000',
    description: 'What its ledger entries actually sum to. Monetary value — always a string.',
  })
  ledgerSum: string;

  @ApiProperty({
    type: 'string',
    example: '1.00000000',
    description:
      'balance − ledgerSum, SIGNED so the direction is visible: positive means the wallet ' +
      'claims more than the ledger justifies. Monetary value — always a string.',
  })
  difference: string;
}

/**
 * The §12.2 reconciliation report.
 *
 * Previously this route documented a bare `200` with no schema, so both
 * frontends generated `unknown` for it and any screen showing the report had to
 * hand-write the shape — which is how a field gets renamed on one side only.
 */
export class ReconciliationReportDto {
  @ApiProperty({ description: 'When this run completed (ISO 8601).' })
  checkedAt: string;

  @ApiProperty({ description: 'How many wallets were compared against their ledgers.' })
  walletsChecked: number;

  @ApiProperty({
    type: [WalletDiscrepancyDto],
    description:
      'A SAMPLE — the largest discrepancies by absolute difference, capped at 20. Empty when ' +
      'every wallet agrees with its ledger. Read `discrepancyCount` for how many there really ' +
      'are: a screen that counts this array reports 20 on a database with thousands.',
  })
  walletDiscrepancies: WalletDiscrepancyDto[];

  @ApiProperty({
    description:
      'How many wallets disagree in total, independent of the capped sample above. Counted in ' +
      'SQL, so it is exact.',
  })
  discrepancyCount: number;

  @ApiProperty({
    description:
      'The SUM OF ABSOLUTE differences across every mismatched wallet — the size of the problem. ' +
      'Absolute rather than net, so two large opposite errors do not report as nearly balanced. ' +
      'Monetary value — always a string.',
    example: '24995.35000000',
  })
  totalDifference: string;

  @ApiProperty({
    description:
      'True when nothing is wrong. Read this rather than testing the array length — it is the ' +
      'field the service decides, and a future check can make it false without adding a wallet ' +
      'discrepancy.',
  })
  balanced: boolean;
}

/**
 * One live session — one LOGIN, not one token row.
 *
 * A month-old session is thousands of rotations and one thing the
 * administrator actually did, so the list is keyed by refresh-token family.
 */
export class AdminSessionDto {
  @ApiProperty({
    description: 'Refresh-token family id. Pass this to DELETE /admin/auth/sessions/:id.',
  })
  id: string;

  @ApiProperty({ description: 'When this session signed in.', format: 'date-time' })
  createdAt: string;

  @ApiProperty({
    description: 'Last time this session refreshed — how "active" is measured.',
    format: 'date-time',
  })
  lastActiveAt: string;

  @ApiProperty({ description: 'When it expires on its own if unused.', format: 'date-time' })
  expiresAt: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Most recent User-Agent seen on this session. Null for sessions predating capture.',
  })
  userAgent: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Most recent client address. Null for sessions predating capture.',
  })
  ip: string | null;

  @ApiProperty({
    description:
      'True for the session this request is on. The console labels it and hides its sign-out ' +
      'button — ending it here would revoke the family and leave the cookies in place.',
  })
  current: boolean;
}

/** Where a profile photo is served from, or null when there is none. */
export class AdminAvatarResponseDto {
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Path to the stored photo, or null. Composed from the stored filename, so the section ' +
      '8.5 move to private object storage changes that expression and no rows.',
    example: '/uploads/avatars/6f1c...c2.png',
  })
  avatarUrl: string | null;
}

/** The stored display name after a self-service change — trimmed, as saved. */
export class AdminProfileNameDto {
  @ApiProperty({ example: 'Ada Lovelace' })
  name: string;
}

/**
 * One row on the client profile's Positions tab.
 *
 * Prices carry more decimals than money and both cross as STRINGS — §6.1 for
 * the money, and for the prices because a JPY pair quotes to 3 places while
 * most others quote to 5, so there is no single float that round-trips them.
 */
export class ClientPositionRowDto {
  @ApiProperty() id: string;
  @ApiProperty() ticket: string;
  @ApiProperty() symbol: string;
  @ApiProperty({ enum: ['buy', 'sell'] }) side: string;
  @ApiProperty({ type: 'string', example: '0.2000', description: 'Lots.' }) volume: string;
  @ApiProperty({ type: 'string' }) openPrice: string;
  @ApiProperty({ type: 'string', nullable: true, description: 'NULL while open.' })
  closePrice: string | null;
  @ApiProperty({
    type: 'string',
    nullable: true,
    description:
      'The FLOATING result while `status` is open, and the REALISED one once closed. One ' +
      'column, two meanings, disambiguated by `status` — label it accordingly.',
  })
  profit: string | null;
  @ApiProperty({ type: 'string', nullable: true }) swap: string | null;
  @ApiProperty({ type: 'string', nullable: true }) commission: string | null;
  @ApiProperty() currency: string;
  @ApiProperty({ enum: ['open', 'closed'] }) status: string;
  @ApiProperty() openedAt: Date;
  @ApiProperty({ type: Date, nullable: true }) closedAt: Date | null;
  @ApiProperty({
    type: 'string',
    nullable: true,
    description: 'The account it was traded on. NULL until MT5 issues a login.',
  })
  login: string | null;
}

export class ClientPositionsPageDto {
  @ApiProperty({ type: [ClientPositionRowDto] }) rows: ClientPositionRowDto[];
  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
}

/** One movement of a client's money, in either direction. */
export class ClientTransactionRowDto {
  @ApiProperty() id: string;
  @ApiProperty({ enum: ['deposit', 'withdrawal', 'transfer'] }) direction: string;
  @ApiProperty() state: string;
  @ApiProperty({ type: 'string', example: '250.00000000', description: 'A decimal string (§6.1).' })
  amount: string;
  @ApiProperty() currency: string;
  @ApiProperty({ type: 'string', nullable: true }) methodKey: string | null;
  @ApiProperty({ type: 'string', nullable: true }) provider: string | null;
  @ApiProperty({ type: 'string', nullable: true }) providerRef: string | null;
  @ApiProperty() createdAt: Date;
  @ApiProperty({ type: Date, nullable: true }) settledAt: Date | null;
}

export class ClientTransactionsPageDto {
  @ApiProperty({ type: [ClientTransactionRowDto] }) rows: ClientTransactionRowDto[];
  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
}
