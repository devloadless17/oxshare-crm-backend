import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ClientField,
  ClientFieldMap,
  NoClientFields,
  NotClientField,
} from '../../../common/security/client-field.decorator';
import {
  rejectionContextEnum,
  transactionDirectionEnum,
  transactionStateEnum,
} from '../../../database/schema';
import { TRANSACTION_KINDS } from '../../payments/transactions.service';
import type { RejectionContext } from '../../../store/rejection-reasons.store';
import { PROFILE_FIELD_KEYS } from '../../../common/profile/client-profile';
import { TransactionDto } from '../../payments/dto/withdrawal.dto';
import { PayToDetailDto, ProofDetailDto } from '../../payments/dto/deposit.dto';
import { TransferDto } from '../../payments/dto/transfer.dto';

// Response DTOs so /api/docs-json carries response schemas (API-CONTRACTS
// Part C). Both frontends generate TypeScript types from the Swagger JSON —
// keep these in sync with what the services actually return.

/** A tag an administrator's client view is restricted to. */
@NoClientFields(
  'an administrative or configuration shape - no client-owned field on it; the client-carrying shapes in this file are marked field by field',
)
export class AdminScopeTagDto {
  @ApiProperty() tagId: string;
  @ApiProperty() slug: string;
  @ApiProperty() label: string;
}

export class AdminProfileDto {
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty()
  id: string;
  @NotClientField(
    'the administrator OWN address - this DTO describes the operator reading the screen, not a client',
  )
  @ApiProperty()
  email: string;
  @NotClientField('an ADMINISTRATOR attribute \u2014 this describes the operator, never a client')
  @ApiProperty()
  name: string;
  @NotClientField('a lifecycle state or classification the desk acts on, not client-owned data')
  @ApiProperty({ enum: ['master_admin', 'sub_admin'] })
  role: 'master_admin' | 'sub_admin';
  @NotClientField('an ADMINISTRATOR attribute \u2014 this describes the operator, never a client')
  @ApiProperty({ type: [String] })
  permissions: string[];
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiPropertyOptional()
  roleId?: string;
  /**
   * The role's display name — what the console shows beside the operator's own.
   *
   * `roleId` alone was useless for that: resolving it meant fetching the roles
   * list, which requires `roles.view`, so every administrator without it saw
   * their email address where their job title should be. Absent when the admin
   * is on no role, which is a real state and must not be guessed at.
   */
  @NotClientField('an ADMINISTRATOR attribute \u2014 this describes the operator, never a client')
  @ApiPropertyOptional()
  roleName?: string;
  /*
   * The admin directory rendered a hardcoded "Active" badge for every row,
   * because this field did not exist and the screen showed something rather
   * than nothing. A suspended administrator therefore displayed as active on
   * the one screen an operator would check before trusting an account.
   *
   * Suspension has always been ENFORCED — admin.guard.ts refuses a suspended
   * admin on every request — so the gap was purely in what the API admitted to.
   */
  @NotClientField('a lifecycle state or classification the desk acts on, not client-owned data')
  @ApiProperty({ enum: ['active', 'suspended'] })
  status: 'active' | 'suspended';

  /**
   * RBAC-03 — the client fields this administrator cannot see RIGHT NOW, role
   * and per-person override already combined.
   *
   * The resolved answer rather than the raw column: a directory row showing
   * "nothing hidden" for somebody whose ROLE hides four fields would be a
   * confident lie, and the row is exactly where an operator checks before
   * trusting an account.
   */
  @NotClientField('the mask reporting on ITSELF, so the screen can say hidden rather than empty')
  @ApiProperty({ type: [String] })
  maskedFields: string[];

  /**
   * The STORED override — `null` when this administrator follows their role.
   *
   * Distinct from `maskedFields` above, and the edit screen needs both: without
   * this it cannot tell "inherits the role" from "has an identical override",
   * and so could never offer to put somebody back on their role.
   */
  @ApiPropertyOptional({ type: [String], nullable: true })
  @NotClientField('the mask reporting on ITSELF, so the screen can say hidden rather than empty')
  maskedFieldsOverride?: string[] | null;

  /**
   * RBAC-03 territory — the client tags this administrator is restricted to.
   *
   * EMPTY MEANS UNRESTRICTED, not "sees nothing" (D-10). Any screen rendering
   * this has to say so in words; it is not inferable from an empty array.
   */
  @NotClientField('an ADMINISTRATOR attribute \u2014 this describes the operator, never a client')
  @ApiProperty({ type: [AdminScopeTagDto] })
  scopedTags: AdminScopeTagDto[];

  /**
   * Sees EVERY client — the effective explicit grant (0154): the flag set and
   * no territory tags. An empty territory no longer means every client.
   */
  @NotClientField('an ADMINISTRATOR attribute \u2014 this describes the operator, never a client')
  @ApiProperty()
  seesAllClients: boolean;

  /**
   * The profile photo, on `me` rather than behind a profile endpoint of its
   * own — the sidebar renders it on every page, so a second call would be a
   * round trip per navigation to draw one 32px circle.
   */
  @ApiPropertyOptional({ type: String, nullable: true, example: '/uploads/avatars/6f1c.png' })
  @NotClientField('an ADMINISTRATOR attribute \u2014 this describes the operator, never a client')
  avatarUrl?: string | null;

  /**
   * When this administrator last changed their own password.
   *
   * `null` for every account predating the column, which is NOT "never
   * changed" — the profile screen words it as unknown rather than guessing.
   */
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  @NotClientField('a timestamp the system recorded, describing the record rather than the client')
  passwordChangedAt?: Date | null;

  /**
   * When this administrator's authenticator app was set up (0191), or `null`
   * when none is — their next sign-in enrols one.
   */
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  @NotClientField('a timestamp the system recorded, describing the record rather than the client')
  totpEnabledAt: Date | null;

  @NotClientField('a timestamp the system recorded, describing the record rather than the client')
  @ApiProperty()
  createdAt: Date;
}

/**
 * `POST /admin/auth/totp/verify` and `/admin/auth/refresh` — a session exists.
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
@NoClientFields(
  'an administrative or configuration shape - no client-owned field on it; the client-carrying shapes in this file are marked field by field',
)
export class AdminLoginResponseDto {
  @ApiProperty({ type: AdminProfileDto }) admin: AdminProfileDto;
}

/**
 * `POST /admin/auth/login` — the password was right, and that is HALF a
 * sign-in (0191). No cookies are set; `challengeToken` is good only at
 * `auth/totp/setup` and `auth/totp/verify`, for `expiresInSeconds`.
 */
@NoClientFields('an administrative or configuration shape - no client-owned field on it')
export class AdminSignInChallengeDto {
  @ApiProperty({
    enum: ['totp', 'totp_setup'],
    description:
      '`totp`: ask for the 6-digit code. `totp_setup`: no authenticator yet — show the QR code first.',
  })
  step: 'totp' | 'totp_setup';
  @ApiProperty({ description: 'Short-lived; send it back with the code. Not a session.' })
  challengeToken: string;
  @ApiProperty({ example: 600 }) expiresInSeconds: number;
}

/** `POST /admin/auth/totp/setup` — what the authenticator app needs. */
@NoClientFields('an administrative or configuration shape - no client-owned field on it')
export class AdminTotpSetupDto {
  @ApiProperty({ description: 'Base32 secret, for typing into the app by hand.' })
  secret: string;
  @ApiProperty({ description: 'The otpauth:// URI the QR code encodes.' })
  otpauthUri: string;
  @ApiProperty({ description: 'The QR code, as an SVG document.' })
  qrSvg: string;
  @ApiProperty({ example: 'ada@bbcorp.trade', description: 'The account name the app shows.' })
  account: string;
  @ApiProperty({ example: 'OxShare Admin' }) issuer: string;
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
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty()
  id: string;
  /**
   * The client's PORTAL ID — the human number, 1,000,000 up (migration 0133).
   * What staff read and search by; `id` stays the key for URLs and the API.
   */
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty({ type: Number, example: 1000001 })
  portalId: number;
  @ClientField('client.email')
  @ApiProperty()
  email: string;
  @ClientField('client.firstName')
  @ApiProperty()
  firstName: string;
  @ClientField('client.lastName')
  @ApiProperty()
  lastName: string;
  @NotClientField('a lifecycle state or classification the desk acts on, not client-owned data')
  @ApiPropertyOptional({ enum: ['individual', 'referral', 'partner'] })
  type?: string;
  @NotClientField('a lifecycle state or classification the desk acts on, not client-owned data')
  @ApiPropertyOptional({ enum: ['active', 'pending', 'suspended'] })
  status?: string;
  @NotClientField('a lifecycle state or classification the desk acts on, not client-owned data')
  @ApiPropertyOptional({ enum: [0, 1] })
  verificationLevel?: number;
  @NotClientField(
    'a verification STATUS rather than the address; the catalogue offers no key for it, and hiding it would blank the badge rather than protect anything',
  )
  @ApiPropertyOptional()
  emailVerified?: boolean;
  @ClientField('client.country')
  @ApiPropertyOptional()
  country?: string;
  @ClientField('client.phone')
  @ApiPropertyOptional()
  phone?: string;
  @ClientField('client.createdAt')
  @ApiPropertyOptional({ type: String, format: 'date-time' })
  createdAt?: string;
}

@NoClientFields(
  'an administrative or configuration shape - no client-owned field on it; the client-carrying shapes in this file are marked field by field',
)
export class KycDocumentDto {
  @ApiPropertyOptional() docType?: string;
  @ApiPropertyOptional() frontFilePath?: string;
  @ApiPropertyOptional() backFilePath?: string;
}

@NoClientFields(
  'an administrative or configuration shape - no client-owned field on it; the client-carrying shapes in this file are marked field by field',
)
export class KycSelfieDto {
  @ApiPropertyOptional() filePath?: string;
}

@NoClientFields(
  'an administrative or configuration shape - no client-owned field on it; the client-carrying shapes in this file are marked field by field',
)
export class KycAddressProofDto {
  @ApiPropertyOptional() docType?: string;
  @ApiPropertyOptional() filePath?: string;
  @ApiPropertyOptional() page2FilePath?: string;
}

const LAYOUT_ONLY =
  'the STRUCTURE and LABELS of the form a submission answered — no value of the client\u2019s';

/** One page of a document, as the reviewer is shown it. */
@NoClientFields(LAYOUT_ONLY)
export class KycReviewPageDto {
  @ApiProperty({ example: 'doc_back', description: 'Where the file is stored on the submission.' })
  slot: string;
  @ApiProperty({ example: 'Back Side' }) label: string;
  @ApiProperty() required: boolean;
}

/** A document on file, by its exact name and its pages. */
@NoClientFields(LAYOUT_ONLY)
export class KycReviewDocumentDto {
  @ApiProperty({ type: String, nullable: true, example: 'national_id' }) type: string | null;
  @ApiProperty({ example: 'National ID' }) label: string;
  @ApiProperty({ type: [KycReviewPageDto] }) pages: KycReviewPageDto[];
}

@NoClientFields(LAYOUT_ONLY)
export class KycReviewAddressDto extends KycReviewDocumentDto {
  @ApiProperty({
    description:
      'Whether the form asks for this document now. When it does not, its pages on file are ' +
      'shown but cannot be returned: the client has no step to replace them on.',
  })
  asked: boolean;
}

@NoClientFields(LAYOUT_ONLY)
export class KycReviewSelfieDto {
  @ApiProperty() asked: boolean;
  @ApiProperty({ example: 'Selfie' }) label: string;
}

@NoClientFields(LAYOUT_ONLY)
export class KycReviewIdentityFieldDto {
  @ApiProperty({ enum: PROFILE_FIELD_KEYS }) key: (typeof PROFILE_FIELD_KEYS)[number];
  @ApiProperty({ example: 'Date of Birth' }) label: string;
  @ApiProperty({ description: 'Required by the form as it stands; false when not asked.' })
  required: boolean;
  @ApiProperty({
    description:
      'The form asks it now, so the client can answer it — only these can be returned. ' +
      'The others are shown for comparison with the document.',
  })
  asked: boolean;
}

/** One of the broker's own questions, and where its answer is filed. */
@NoClientFields(LAYOUT_ONLY)
export class KycReviewFieldDto {
  @ApiProperty({ example: 'customField_1790281526943' }) name: string;
  @ApiProperty({ example: 'Employer' }) label: string;
  @ApiProperty({ example: 'text' }) type: string;
  @ApiProperty({
    example: 'source-of-funds',
    description: '`personal` → read `personalInfo[name]`; any other → `stepData[step][name]`.',
  })
  step: string;
}

@NoClientFields(LAYOUT_ONLY)
export class KycReviewSectionDto {
  @ApiProperty({ example: 'source-of-funds', description: '`unlisted` for removed questions.' })
  slug: string;
  @ApiProperty({ example: 'Source of funds' }) title: string;
  @ApiProperty({ type: [KycReviewFieldDto] }) fields: KycReviewFieldDto[];
}

@NoClientFields(LAYOUT_ONLY)
export class KycReviewFlagDto {
  @ApiProperty({ example: 'doc_back' }) id: string;
  @ApiProperty({ example: 'National ID (Back Side)' }) label: string;
}

/**
 * How to PRESENT a submission — `kyc-review-layout.ts`. The server's layout, so
 * the review never depends on the builder (a `kyc.review`-only role cannot read
 * it) or on today's form (a question relabelled after the client answered).
 * Labels only: every value stays in `personalInfo`, `stepData` and the document
 * fields, under their own masks.
 */
export class KycReviewLayoutDto {
  /*
   * Each field states itself rather than the class being exempted as a whole:
   * `proofOfAddress` NAMES a person's attribute, and the census rightly asks a
   * class carrying such a name to say, per field, why it holds no client data.
   * These are the form's structure and labels; the values are elsewhere.
   */
  @NotClientField(LAYOUT_ONLY)
  @ApiProperty({ type: [KycReviewIdentityFieldDto] })
  identity: KycReviewIdentityFieldDto[];
  @NotClientField(LAYOUT_ONLY)
  @ApiProperty({ type: KycReviewAddressDto })
  identityDocument: KycReviewAddressDto;
  @NotClientField(LAYOUT_ONLY)
  @ApiProperty({ type: KycReviewAddressDto })
  proofOfAddress: KycReviewAddressDto;
  @NotClientField(LAYOUT_ONLY)
  @ApiProperty({ type: KycReviewSelfieDto })
  selfie: KycReviewSelfieDto;
  @NotClientField(LAYOUT_ONLY)
  @ApiProperty({ type: [KycReviewSectionDto] })
  additional: KycReviewSectionDto[];
  @NotClientField(LAYOUT_ONLY)
  @ApiProperty({ type: [KycReviewFlagDto] })
  flags: KycReviewFlagDto[];
}

export class KycSubmissionDto {
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty()
  userId: number;
  @ApiProperty({
    enum: ['not_started', 'in_progress', 'submitted', 'under_review', 'approved', 'rejected'],
  })
  @NotClientField('a lifecycle state or classification the desk acts on, not client-owned data')
  status: string;
  @NotClientField('a timestamp the system recorded, describing the record rather than the client')
  @ApiPropertyOptional()
  submittedAt?: Date;
  @NotClientField('a timestamp the system recorded, describing the record rather than the client')
  @ApiPropertyOptional()
  reviewedAt?: Date;
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiPropertyOptional()
  reviewedBy?: string;
  /**
   * The reviewer's NAME, resolved from `reviewedBy`.
   *
   * "Who has this" is the only question a claim answers for a colleague, and a
   * uuid answers it to nobody — so the queue showed a submission as taken with
   * no way to find out by whom, and hid the Claim button from everyone else.
   * Null when unclaimed, and null when the administrator who held it has since
   * been deleted: an absence the screen states rather than filling with an id.
   */
  @NotClientField('an ADMINISTRATOR attribute \u2014 this describes the operator, never a client')
  @ApiPropertyOptional({ type: String, nullable: true })
  reviewedByName?: string | null;
  @NotClientField(
    'not a client-owned attribute \u2014 rejectionReason describes the record rather than the person',
  )
  @ApiPropertyOptional()
  rejectionReason?: string;
  @NotClientField(
    'not a client-owned attribute \u2014 the Arabic of rejectionReason describes the record',
  )
  @ApiPropertyOptional({
    type: String,
    description: 'The reason in Arabic as the client was shown it (0179). Absent when none.',
  })
  rejectionReasonAr?: string;
  @NotClientField(
    'not a client-owned attribute \u2014 rejectedFields describes the record rather than the person',
  )
  @ApiPropertyOptional({ type: [String] })
  rejectedFields?: string[];
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  @ClientFieldMap('kyc.personalInfo', { others: 'kyc.stepData', named: PROFILE_FIELD_KEYS })
  personalInfo?: Record<string, string>;
  @NotClientField(
    'a stored-document REFERENCE (its type and file name), never the document contents',
  )
  @ApiPropertyOptional({ type: KycDocumentDto })
  document?: KycDocumentDto;
  @NotClientField(
    'a stored-document REFERENCE (its type and file name), never the document contents',
  )
  @ApiPropertyOptional({ type: KycSelfieDto })
  selfie?: KycSelfieDto;
  @ApiPropertyOptional({ type: KycAddressProofDto })
  @NotClientField(
    'a stored-document REFERENCE (its type and file name), never the document contents',
  )
  addressProof?: KycAddressProofDto;
  /**
   * Answers to steps outside the four canonical ones, keyed by slug.
   *
   * ONE key for the whole map, not a `@ClientFieldMap` prefix, and the
   * difference is whether masking can ever do anything.
   *
   * `personalInfo` uses a prefix because its keys ARE in the catalogue
   * (`kyc.personalInfo.dateOfBirth` and friends), so a role's mask can name
   * one. A custom step's slugs are invented by a broker after this code ships,
   * so no mask could ever contain one — a prefix here would look like a control
   * and mask nothing, for ever.
   *
   * So custom-step answers are one maskable unit: a role that may not read them
   * loses all of them. That is a coarser guarantee than `personalInfo` gets, and
   * it is the honest one — better a control that plainly works at the level it
   * claims than a finer one that silently never fires.
   *
   * ⚠️ The first version of this had the paragraph above and NO decorator: a
   * comment asserting the field was "marked as such" while nothing marked it.
   * `client-field-coverage.spec.ts` failed on exactly that, which is the census
   * doing its job — and it is the same defect this codebase keeps finding, so
   * it is recorded rather than quietly corrected.
   */
  @ClientField('kyc.stepData')
  @ApiPropertyOptional({
    type: 'object',
    // Nested `additionalProperties`, not `true`: the shape is slug -> field ->
    // value, and declaring it loosely generated `unknown` on the client, which
    // pushed a cast into the screen that renders it. The contract is the place
    // to be precise, so the consumer does not have to guess.
    additionalProperties: { type: 'object', additionalProperties: { type: 'string' } },
    description: 'Answers for configured steps beyond the four canonical ones, keyed by slug.',
  })
  stepData?: Record<string, Record<string, string | { filePath: string }>>;
  @ApiPropertyOptional({ type: KycUserDto, nullable: true })
  @NotClientField(
    'the nested person, whose own shape carries the marks \u2014 masked there, not here',
  )
  user?: KycUserDto | null;
  /** RBAC-03: the `kyc.*` keys hidden from this viewer, omitted from the body. */
  @NotClientField('the mask reporting on ITSELF, so the screen can say hidden rather than empty')
  @ApiPropertyOptional({ type: [String] })
  maskedFields?: string[];
  /*
   * DECLARED because they are RETURNED. `GET /admin/kyc/:userId` has always
   * carried the submission's own timestamps and this DTO never mentioned them,
   * so both frontends' generated types were missing two fields the API emits —
   * the same contract gap `ClientRowDto.phone` had, found the same way, by
   * checking a real response against the shape that claims to describe it.
   */
  @NotClientField('a timestamp the system recorded, describing the record rather than the client')
  @ApiPropertyOptional({ type: Date })
  createdAt?: Date;

  @NotClientField('a timestamp the system recorded, describing the record rather than the client')
  @ApiPropertyOptional({ type: Date })
  updatedAt?: Date;

  /** When a reviewer returned this APPROVED verification for the client to update. */
  @NotClientField('a timestamp the system recorded, describing the record rather than the client')
  @ApiPropertyOptional({ type: Date })
  reverificationRequestedAt?: Date;

  @NotClientField('the structure and labels of the form, never a value of the client’s')
  @ApiPropertyOptional({ type: KycReviewLayoutDto })
  layout?: KycReviewLayoutDto;
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
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty({ description: 'Dense from 1, per client.' })
  attemptNo: number;
  @NotClientField('a lifecycle state or classification the desk acts on, not client-owned data')
  @ApiProperty({ enum: ['approved', 'rejected'] })
  status: string;
  @NotClientField('a timestamp the system recorded, describing the record rather than the client')
  @ApiPropertyOptional()
  submittedAt?: Date;
  @NotClientField('a timestamp the system recorded, describing the record rather than the client')
  @ApiPropertyOptional()
  reviewedAt?: Date;
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiPropertyOptional()
  reviewedBy?: string;
  /**
   * The NAME of the administrator who decided this attempt, resolved from
   * `reviewedBy`.
   *
   * ⚠️ This was declared and never filled. The comment it carried was copied
   * from `KycSubmissionDto` and described the queue's Claim button, and the
   * history route returned archived rows raw — so the contract promised a field
   * no response ever contained. Reported from production as "I can see who
   * approved, not who rejected": a rejection has usually been archived into an
   * attempt by the time anybody reads it, so this panel is where it is read.
   *
   * Null when the administrator has since been deleted — an absence the screen
   * states rather than filling with an id.
   */
  @NotClientField('an ADMINISTRATOR attribute \u2014 this describes the operator, never a client')
  @ApiPropertyOptional({ type: String, nullable: true })
  reviewedByName?: string | null;
  @NotClientField(
    'not a client-owned attribute \u2014 rejectionReason describes the record rather than the person',
  )
  @ApiPropertyOptional()
  rejectionReason?: string;
  @NotClientField(
    'not a client-owned attribute \u2014 the Arabic of rejectionReason describes the record',
  )
  @ApiPropertyOptional({
    type: String,
    description: 'The reason in Arabic as the client was shown it (0179). Absent when none.',
  })
  rejectionReasonAr?: string;
  @NotClientField(
    'not a client-owned attribute \u2014 rejectedFields describes the record rather than the person',
  )
  @ApiPropertyOptional({ type: [String] })
  rejectedFields?: string[];
  @ApiPropertyOptional({ type: 'object', additionalProperties: { type: 'string' } })
  @ClientFieldMap('kyc.personalInfo', { others: 'kyc.stepData', named: PROFILE_FIELD_KEYS })
  personalInfo?: Record<string, string>;
  @NotClientField(
    'a stored-document REFERENCE (its type and file name), never the document contents',
  )
  @ApiPropertyOptional({ type: KycDocumentDto })
  document?: KycDocumentDto;
  @NotClientField(
    'a stored-document REFERENCE (its type and file name), never the document contents',
  )
  @ApiPropertyOptional({ type: KycSelfieDto })
  selfie?: KycSelfieDto;
  @NotClientField(
    'a stored-document REFERENCE (its type and file name), never the document contents',
  )
  @ApiPropertyOptional({ type: KycAddressProofDto })
  addressProof?: KycAddressProofDto;
  /**
   * Answers to steps outside the four canonical ones, keyed by slug.
   *
   * ONE key for the whole map, not a `@ClientFieldMap` prefix, and the
   * difference is whether masking can ever do anything.
   *
   * `personalInfo` uses a prefix because its keys ARE in the catalogue
   * (`kyc.personalInfo.dateOfBirth` and friends), so a role's mask can name
   * one. A custom step's slugs are invented by a broker after this code ships,
   * so no mask could ever contain one — a prefix here would look like a control
   * and mask nothing, for ever.
   *
   * So custom-step answers are one maskable unit: a role that may not read them
   * loses all of them. That is a coarser guarantee than `personalInfo` gets, and
   * it is the honest one — better a control that plainly works at the level it
   * claims than a finer one that silently never fires.
   *
   * ⚠️ The first version of this had the paragraph above and NO decorator: a
   * comment asserting the field was "marked as such" while nothing marked it.
   * `client-field-coverage.spec.ts` failed on exactly that, which is the census
   * doing its job — and it is the same defect this codebase keeps finding, so
   * it is recorded rather than quietly corrected.
   */
  @ClientField('kyc.stepData')
  @ApiPropertyOptional({
    type: 'object',
    // Nested `additionalProperties`, not `true`: the shape is slug -> field ->
    // value, and declaring it loosely generated `unknown` on the client, which
    // pushed a cast into the screen that renders it. The contract is the place
    // to be precise, so the consumer does not have to guess.
    additionalProperties: { type: 'object', additionalProperties: { type: 'string' } },
    description: 'Answers for configured steps beyond the four canonical ones, keyed by slug.',
  })
  stepData?: Record<string, Record<string, string | { filePath: string }>>;
  @NotClientField('a timestamp the system recorded, describing the record rather than the client')
  @ApiProperty()
  archivedAt: Date;

  /** How to present this attempt — structure and labels, as for the live submission. */
  @NotClientField('the structure and labels of the form, never a value of the client’s')
  @ApiPropertyOptional({ type: KycReviewLayoutDto })
  layout?: KycReviewLayoutDto;
}

export class KycListResponseDto {
  @NotClientField(
    'a money, paging or configuration value on the RECORD, carrying no client attribute',
  )
  @ApiProperty({ type: [KycSubmissionDto] })
  items: KycSubmissionDto[];
  /** RBAC-03: the `kyc.*` keys hidden from this viewer, omitted from every row. */
  @NotClientField('the mask reporting on ITSELF, so the screen can say hidden rather than empty')
  @ApiPropertyOptional({ type: [String] })
  maskedFields?: string[];
  @NotClientField(
    'a money, paging or configuration value on the RECORD, carrying no client attribute',
  )
  @ApiProperty()
  total: number;
  @NotClientField(
    'a money, paging or configuration value on the RECORD, carrying no client attribute',
  )
  @ApiProperty()
  page: number;
  @NotClientField(
    'a money, paging or configuration value on the RECORD, carrying no client attribute',
  )
  @ApiProperty()
  limit: number;
  @ApiProperty({ type: 'object', additionalProperties: { type: 'number' } })
  @NotClientField(
    'a money, paging or configuration value on the RECORD, carrying no client attribute',
  )
  counts: Record<string, number>;
}

/** RBAC-03 — one maskable (or deliberately unmaskable) client field. */
@NoClientFields(
  'an administrative or configuration shape - no client-owned field on it; the client-carrying shapes in this file are marked field by field',
)
export class ClientFieldDto {
  @ApiProperty({ description: 'Path-qualified, e.g. client.email or kyc.personalInfo.phone.' })
  key: string;
  @ApiProperty() label: string;
  @ApiProperty({ description: 'False for fields the admin screens structurally need.' })
  maskable: boolean;
  @ApiPropertyOptional({ description: 'Why an unmaskable field cannot be hidden.' })
  reason?: string;
}

@NoClientFields(
  'an administrative or configuration shape - no client-owned field on it; the client-carrying shapes in this file are marked field by field',
)
export class ClientFieldGroupDto {
  @ApiProperty() groupName: string;
  @ApiProperty() description: string;
  @ApiProperty({ type: [ClientFieldDto] }) fields: ClientFieldDto[];
}

/** ADM-14 — an arbitrary client label. */
@NoClientFields(
  'an administrative or configuration shape - no client-owned field on it; the client-carrying shapes in this file are marked field by field',
)
export class ClientTagDto {
  @ApiProperty() id: string;
  @ApiProperty({
    description: 'Stable machine name. Filter with ?tag=<slug>; a rename does not change it.',
  })
  slug: string;
  @ApiProperty() label: string;
  @ApiPropertyOptional() color?: string;
  @ApiPropertyOptional() description?: string;
  @ApiPropertyOptional({
    description:
      'Set on a COUNTRY tag (ISO code, 0193): carried by every client living there, derived from their country — never assigned, renamed or deleted; only its colour is editable.',
    example: 'LB',
  })
  @NotClientField(
    'the country a TAG stands for, part of the tag catalogue; which clients carry it is derived from their own country',
  )
  countryCode?: string;
  @ApiProperty() createdAt: Date;
}

/**
 * A tag ON a client: the tag, plus the provenance of that assignment.
 *
 * `assigned_by` and `assigned_at` have been written on every assignment since
 * the table existed and were read by nothing, so "who moved this client onto
 * my desk, and when" was recorded and unanswerable from any screen. Tags are
 * RBAC-03 territory — they decide which administrator sees whom — so that is a
 * question about ACCESS, not about labels.
 */
@NoClientFields(
  'an administrative or configuration shape - no client-owned field on it; the client-carrying shapes in this file are marked field by field',
)
export class ClientTagAssignmentDto extends ClientTagDto {
  @ApiPropertyOptional({ type: String, nullable: true }) assignedBy?: string | null;
  /** Null when the assignment predates the column, or the admin was deleted. */
  @ApiPropertyOptional({ type: String, nullable: true }) assignedByName?: string | null;
  @ApiProperty() assignedAt: Date;
}

/**
 * What adding or removing a tag answers: the client's tags afterwards, and
 * whether the acting admin can still see the client at all.
 *
 * A scoped admin may hand a client to another desk by tag (owner, 28 Sep 2026).
 * After that the client is outside their territory, so `assignments` comes back
 * EMPTY rather than describing somebody they may no longer see, and
 * `stillVisible: false` tells the console to leave the page instead of
 * refetching into a 404.
 */
@NoClientFields(
  'the outcome of a tag change: tag labels (configuration) and a visibility flag about the reader - no client-owned field on it',
)
export class ClientTagChangeResultDto {
  @ApiProperty({
    type: [ClientTagAssignmentDto],
    description: 'The client’s tags after the change. Empty when `stillVisible` is false.',
  })
  assignments: ClientTagAssignmentDto[];

  @ApiProperty({
    description:
      'False when the change took the client out of the acting admin’s territory — sent only with confirmLeavesScope=true.',
  })
  stillVisible: boolean;
}

@NoClientFields(
  'an administrative or configuration shape - no client-owned field on it; the client-carrying shapes in this file are marked field by field',
)
export class ClientTagWithCountDto extends ClientTagDto {
  @ApiProperty({ description: 'How many clients carry this tag in the reader’s territory.' })
  clientCount: number;
  @ApiProperty({
    type: 'integer',
    description:
      'How many clients carry it OUTSIDE the reader’s territory — a count, never who (D-81 R2). ' +
      'Zero for a reader who sees every client.',
  })
  clientsOutsideScope: number;
}

/** The introducer on a client-list row — `ProfileReferrerDto`, cut to what a row shows. */
export class ClientRowReferrerDto {
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiPropertyOptional({ description: 'Absent when the introducer is outside your territory.' })
  ibUserId?: number;
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiPropertyOptional({
    type: 'integer',
    description:
      'The introducer’s Portal ID. Absent, with their name, when they are outside your territory.',
  })
  portalId?: number;
  @ClientField('client.firstName')
  @ApiPropertyOptional({ description: 'Absent when the introducer is outside your territory.' })
  firstName?: string;
  @ClientField('client.lastName')
  @ApiPropertyOptional({ description: 'Absent when the introducer is outside your territory.' })
  lastName?: string;
  /*
   * DECLARED, NEVER SENT. A list row names the introducer and does not need
   * their address — but the catalogue masks `client.referrer.email` wherever a
   * `referrer` appears (the profile's carries one), and masking by shape can
   * only strip what the shape declares. Declared, the two mechanisms agree on
   * this row too (`mask-equivalence.spec.ts`), and a later change that did put
   * the address here would be masked from its first response.
   */
  @ClientField('client.email')
  @ApiPropertyOptional({ description: 'Not carried on a list row.' })
  email?: string;
  @NotClientField('a visibility state about the reader, not an attribute of the person')
  @ApiProperty({
    description:
      'True when a partner the reader may not see introduced this client — distinct from ' +
      '“not introduced”, which is an absent `referrer`.',
  })
  outsideTerritory: boolean;
}

/**
 * Every field below the id is OPTIONAL, and that is the RBAC-03 wire contract
 * rather than laxity: a field the caller may not see is OMITTED, and the
 * response's `maskedFields` says which. Null already means "no value on file",
 * so overloading it would collapse "hidden from you" into "this client has
 * none" — two answers an operator must be able to tell apart.
 */
export class ClientRowDto {
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty({
    type: 'integer',
    example: 1000245,
    description: 'The client’s Portal ID — their one id (0159).',
  })
  id: number;
  /**
   * The client's PORTAL ID — the human number, 1,000,000 up (migration 0133).
   * What staff read and search by; `id` stays the key for URLs and the API.
   */
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty({ type: Number, example: 1000001 })
  portalId: number;
  @ClientField('client.email')
  @ApiPropertyOptional()
  email?: string;
  @ClientField('client.firstName')
  @ApiPropertyOptional()
  firstName?: string;
  @ClientField('client.lastName')
  @ApiPropertyOptional()
  lastName?: string;
  @NotClientField('a lifecycle state or classification the desk acts on, not client-owned data')
  @ApiProperty({ enum: ['individual', 'referral', 'partner'] })
  type: string;
  @ApiProperty({
    enum: ['active', 'pending', 'suspended'],
    description:
      'The ACCOUNT state, and only that: whether this person may sign in. It is deliberately not a verification state — read `emailVerified` and `kycStatus` for those. "pending" here means the account itself is not yet active, and says nothing about documents.',
  })
  @NotClientField('a lifecycle state or classification the desk acts on, not client-owned data')
  status: string;

  @ApiProperty({
    description:
      'Whether the client confirmed the address they registered with. Separate from KYC: an unconfirmed email is a self-service problem the client can fix, while a KYC decision is work for a reviewer.',
  })
  @NotClientField('a lifecycle state or classification the desk acts on, not client-owned data')
  emailVerified: boolean;

  @ApiProperty({
    enum: ['not_started', 'in_progress', 'submitted', 'under_review', 'approved', 'rejected'],
    description:
      "The client's identity-verification state, joined from kyc_submissions. Total: a client who never began verification reads as 'not_started' rather than null.",
  })
  @NotClientField('a lifecycle state or classification the desk acts on, not client-owned data')
  kycStatus: string;

  @ApiProperty({
    enum: [0, 1],
    description:
      'The verification TIER the account has reached (0 or 1), which gates what the client may do. Not a synonym for `kycStatus`: a rejected submission leaves the level at 0, and the reason lives in the status.',
  })
  @NotClientField('a lifecycle state or classification the desk acts on, not client-owned data')
  verificationLevel: number;

  /*
   * DECLARED because it is RETURNED. `UsersStore.findPage` projects `phone` on
   * every client row and this DTO did not mention it — a contract the generated
   * frontend types were missing, and a hole in masking-by-shape: `applyMask`
   * strips by PATH from the real object and does not care what the DTO says,
   * while the response interceptor can only remove what the shape declares. An
   * under-declared field is therefore invisible to the new mechanism and still
   * in the body.
   *
   * Found by deleting `applyMaskAll` from `listClients` and watching the
   * interceptor cover email, name and country and MISS this one.
   */
  @ClientField('client.phone')
  @ApiPropertyOptional({ type: String, nullable: true })
  phone?: string | null;

  @ClientField('client.country')
  @ApiPropertyOptional()
  country?: string;
  @ClientField('client.createdAt')
  @ApiPropertyOptional()
  createdAt?: Date;
  @ClientField('client.tags')
  @ApiPropertyOptional({ type: [ClientTagDto] })
  tags?: ClientTagDto[];

  /*
   * Who introduced them — the Referrals page's "Introduced by" column. Built
   * for a whole page in one scoped query (`withReferrers`), with the profile's
   * three-way rule: absent for nobody, identity for an introducer the reader
   * may see, `outsideTerritory` alone for one they may not.
   */
  @ApiPropertyOptional({
    type: ClientRowReferrerDto,
    description:
      'The partner who introduced this client. Absent when nobody did, and absent for a ' +
      'reader without ib.view — the screen tells the two apart by its own permission check.',
  })
  @NotClientField(
    'not a client-owned attribute — referrer describes the record rather than the person',
  )
  referrer?: ClientRowReferrerDto;
}

@NoClientFields(
  'an administrative or configuration shape - no client-owned field on it; the client-carrying shapes in this file are marked field by field',
)
export class ProfileTradingAccountDto {
  @ApiProperty() id: string;
  @ApiProperty({
    type: 'string',
    nullable: true,
    description:
      'The MT5 login, NULL until MT5 issues one — the same contract the accounts ' +
      'directory states. A blank where a login belongs is how a real account reads as a ' +
      'broken row, so a reader has to be told which of the two it is.',
  })
  mt5Login: string | null;
  @ApiPropertyOptional() mt5Group?: string;
  @ApiProperty({ enum: ['live', 'demo'] }) environment: string;
  // No `tier`: the column behind it has never had a writer, so the field was
  // absent from every response this shape has ever described.
  @ApiPropertyOptional() leverage?: number;
  @ApiProperty() createdAt: Date;
}

export class ProfileReferrerDto {
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiPropertyOptional({ description: 'Absent when the introducer is outside your territory.' })
  ibUserId?: number;
  /*
   * IDENTITY IS OMITTED WHEN THE INTRODUCER IS OUTSIDE THE READER'S TERRITORY.
   *
   * This card was built unscoped on purpose, and the argument was sound as far
   * as it went: hiding the introducer because they sit outside the reader's tag
   * scope would render the false sentence "not introduced by a partner", which
   * is the bug the card was added to fix. What it missed is that those are not
   * the only two options — the same codebase had already solved it for the IB
   * partner parent with `parentOutsideTerritory`, which keeps the true sentence
   * without handing over an out-of-territory person's email and name.
   *
   * The FIELD MASK already covered a mask-restricted reader. What it could not
   * cover is the scoped-desk admin who holds every field permission and simply
   * may not see this person's row — territory is rows, masking is columns, and
   * only one of the two was applied here.
   */
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiPropertyOptional({
    type: 'integer',
    description:
      'The introducer’s Portal ID — what the profile links by. Absent, with the rest of their ' +
      'identity, when the introducer is outside your territory.',
  })
  portalId?: number;
  @ClientField('client.email')
  @ApiPropertyOptional({ description: 'Absent when the introducer is outside your territory.' })
  email?: string;
  @ClientField('client.firstName')
  @ApiPropertyOptional({ description: 'Absent when the introducer is outside your territory.' })
  firstName?: string;
  @ClientField('client.lastName')
  @ApiPropertyOptional({ description: 'Absent when the introducer is outside your territory.' })
  lastName?: string;
  @NotClientField('a visibility state about the reader, not an attribute of the person')
  @ApiProperty({
    description:
      'True when this client WAS introduced by a partner the reader may not see. Keeps ' +
      '“introduced, by someone outside your territory” distinct from “not introduced”.',
  })
  outsideTerritory: boolean;
  @ApiPropertyOptional({
    description:
      'False when the attribution was switched off. Absent when the introducer is outside your ' +
      'territory: whether a partner you may not see is suspended is not yours to learn.',
  })
  @NotClientField('a lifecycle state or classification the desk acts on, not client-owned data')
  active?: boolean;
  @NotClientField('a timestamp the system recorded, describing the record rather than the client')
  @ApiProperty()
  since: Date;
}

export class ProfileReferredClientDto {
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty()
  clientUserId: number;
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty({ type: 'integer', example: 1000245, description: 'Their Portal ID.' })
  clientPortalId: number;
  @ClientField('client.email')
  @ApiProperty()
  email: string;
  @ClientField('client.firstName')
  @ApiProperty()
  firstName: string;
  @ClientField('client.lastName')
  @ApiProperty()
  lastName: string;
  @NotClientField('a lifecycle state or classification the desk acts on, not client-owned data')
  @ApiProperty()
  active: boolean;
  @NotClientField('a timestamp the system recorded, describing the record rather than the client')
  @ApiProperty()
  since: Date;
}

@NoClientFields(
  'an administrative or configuration shape - no client-owned field on it; the client-carrying shapes in this file are marked field by field',
)
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
/**
 * One client's ACCOUNT fields — what an edit answers with.
 *
 * Deliberately not `ClientProfileDto`, which is the full profile SCREEN: that
 * one carries tags, KYC and trading accounts as required properties, and an
 * edit endpoint does not load any of them. Reusing it would have published a
 * contract promising three collections the response never contains, and the
 * admin console generates its client from exactly that contract — so the lie
 * would have surfaced as a runtime undefined rather than a compile error.
 */
export class ClientAccountDto {
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty({
    type: 'integer',
    example: 1000245,
    description: 'The client’s Portal ID — their one id (0159).',
  })
  id: number;
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty({ type: 'integer', example: 1000245, description: 'The client’s Portal ID.' })
  portalId: number;
  @ClientField('client.email')
  @ApiProperty()
  email: string;
  @ClientField('client.firstName')
  @ApiProperty()
  firstName: string;
  @ClientField('client.lastName')
  @ApiProperty()
  lastName: string;
  @NotClientField('a lifecycle state or classification the desk acts on, not client-owned data')
  @ApiProperty({ enum: ['individual', 'referral', 'partner'] })
  type: string;
  @NotClientField('a lifecycle state or classification the desk acts on, not client-owned data')
  @ApiProperty({ enum: ['active', 'pending', 'suspended'] })
  status: string;
  @NotClientField('a lifecycle state or classification the desk acts on, not client-owned data')
  @ApiProperty({ enum: [0, 1] })
  verificationLevel: number;

  @ApiProperty({
    description:
      'Reset to false by an email change, and stays false until the new address is verified.',
  })
  @NotClientField('a lifecycle state or classification the desk acts on, not client-owned data')
  emailVerified: boolean;

  @ClientField('client.country')
  @ApiProperty({ type: String, nullable: true })
  country: string | null;
  @ClientField('client.phone')
  @ApiProperty({ type: String, nullable: true })
  phone: string | null;
  // The rest of the profile (0139), each behind its own mask key.
  @ClientField('client.dateOfBirth')
  @ApiProperty({ type: String, nullable: true, example: '1990-04-12' })
  dateOfBirth: string | null;
  @ClientField('client.nationality')
  @ApiProperty({ type: String, nullable: true })
  nationality: string | null;
  @ClientField('client.address')
  @ApiProperty({ type: String, nullable: true })
  address: string | null;
  @ClientField('client.city')
  @ApiProperty({ type: String, nullable: true })
  city: string | null;
  @ClientField('client.stateProvince')
  @ApiProperty({ type: String, nullable: true })
  stateProvince: string | null;
  @ClientField('client.postalCode')
  @ApiProperty({ type: String, nullable: true })
  postalCode: string | null;
  @ClientField('client.createdAt')
  @ApiProperty()
  createdAt: Date;

  @ApiProperty({
    type: [String],
    description:
      'Fields withheld from THIS response by the reader’s role (RBAC-03). A masked field is ' +
      'absent from the payload entirely, so this list is the only way to tell "hidden from you" ' +
      'apart from "this client has none" — an empty box otherwise reads as the second.',
  })
  @NotClientField('the mask reporting on ITSELF, so the screen can say hidden rather than empty')
  maskedFields: string[];
}

export class ClientProfileDto {
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty({
    type: 'integer',
    example: 1000245,
    description: 'The client’s Portal ID — their one id (0159).',
  })
  id: number;
  /**
   * The client's PORTAL ID — the human number, 1,000,000 up (migration 0133).
   * What staff read and search by; `id` stays the key for URLs and the API.
   */
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty({ type: Number, example: 1000001 })
  portalId: number;
  @ClientField('client.email')
  @ApiPropertyOptional()
  email?: string;
  @ClientField('client.firstName')
  @ApiPropertyOptional()
  firstName?: string;
  @ClientField('client.lastName')
  @ApiPropertyOptional()
  lastName?: string;
  @NotClientField('a lifecycle state or classification the desk acts on, not client-owned data')
  @ApiProperty({ enum: ['individual', 'referral', 'partner'] })
  type: string;
  @NotClientField('a lifecycle state or classification the desk acts on, not client-owned data')
  @ApiProperty({ enum: ['active', 'pending', 'suspended'] })
  status: string;
  @NotClientField('a lifecycle state or classification the desk acts on, not client-owned data')
  @ApiProperty({ enum: [0, 1] })
  verificationLevel: number;
  @NotClientField(
    'a verification STATUS rather than the address; the catalogue offers no key for it, and hiding it would blank the badge rather than protect anything',
  )
  @ApiProperty()
  emailVerified: boolean;
  @ClientField('client.country')
  @ApiPropertyOptional()
  country?: string;
  @ClientField('client.phone')
  @ApiPropertyOptional()
  phone?: string;
  // The rest of the profile (0139), each behind its own mask key.
  @ClientField('client.dateOfBirth')
  @ApiPropertyOptional({ example: '1990-04-12' })
  dateOfBirth?: string;
  @ClientField('client.nationality')
  @ApiPropertyOptional()
  nationality?: string;
  @ClientField('client.address')
  @ApiPropertyOptional()
  address?: string;
  @ClientField('client.city')
  @ApiPropertyOptional()
  city?: string;
  @ClientField('client.stateProvince')
  @ApiPropertyOptional()
  stateProvince?: string;
  @ClientField('client.postalCode')
  @ApiPropertyOptional()
  postalCode?: string;
  @ClientField('client.createdAt')
  @ApiPropertyOptional()
  createdAt?: Date;

  @ClientField('client.tags')
  @ApiProperty({ type: [ClientTagDto] })
  tags: ClientTagDto[];

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string' },
    description:
      'The details THIS admin may not change right now, each with the sentence saying why — a review is checking it, or it was verified and they may not correct verified details (`adminEditRule`). Present only for a reader holding clients.edit; empty when nothing is held.',
  })
  @NotClientField(
    "the verification's rule about the record, in the system's words — which fields are locked, never their values",
  )
  lockedFields?: Record<string, string>;

  @ApiPropertyOptional({
    type: [String],
    description:
      'Verified details THIS admin may correct: they change only with a `reason`, are recorded on the verification, and the client is told. Present only for a reader holding clients.edit.',
  })
  @NotClientField("the verification's rule about the record — which fields, never their values")
  correctableFields?: string[];
  @ApiPropertyOptional({ type: ProfileKycDto, description: 'Absent without kyc.view.' })
  @NotClientField(
    'not a client-owned attribute \u2014 kyc describes the record rather than the person',
  )
  kyc?: ProfileKycDto;

  @ApiPropertyOptional({
    type: [String],
    description: 'Document filenames. Absent without kyc.documents.view.',
  })
  @NotClientField(
    'not a client-owned attribute \u2014 documents describes the record rather than the person',
  )
  documents?: string[];

  @ApiPropertyOptional({
    type: [ProfileTradingAccountDto],
    description: 'Absent without trading.view.',
  })
  @NotClientField(
    'not a client-owned attribute \u2014 tradingAccounts describes the record rather than the person',
  )
  tradingAccounts?: ProfileTradingAccountDto[];

  @ApiPropertyOptional({
    type: ProfileReferrerDto,
    description:
      'Absent without ib.view, and absent when nobody introduced this client — the UI tells ' +
      'the two apart by its own permission check.',
  })
  @NotClientField(
    'not a client-owned attribute \u2014 referrer describes the record rather than the person',
  )
  referrer?: ProfileReferrerDto;

  @ApiPropertyOptional({
    type: [ProfileReferredClientDto],
    description:
      'Newest first, and CAPPED at one screen — read `referredTotal` for how many there ' +
      'actually are, NEVER this array\u2019s length, which is the count of what fitted. ' +
      'Absent without ib.view; empty when none — those are different facts. ' +
      'SCOPED to the reader\u2019s territory, like every other client row.',
  })
  @NotClientField(
    'not a client-owned attribute \u2014 referredClients describes the record rather than the person',
  )
  referredClients?: ProfileReferredClientDto[];

  @ApiPropertyOptional({
    description:
      'How many referredClients were RETURNED — the size of what fitted on one screen. ' +
      'Useless alone and it was, until `referredTotal` landed: the cap is published nowhere, ' +
      'so `referredShown: 50` cannot be told from a partner with exactly fifty. The PAIR is ' +
      'what a screen needs — "50 of 213" — and neither half gets there without the other.',
  })
  @NotClientField(
    'a money, paging or configuration value on the RECORD, carrying no client attribute',
  )
  referredShown?: number;

  @ApiPropertyOptional({
    description:
      'How many clients this client introduced IN TOTAL, counted in SQL and SCOPED to the ' +
      'reader\u2019s territory. Distinct from `referredClients.length`, which is capped — a ' +
      'screen showing a total must read THIS. Present exactly when `referredClients` is, so ' +
      '"may not see" stays absent rather than zero.\n\n' +
      '⚠️ It is the reader\u2019s count, not the partner\u2019s: a scoped admin sees how many ' +
      'of this partner\u2019s clients fall inside their own territory, matching what ' +
      'GET /admin/clients?referredBy= returns for them. An unscoped total here would put ' +
      '"50 of 213" above a filtered list of 60.',
  })
  @NotClientField(
    'a money, paging or configuration value on the RECORD, carrying no client attribute',
  )
  referredTotal?: number;

  @ApiPropertyOptional({
    description:
      'How many of this partner’s referrals fall OUTSIDE the reader’s territory, and so ' +
      'appear in neither `referredClients` nor `referredTotal`. Zero for an unrestricted reader. ' +
      'Present exactly when `referredClients` is.\n\n' +
      'It exists because every other number here is scoped, which is right for "50 of 213" and ' +
      'wrong for nothing at all: a scoped admin opening a partner whose whole downline sits in ' +
      'another territory saw an empty tab, and an empty tab reads as "introduced nobody". A ' +
      'COUNT is the smallest thing that can be said without misleading them — no name, no ' +
      'email, no id, nothing that identifies a client they may not see.',
  })
  @NotClientField(
    'a money, paging or configuration value on the RECORD, carrying no client attribute',
  )
  referredOutsideScope?: number;

  @NotClientField('the mask reporting on ITSELF, so the screen can say hidden rather than empty')
  @ApiProperty({ type: [String] })
  maskedFields: string[];
}

export class ClientListResponseDto {
  @NotClientField(
    'a money, paging or configuration value on the RECORD, carrying no client attribute',
  )
  @ApiProperty({ type: [ClientRowDto] })
  items: ClientRowDto[];

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
  @NotClientField('the mask reporting on ITSELF, so the screen can say hidden rather than empty')
  maskedFields: string[];
  /**
   * Pass back as `?cursor=` for the next page; `null` on the last (R-2.4).
   *
   * This, not `total`, is what says whether there is more — counting is a full
   * scan of the filtered set and is only performed on request.
   */
  @ApiProperty({ type: String, nullable: true })
  @NotClientField(
    'a money, paging or configuration value on the RECORD, carrying no client attribute',
  )
  nextCursor: string | null;

  @ApiPropertyOptional({
    description: 'Only when ?withTotal=true. Counting 219,000 rows is a full scan.',
  })
  @NotClientField(
    'a money, paging or configuration value on the RECORD, carrying no client attribute',
  )
  total?: number;
  @NotClientField(
    'a money, paging or configuration value on the RECORD, carrying no client attribute',
  )
  @ApiProperty()
  page: number;
  @NotClientField(
    'a money, paging or configuration value on the RECORD, carrying no client attribute',
  )
  @ApiProperty()
  limit: number;
}

@NoClientFields(
  'an administrative or configuration shape - no client-owned field on it; the client-carrying shapes in this file are marked field by field',
)
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

@NoClientFields(
  'an administrative or configuration shape - no client-owned field on it; the client-carrying shapes in this file are marked field by field',
)
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
  @ApiProperty({
    type: 'string',
    nullable: true,
    description:
      'Arabic shown to clients reading the portal in Arabic (0179); null = not translated.',
  })
  labelAr: string | null;
  @ApiProperty() createdAt: Date;
}

@NoClientFields(
  'an administrative or configuration shape - no client-owned field on it; the client-carrying shapes in this file are marked field by field',
)
export class PermissionItemDto {
  @ApiProperty() key: string;
  @ApiProperty() label: string;
}

@NoClientFields(
  'an administrative or configuration shape - no client-owned field on it; the client-carrying shapes in this file are marked field by field',
)
export class PermissionModuleDto {
  @ApiProperty() moduleName: string;
  @ApiProperty() description: string;
  @ApiProperty({ type: [PermissionItemDto] }) permissions: PermissionItemDto[];
}

@NoClientFields(
  'an administrative or configuration shape - no client-owned field on it; the client-carrying shapes in this file are marked field by field',
)
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
  @NotClientField(
    'not a client-owned attribute \u2014 email describes the record rather than the person',
  )
  email: string;
  @ApiProperty({ description: 'Used only to greet the invitee by name.' })
  @NotClientField('an ADMINISTRATOR attribute \u2014 this describes the operator, never a client')
  name: string;
  @ApiProperty({
    enum: ['sub_admin'],
    description: 'Always sub_admin — an invite cannot mint a master.',
  })
  @NotClientField('a lifecycle state or classification the desk acts on, not client-owned data')
  role: 'sub_admin';
}

/**
 * `POST /admin/invite/accept` — the account it just created.
 *
 * No tokens in the body, like every other session-establishing response here:
 * the cookies are set on the response and the admin app reads none of them.
 */
@NoClientFields(
  'an administrative or configuration shape - no client-owned field on it; the client-carrying shapes in this file are marked field by field',
)
export class AcceptInviteResponseDto {
  @ApiProperty({ example: 'Account created. Set up your authenticator app to finish.' })
  message: string;
  @ApiProperty({ enum: ['totp', 'totp_setup'] }) step: 'totp' | 'totp_setup';
  @ApiProperty() challengeToken: string;
  @ApiProperty({ example: 600 }) expiresInSeconds: number;
}

/** An invite that has been sent and not yet accepted. Never carries the token. */
export class PendingInviteDto {
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty()
  id: string;
  @NotClientField('the invited ADMINISTRATOR, not a client')
  @ApiProperty()
  email: string;
  @NotClientField('an ADMINISTRATOR attribute \u2014 this describes the operator, never a client')
  @ApiProperty()
  name: string;
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiPropertyOptional()
  roleId?: string;
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty({ description: 'Admin id of whoever sent it.' })
  invitedBy: string;
  @ApiProperty({ description: 'After this the link is dead; re-invite to replace it.' })
  @NotClientField('a timestamp the system recorded, describing the record rather than the client')
  expiresAt: Date;
  @NotClientField('a timestamp the system recorded, describing the record rather than the client')
  @ApiProperty()
  createdAt: Date;
}

/** One entry in the action-filter vocabulary — see audit-actions.catalog.ts. */
@NoClientFields(
  'an administrative or configuration shape - no client-owned field on it; the client-carrying shapes in this file are marked field by field',
)
export class AuditActionDto {
  @ApiProperty() action: string;
  @ApiProperty() label: string;
  @ApiProperty({ description: 'Groups the filter, so 30+ entries stay readable.' })
  group: string;
}

export class AuditEntryDto {
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty()
  id: string;
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty()
  actorId: string;
  /*
   * CONDITIONALLY client-owned, so it is masked by `maskAuditRow` rather than
   * declared here — see `common/security/audit-detail-fields.ts`.
   *
   * This carried the reason "the ACTOR who performed the action, AN
   * ADMINISTRATOR; a client field mask has no standing over it". That was true
   * of the table as first written. `actorKind`, a few lines below, was added to
   * this same class BECAUSE it stopped being true — its comment opens "The
   * table assumed an admin" — and this sentence was not revisited, so a
   * fully-masked operator could read client addresses out of the `Actor email`
   * column of `/admin/audit-log/export`.
   *
   * It stays `@NotClientField` because the alternative is worse: `maskByShape`
   * would hide the field on EVERY row, including the administrator actors that
   * are the whole reason the log exists. The decision needs the sibling
   * `actorKind`, which a shape walker cannot see.
   */
  @NotClientField(
    'client-owned only when actorKind is `client`, which a per-field shape walk cannot express; masked by maskAuditRow at both read sites instead',
  )
  @ApiPropertyOptional({
    description:
      'Absent when the actor is a client and the reader may not see client addresses. ' +
      'The column is NOT NULL, so absence can only mean the mask removed it.',
  })
  actorEmail?: string;
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
  @NotClientField('a lifecycle state or classification the desk acts on, not client-owned data')
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
  @NotClientField(
    'not a client-owned attribute \u2014 ipAddress describes the record rather than the person',
  )
  ipAddress?: string | null;
  @NotClientField(
    'not a client-owned attribute \u2014 action describes the record rather than the person',
  )
  @ApiProperty()
  action: string;
  @NotClientField('a lifecycle state or classification the desk acts on, not client-owned data')
  @ApiProperty()
  subjectType: string;
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty()
  subjectId: string;
  /*
   * The CLIENT the row concerns, by the number staff know them by — the
   * client the database stamped on the row (`audit_log.client_id`, 0156). The
   * screen shows this instead of a uuid.
   */
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty({
    type: 'integer',
    nullable: true,
    example: 1000245,
    description:
      'The Portal ID of the client this row is about, or null when it is about no client (a ' +
      'role edit, a setting) or the client no longer exists.',
  })
  clientPortalId: number | null;
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty({
    type: 'integer',
    nullable: true,
    example: 1000245,
    description:
      'The actor’s Portal ID when the actor is a CLIENT; null for an administrator, the system ' +
      'or a provider, none of whom has one.',
  })
  actorPortalId: number | null;
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty({
    type: 'integer',
    nullable: true,
    example: 1000245,
    description:
      'The subject’s Portal ID when the subject IS a client — shown in place of `subjectId`. ' +
      'Null for any other subject: a transaction, a wallet or a role keeps its own id.',
  })
  subjectPortalId: number | null;
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description:
      'As recorded, except that any client uuid inside it is shown as that client’s Portal ID.',
  })
  @NotClientField(
    'not a client-owned attribute \u2014 details describes the record rather than the person',
  )
  details?: Record<string, unknown>;
  @NotClientField('a timestamp the system recorded, describing the record rather than the client')
  @ApiProperty()
  createdAt: Date;
}

@NoClientFields(
  'an administrative or configuration shape - no client-owned field on it; the client-carrying shapes in this file are marked field by field',
)
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
  /**
   * Client fields withheld from THIS page by the reader's role (RBAC-03) —
   * `maskAuditRow` removes them from `details` and from a client actor's row.
   * Returned since the audit read learned to mask, and declared since the
   * response projection (28 Sep 2026) made an undeclared key a refusal.
   */
  @ApiProperty({ type: [String] })
  maskedFields: string[];
}

export { MessageResponseDto } from '../../../common/dto/message-response.dto';

// ── Money (ARCHITECTURE §6: every monetary field is a STRING) ────────────────

/**
 * `POST /admin/wallets/credit` — the deposit the credit wrote, and whether this
 * request replayed an earlier one.
 *
 * The route declared `TransactionDto` while answering this WRAPPER, so the
 * published contract described a shape the route never sent — the console
 * hand-declared the real one. Found by the response projection's census
 * (28 Sep 2026), which would otherwise have stripped `replayed` and
 * `transaction` as undeclared and emptied the response.
 */
@NoClientFields(
  'the outcome of a hand credit: a transaction addressed by ids (TransactionDto, exempt) and a replay flag - no client-owned field',
)
export class WalletCreditResultDto {
  @ApiProperty({ type: TransactionDto }) transaction: TransactionDto;
  @ApiProperty({
    description: 'True when the idempotency key replayed an earlier credit — nothing moved again.',
  })
  replayed: boolean;
}

/**
 * `POST /admin/trading-accounts/:id/fund` — both legs of a hand movement.
 *
 * A DEPOSIT is a wallet credit then a transfer: `transaction` is the credit and
 * `transferError` says why the onward leg did not go through, when it did not.
 * A WITHDRAWAL writes no transaction row (`transaction` is null) and cannot
 * half-happen (`transferError` is null). Declared as `TransactionDto` until the
 * 28 Sep 2026 projection audit — the same wrong-wrapper declaration as the
 * credit above, and invisible to the census because no test drove the route
 * past its scope check.
 */
@NoClientFields(
  'the outcome of a hand trading-account movement: a transaction and a transfer addressed by ids (both exempt shapes), a replay flag and an error sentence - no client-owned field',
)
export class TradingAccountFundResultDto {
  @ApiProperty({ type: TransactionDto, nullable: true }) transaction: TransactionDto | null;
  @ApiProperty() replayed: boolean;
  @ApiProperty({ type: TransferDto, nullable: true }) transfer: TransferDto | null;
  @ApiProperty({ type: String, nullable: true }) transferError: string | null;
  @ApiPropertyOptional({ enum: ['wallet'], description: 'Where the money went, on a withdrawal.' })
  destination?: 'wallet';
}

/**
 * The client behind a payout — and the reason three of its four fields are
 * OPTIONAL.
 *
 * RBAC-03 masks by OMISSION, so a desk read by a restricted admin returns this
 * object without `email`, `firstName` or `lastName`. Declaring them required
 * would put that lie into `types.gen.ts` in both frontends: the admin app would
 * compile `user.email.toLowerCase()` happily and throw at runtime, on the one
 * code path only a restricted operator ever reaches — which is to say, the path
 * least likely to be exercised before a customer finds it.
 *
 * `id` stays required. The row is addressed by it, which is why the catalog
 * marks `client.id` unmaskable.
 */
export class WithdrawalUserDto {
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty()
  id: string;
  /** The client's Portal ID — what staff read and search by. Never masked. */
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty({ type: Number, example: 1000001 })
  portalId: number;
  @ClientField('client.email')
  @ApiPropertyOptional()
  email?: string;
  @ClientField('client.firstName')
  @ApiPropertyOptional()
  firstName?: string;
  @ClientField('client.lastName')
  @ApiPropertyOptional()
  lastName?: string;
}

/** Who will pay an open withdrawal, and what it costs (0173). */
@NoClientFields(
  'the platform’s plan for a payout — who pays and what it costs, no client attribute',
)
export class PayoutPlanDto {
  @ApiProperty({ enum: ['provider', 'desk', 'paused'] })
  payer: 'provider' | 'desk' | 'paused';
  @ApiPropertyOptional({ type: String, nullable: true, description: 'The provider’s name.' })
  provider: string | null;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Why nobody can pay it right now — the sentence approval would refuse with.',
  })
  reason: string | null;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'What the provider will be asked to move (a fee it deducts added on top).',
  })
  gross: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, description: 'Its fee, when known.' })
  fee: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, description: 'What arrives.' })
  net: string | null;
}

export class WithdrawalRowDto {
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty()
  id: string;
  @ApiProperty({
    description: 'Monetary value — always a string, never a number',
  })
  @NotClientField(
    'a money, paging or configuration value on the RECORD, carrying no client attribute',
  )
  amount: string;
  // A CODE, not a fixed set — currencies are operator data (see WalletDto).
  @NotClientField(
    'a money, paging or configuration value on the RECORD, carrying no client attribute',
  )
  @ApiProperty({ description: 'A currency code.', example: 'USD' })
  currency: string;
  @ApiProperty({
    enum: transactionStateEnum.enumValues,
  })
  @NotClientField('a lifecycle state or classification the desk acts on, not client-owned data')
  state: string;
  @NotClientField('a lifecycle state or classification the desk acts on, not client-owned data')
  @ApiProperty()
  provider: string;
  /*
   * The route the withdrawal was filed on (0168) — which provider pays it, on
   * which of its payout channels, in which environment. Fixed at filing.
   */
  @NotClientField(
    'the route the money takes, a classification of the record, not client-owned data',
  )
  @ApiProperty({ example: 'rival', description: 'The payment provider that pays it.' })
  providerCode: string;
  @NotClientField(
    'the route the money takes, a classification of the record, not client-owned data',
  )
  @ApiProperty({ example: 'whish', description: 'The provider’s payout channel.' })
  channelCode: string;
  @NotClientField(
    'the route the money takes, a classification of the record, not client-owned data',
  )
  @ApiProperty({ enum: ['live', 'sandbox'], example: 'live' })
  providerEnvironment: string;
  /*
   * Who pays it if approved NOW: the provider (an automated payout it can
   * take) or the desk by hand. On the queue only; an action response omits it.
   */
  @NotClientField(
    'the route the money takes, a classification of the record, not client-owned data',
  )
  @ApiPropertyOptional({ enum: ['provider', 'desk'] })
  paidBy?: 'provider' | 'desk';
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
  @NotClientField(
    'not a client-owned attribute \u2014 methodName describes the record rather than the person',
  )
  @ApiProperty({ example: 'Whish Money' })
  methodName: string;
  @NotClientField(
    'not a client-owned attribute \u2014 providerRef describes the record rather than the person',
  )
  @ApiPropertyOptional({ type: String, nullable: true })
  providerRef?: string | null;
  /* Where the client is paid — a bank account, wallet address or payment
     phone. Personal data, hideable since D-82 (it was "not client-owned"). */
  @ClientField('client.payoutDestination')
  @ApiPropertyOptional({ type: String, nullable: true })
  destination?: string | null;
  @NotClientField(
    'not a client-owned attribute \u2014 rejectionReason describes the record rather than the person',
  )
  @ApiPropertyOptional({ type: String, nullable: true })
  rejectionReason?: string | null;
  @NotClientField(
    'not a client-owned attribute \u2014 the Arabic of rejectionReason describes the record',
  )
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'The reason in Arabic as the client was shown it (0179). Null when none.',
  })
  rejectionReasonAr?: string | null;
  @NotClientField('a timestamp the system recorded, describing the record rather than the client')
  @ApiProperty()
  requestedAt: Date;
  @NotClientField('a timestamp the system recorded, describing the record rather than the client')
  @ApiPropertyOptional({ type: Date, nullable: true })
  reviewedAt?: Date | null;
  /**
   * The reviewer's NAME, resolved from `reviewedBy`.
   *
   * The id has been recorded on every decision since this lifecycle existed
   * and no screen rendered it, because a uuid is not an answer to "who
   * approved this" — on a console that splits approve from settle so two
   * people can be required, the one screen showing the decision could name
   * neither. Null when nobody has reviewed it, or when the administrator who
   * decided has since been deleted: an absence the screen states rather than
   * filling with the id.
   */
  @NotClientField('an ADMINISTRATOR attribute \u2014 this describes the operator, never a client')
  @ApiPropertyOptional({ type: String, nullable: true })
  reviewedByName?: string | null;
  @NotClientField('a timestamp the system recorded, describing the record rather than the client')
  @ApiPropertyOptional({ type: Date, nullable: true })
  settledAt?: Date | null;
  /*
   * ── The payout at its provider, provider-neutral (0173) ──────────────────
   * (Named `rival*` until 0173; the old names went in 0176.)
   */
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'The provider’s id for the payout, once it holds it. Null before.',
  })
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  providerPayoutId?: string | null;
  @ApiPropertyOptional({
    type: Date,
    nullable: true,
    description:
      'When the payout was sent. Set with no provider id = its outcome is being reconciled.',
  })
  @NotClientField('a timestamp the system recorded, describing the record rather than the client')
  providerSubmittedAt?: Date | null;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'What the provider was asked to move (the amount grossed up by its fee).',
  })
  @NotClientField('a figure the system recorded about the payout, not an attribute of the person')
  providerRequestAmount?: string | null;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'The fee the provider reported.',
  })
  @NotClientField('a figure the provider reported about the payout, not an attribute of the person')
  providerFee?: string | null;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'What the provider reported delivering to the destination.',
  })
  @NotClientField('a figure the provider reported about the payout, not an attribute of the person')
  providerNetAmount?: string | null;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'The provider’s own last word on the payout, raw ("executing", "COMPLETED").',
  })
  @NotClientField('the provider’s status of the record, not an attribute of the person')
  providerStatus?: string | null;
  @ApiProperty({ description: 'A person must look at this payout (every provider).' })
  @NotClientField(
    'not a client-owned attribute \u2014 it describes the record rather than the person',
  )
  needsAttention: boolean;
  @ApiPropertyOptional({
    type: 'string',
    nullable: true,
    description: 'WHY it needs attention, in words the operator can act on.',
  })
  @NotClientField(
    'not a client-owned attribute \u2014 it describes the record rather than the person',
  )
  attentionReason?: string | null;
  @ApiPropertyOptional({
    type: () => PayoutPlanDto,
    nullable: true,
    description: 'Who will pay an open withdrawal and what it costs; null once it is decided.',
  })
  @NotClientField('the platform’s own plan for the payout, not an attribute of the person')
  payoutPlan?: PayoutPlanDto | null;
  @ApiPropertyOptional({
    type: 'string',
    nullable: true,
    description:
      'The payment provider OPERATOR\u2019s own note on a refused payout (Rival adminNotes). ' +
      'Admin-only: the client is told a fixed sentence in rejectionReason. Null when none.',
  })
  @NotClientField(
    'the provider operator\u2019s note about the record, not an attribute of the person',
  )
  providerNote?: string | null;
  @NotClientField(
    'the nested person, whose own shape carries the marks \u2014 masked there, not here',
  )
  @ApiProperty({ type: WithdrawalUserDto })
  user: WithdrawalUserDto;

  /*
   * ── What the four TRANSITIONS return, and the desk does not ──────────────
   *
   * approve / reject / settle / cancel all declare this DTO and hand back the
   * transaction ROW, which carries ten keys the desk list never sends. So the
   * declaration was a contract lie: both frontends typed those responses as a
   * desk row, `user` included, and would have read `undefined` from a field
   * TypeScript promised. Nothing broke only because the admin discards the body
   * and refetches (`transactions/page.tsx` — `onSuccess: async (_data, row)`).
   *
   * It is NOT a masking leak — the transitions return no `user` object at all,
   * so there was never a client field on them to hide. It is the OTHER half:
   * a response the shape did not admit to, exactly what `phone` was on
   * ClientRowDto. Declared here rather than split into a second DTO, because
   * one resource keeps one shape and every addition is optional, so the desk's
   * rows still satisfy it.
   */
  @NotClientField('addresses the record\u2019s owner; client.id is unmaskable for that reason')
  @ApiPropertyOptional({ type: 'integer' })
  userId?: number;
  @NotClientField('an identifier addressing the wallet, not an attribute of the person')
  @ApiPropertyOptional({ type: String })
  walletId?: string;
  @NotClientField('a lifecycle state or classification the desk acts on, not client-owned data')
  @ApiPropertyOptional({ type: String })
  direction?: string;
  @NotClientField('operator configuration naming the rail, carrying no client attribute')
  @ApiPropertyOptional({ type: String, nullable: true })
  methodKey?: string | null;
  @NotClientField('operator configuration naming the rail, carrying no client attribute')
  @ApiPropertyOptional({ type: String, nullable: true })
  withdrawalMethodKey?: string | null;
  @NotClientField('an identifier addressing a trading account, not an attribute of the person')
  @ApiPropertyOptional({ type: String, nullable: true })
  destinationTradingAccountId?: string | null;
  @NotClientField('the ADMIN who decided; an operator identity, never client-owned data')
  @ApiPropertyOptional({ type: String, nullable: true })
  reviewedBy?: string | null;
  @NotClientField('a payment-provider reference describing the record rather than the person')
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'The provider’s own id for the movement: its invoice, its payment id.',
  })
  providerPaymentId?: string | null;
  @NotClientField('a timestamp the system recorded, describing the record rather than the client')
  @ApiPropertyOptional({ type: Date, nullable: true })
  createdAt?: Date | null;
  @NotClientField('the interceptor\u2019s own report of what it hid, not client data')
  @ApiPropertyOptional({ type: [String] })
  maskedFields?: string[];
}

export class WithdrawalListResponseDto {
  @NotClientField(
    'the nested rows, whose own shape carries the marks \u2014 masked there, not here',
  )
  @ApiProperty({ type: [WithdrawalRowDto] })
  items: WithdrawalRowDto[];
  /**
   * Pass back as `?cursor=` for the next page; `null` on the last (R-2.4).
   *
   * This, not `total`, is what says whether there is more — counting is a full
   * scan of the filtered set and is only performed on request.
   */
  @NotClientField(
    'a money, paging or configuration value on the RECORD, carrying no client attribute',
  )
  @ApiProperty({ type: String, nullable: true })
  nextCursor: string | null;

  @NotClientField(
    'a money, paging or configuration value on the RECORD, carrying no client attribute',
  )
  @ApiProperty()
  total: number;
  @NotClientField(
    'a money, paging or configuration value on the RECORD, carrying no client attribute',
  )
  @ApiProperty()
  page: number;
  @NotClientField(
    'a money, paging or configuration value on the RECORD, carrying no client attribute',
  )
  @ApiProperty()
  limit: number;
  @NotClientField(
    'a money, paging or configuration value on the RECORD, carrying no client attribute',
  )
  @ApiProperty({ type: 'object', additionalProperties: { type: 'number' } })
  counts: Record<string, number>;
  /**
   * RBAC-03: the `withdrawal.*` keys hidden from this viewer, omitted from
   * every row's `user`.
   *
   * A property of the VIEWER, not of a row, so it is sent once at the top
   * rather than repeated per item. Without it the desk renders an em dash and
   * "hidden from you" becomes indistinguishable from "no email on file".
   */
  @NotClientField('the mask reporting on ITSELF, so the screen can say hidden rather than empty')
  @ApiPropertyOptional({ type: [String] })
  maskedFields?: string[];
}

// ── The Financial page: every money movement, platform-wide ─────────────────

export class AdminTransactionRowDto {
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty()
  id: string;
  /**
   * What a renderer BRANCHES on — a `payment` crossed the platform boundary
   * through a provider, a `transfer` moved wallet ⇄ trading account, a
   * `commission_transfer` moved a partner's earnings to their main wallet.
   * The vocabulary is the union's own (`TransactionsService.movementsCte`),
   * not a table enum.
   */
  @ApiProperty({ enum: TRANSACTION_KINDS })
  @NotClientField('a lifecycle state or classification the desk acts on, not client-owned data')
  kind: string;
  /**
   * Stated FROM THE WALLET'S SIDE for every kind — a wallet→account transfer
   * reads as a withdrawal. Screens print the direction ONLY for payments and
   * branch on `kind` for the rest, the rule the client portal already follows.
   */
  @ApiProperty({ enum: transactionDirectionEnum.enumValues })
  @NotClientField('a lifecycle state or classification the desk acts on, not client-owned data')
  direction: string;
  /**
   * One vocabulary for both tables: transfer states arrive pre-mapped
   * (settled→success, failed→failure). `approved`/`rejected` can only occur
   * on `kind: payment` withdrawal rows — tabs and tiles must not promise them
   * for transfers.
   */
  @ApiProperty({ enum: transactionStateEnum.enumValues })
  @NotClientField('a lifecycle state or classification the desk acts on, not client-owned data')
  state: string;
  @ApiProperty({
    type: 'string',
    example: '250.00000000',
    description:
      'Monetary value — ALWAYS a string, never a number. NUMERIC(28,8) exceeds what a ' +
      'JavaScript number represents exactly (§6.1).',
  })
  @NotClientField(
    'a money, paging or configuration value on the RECORD, carrying no client attribute',
  )
  amount: string;
  // A CODE, not a fixed set — currencies are operator data (see WalletDto).
  @NotClientField(
    'a money, paging or configuration value on the RECORD, carrying no client attribute',
  )
  @ApiProperty({ description: 'A currency code.', example: 'USD' })
  currency: string;
  /**
   * What to CALL the rail on screen, resolved server-side — the
   * `WithdrawalRowDto.methodName` rule. Falls back to `provider` where no
   * method was named: historical rows, and both transfer kinds, whose
   * providers ('transfer' / 'commission') the screens translate via `kind`.
   */
  @NotClientField(
    'not a client-owned attribute \u2014 methodName describes the record rather than the person',
  )
  @ApiProperty({ example: 'Whish Money' })
  methodName: string;
  /** An OPEN set no screen may switch on exhaustively (see TransactionDto). */
  @NotClientField('a lifecycle state or classification the desk acts on, not client-owned data')
  @ApiProperty()
  provider: string;
  @NotClientField(
    'not a client-owned attribute \u2014 providerRef describes the record rather than the person',
  )
  @ApiPropertyOptional({ type: String, nullable: true })
  providerRef?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'The provider’s own id for the movement: its invoice, its payment id.',
  })
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  providerPaymentId?: string | null;
  /* Where the client is paid — a bank account, wallet address or payment
     phone. Personal data, hideable since D-82 (it was "not client-owned"). */
  @ClientField('client.payoutDestination')
  @ApiPropertyOptional({ type: String, nullable: true })
  destination?: string | null;
  /** Also carries a transfer's failure reason — one column for "why not". */
  @NotClientField(
    'not a client-owned attribute \u2014 rejectionReason describes the record rather than the person',
  )
  @ApiPropertyOptional({ type: String, nullable: true })
  rejectionReason?: string | null;
  @NotClientField(
    'not a client-owned attribute \u2014 the Arabic of rejectionReason describes the record',
  )
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'The reason in Arabic as the client was shown it (0179). Null when none.',
  })
  rejectionReasonAr?: string | null;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'The trading account a TRANSFER moved money to or from. Null on other kinds.',
  })
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  tradingAccountId?: string | null;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'The RECEIPT on an offline deposit — the stored filename, served from ' +
      'GET /v1/uploads/deposit-proofs/<file>. Null on every other movement. On the list so the ' +
      'deposit desk can show the image beside the row it decides on, rather than fetching one ' +
      'per row.',
  })
  @NotClientField(
    'a file the CLIENT uploaded about a payment, addressing the record rather than describing the person',
  )
  proofFilename?: string | null;
  @ApiPropertyOptional({
    type: ProofDetailDto,
    isArray: true,
    nullable: true,
    description:
      'What the client gave with an OFFLINE deposit to identify the payment — the phone it was ' +
      'sent from, a transfer code — each with the question as asked (0163). Null otherwise. ' +
      'Never masked: it is the proof the desk approves the deposit on, like the receipt.',
  })
  @NotClientField(
    'proof of a payment the CLIENT filed with the receipt; the desk must always see it to approve',
  )
  proofDetails?: ProofDetailDto[] | null;
  @ApiPropertyOptional({
    type: PayToDetailDto,
    isArray: true,
    nullable: true,
    description:
      "Where an OFFLINE deposit's client was told to send the money — the details the method " +
      'showed when it was filed, e.g. the phone a transfer goes to (0199). A copy: the method ' +
      'may have changed since. Null otherwise.',
  })
  @NotClientField(
    "the BROKER's own payment details as shown on the deposit screen, not anything about the client",
  )
  payToDetails?: PayToDetailDto[] | null;
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty()
  walletId: string;
  @NotClientField('a timestamp the system recorded, describing the record rather than the client')
  @ApiProperty()
  createdAt: Date;
  @NotClientField('a timestamp the system recorded, describing the record rather than the client')
  @ApiPropertyOptional({ type: Date, nullable: true })
  settledAt?: Date | null;
  /*
   * When an operator decided it — approved, refused or settled. Null for money
   * no person decided (a gateway deposit, a transfer). The client profile's
   * Details view shows it beside the rejection reason.
   */
  @NotClientField('a timestamp the system recorded, describing the record rather than the client')
  @ApiPropertyOptional({ type: Date, nullable: true })
  reviewedAt?: Date | null;
  /**
   * A person must reconcile this payment — the platform reported another
   * amount, reversed it, paid against a failed row, or disagrees about a
   * payout's outcome. The page badges the row and offers "Mark resolved",
   * which is what ends the admin task about it. Always false on a transfer.
   */
  @NotClientField('a lifecycle flag the desk acts on, describing the record rather than the person')
  @ApiProperty({ description: 'A person must reconcile this payment. False on transfers.' })
  needsAttention: boolean;
  @NotClientField('system-written text about the record, not an attribute of the person')
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'WHY it needs attention, in words the operator can act on. Null when not flagged.',
  })
  attentionReason?: string | null;
  @NotClientField(
    'the provider operator\u2019s note about the record, not an attribute of the person',
  )
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'The payment provider operator\u2019s own note on a refused payout. Admin-only; the ' +
      'client sees a fixed sentence. Null on every other row.',
  })
  providerNote?: string | null;
  @NotClientField(
    'the nested person, whose own shape carries the marks \u2014 masked there, not here',
  )
  @ApiProperty({ type: WithdrawalUserDto })
  user: WithdrawalUserDto;
}

export class AdminTransactionListResponseDto {
  @NotClientField(
    'the nested rows, whose own shape carries the marks \u2014 masked there, not here',
  )
  @ApiProperty({ type: [AdminTransactionRowDto] })
  items: AdminTransactionRowDto[];
  /** Pass back as `?cursor=` for the next page; `null` on the last (R-2.4). */
  @NotClientField(
    'a money, paging or configuration value on the RECORD, carrying no client attribute',
  )
  @ApiProperty({ type: String, nullable: true })
  nextCursor: string | null;
  @NotClientField(
    'a money, paging or configuration value on the RECORD, carrying no client attribute',
  )
  @ApiProperty()
  total: number;
  @NotClientField(
    'a money, paging or configuration value on the RECORD, carrying no client attribute',
  )
  @ApiProperty()
  page: number;
  @NotClientField(
    'a money, paging or configuration value on the RECORD, carrying no client attribute',
  )
  @ApiProperty()
  limit: number;
  /**
   * Per-STATE sizes plus `all`, ignoring the active state filter but never
   * the scope — the withdrawal queue's two-axis rule, so the state tabs show
   * every state's size whichever tab is active.
   */
  @NotClientField(
    'a money, paging or configuration value on the RECORD, carrying no client attribute',
  )
  @ApiProperty({ type: 'object', additionalProperties: { type: 'number' } })
  counts: Record<string, number>;
  /**
   * Per-DIRECTION sizes plus `all`, ignoring the direction/kind filter but
   * never the scope — the same rule on the other axis, for the page's
   * deposit/withdrawal tabs.
   */
  @NotClientField(
    'a money, paging or configuration value on the RECORD, carrying no client attribute',
  )
  @ApiProperty({ type: 'object', additionalProperties: { type: 'number' } })
  directionCounts: Record<string, number>;
  /**
   * RBAC-03 — which `financial.*` catalog keys were REMOVED from these rows
   * for this viewer, so the screen can say "hidden by your permissions"
   * rather than rendering an absence that reads as "this client has no
   * email". Only ever `financial.`-prefixed: a response announces its own
   * paths and nobody else's.
   */
  @NotClientField('the mask reporting on ITSELF, so the screen can say hidden rather than empty')
  @ApiPropertyOptional({ type: [String] })
  maskedFields?: string[];
}

@NoClientFields(
  'an administrative or configuration shape - no client-owned field on it; the client-carrying shapes in this file are marked field by field',
)
export class AdminTransactionSummaryRowDto {
  @ApiProperty({ enum: transactionDirectionEnum.enumValues }) direction: string;
  @ApiProperty({ enum: TRANSACTION_KINDS }) kind: string;
  @ApiProperty({ enum: transactionStateEnum.enumValues })
  state: string;
  /**
   * Part of the GROUP KEY, not decoration: a sum across currencies is not a
   * number, so totals only ever arrive per-currency and the page may render
   * them or drop them — never add them.
   */
  @ApiProperty({ example: 'USD' }) currency: string;
  @ApiProperty() count: number;
  @ApiProperty({
    type: 'string',
    example: '1250.50000000',
    description: 'Server-computed SUM as a string — the page renders it, never recomputes it.',
  })
  total: string;
}

/**
 * One direction's total over the filtered set, per currency — what the page's
 * headline tiles render. Coarser than `rows` on purpose: a tile saying
 * "Deposits — $12,400" must be ONE server-computed number, and deriving it
 * from `rows` would mean the page adding decimal strings, which it never does.
 */
@NoClientFields(
  'an administrative or configuration shape - no client-owned field on it; the client-carrying shapes in this file are marked field by field',
)
export class AdminTransactionDirectionTotalDto {
  @ApiProperty({ enum: transactionDirectionEnum.enumValues }) direction: string;
  /** Part of the group key — a sum across currencies is not a number. */
  @ApiProperty({ example: 'USD' }) currency: string;
  @ApiProperty() count: number;
  @ApiProperty({
    type: 'string',
    example: '12400.00000000',
    description: 'Server-computed SUM as a string — rendered, never recomputed.',
  })
  total: string;
}

@NoClientFields(
  'an administrative or configuration shape - no client-owned field on it; the client-carrying shapes in this file are marked field by field',
)
export class AdminTransactionsSummaryDto {
  @ApiProperty({ type: [AdminTransactionSummaryRowDto] })
  rows: AdminTransactionSummaryRowDto[];
  @ApiProperty({ type: [AdminTransactionDirectionTotalDto] })
  directions: AdminTransactionDirectionTotalDto[];
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
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty()
  id: string;
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty({ type: 'integer', example: 1000245, description: 'The owner’s Portal ID.' })
  portalId: number;
  @ClientField('client.email')
  @ApiProperty()
  email: string;
  @ClientField('client.firstName')
  @ApiProperty()
  firstName: string;
  @ClientField('client.lastName')
  @ApiProperty()
  lastName: string;
}

export class WalletRowDto {
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty()
  id: string;
  @ApiProperty({
    example: '4f7kq2nm8xcb',
    description:
      'Human-friendly wallet number — 12 lowercase Crockford base32 chars. ' +
      'Display and support reference only; `id` remains the key.',
  })
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  walletNumber: string;
  @ApiProperty({
    example: 'USD Wallet',
    description:
      'The wallet name — "<CURRENCY> Wallet", or "Commission Wallet" for a partner earnings ' +
      'wallet. Generated by the database from `currency` and `kind`, so the console, the portal ' +
      'and a CSV export cannot disagree about what one wallet is called.',
  })
  /*
   * Not client data: it is composed from the CURRENCY and the KIND, both of
   * which are platform configuration. Two different clients holding a USD
   * wallet have identically-named wallets, so the string says nothing about
   * the person behind the record.
   */
  @NotClientField('composed from the currency and the wallet kind, both platform configuration')
  name: string;
  @ApiProperty({
    type: 'string',
    example: '250.00000000',
    description:
      'Monetary value — ALWAYS a string, never a number. NUMERIC(28,8) exceeds what a ' +
      'JavaScript number represents exactly, so Number()/parseFloat lose value before any ' +
      'formatting starts (§6.1).',
  })
  @NotClientField(
    'a money, paging or configuration value on the RECORD, carrying no client attribute',
  )
  balance: string;
  @ApiProperty({
    type: 'string',
    example: '0.00000000',
    description:
      'Reserved against a pending transfer — a string for the same reason as `balance`. ' +
      'Available = balance − onHold, and that subtraction belongs in decimal arithmetic.',
  })
  @NotClientField(
    'a money, paging or configuration value on the RECORD, carrying no client attribute',
  )
  onHold: string;
  @NotClientField(
    'a money, paging or configuration value on the RECORD, carrying no client attribute',
  )
  @ApiProperty({ example: 'USD' })
  currency: string;
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
  @NotClientField('a lifecycle state or classification the desk acts on, not client-owned data')
  kind: 'main' | 'commission';
  @NotClientField('a timestamp the system recorded, describing the record rather than the client')
  @ApiProperty()
  createdAt: Date;
  @NotClientField('a timestamp the system recorded, describing the record rather than the client')
  @ApiProperty()
  updatedAt: Date;
  @NotClientField(
    'the nested person, whose own shape carries the marks \u2014 masked there, not here',
  )
  @ApiProperty({ type: HoldingOwnerDto })
  user: HoldingOwnerDto;
}

@NoClientFields(
  'an administrative or configuration shape - no client-owned field on it; the client-carrying shapes in this file are marked field by field',
)
export class WalletListResponseDto {
  @ApiProperty({ type: [WalletRowDto] }) items: WalletRowDto[];
  /** Pass back as `?cursor=` for the next page; `null` on the last (R-2.4). */
  @ApiProperty({ type: String, nullable: true }) nextCursor: string | null;
  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
  /*
   * DECLARED because it is RETURNED. The desk began reporting its mask when the
   * wallet and trading-account exposures were closed, and the envelope was never
   * updated — so both frontends' generated types were missing the one field that
   * tells a screen "hidden" rather than "empty".
   *
   * Found by `response-completeness.spec.ts` on the change that introduced it,
   * which is the whole point of checking a real response against the shape that
   * claims to describe it.
   */
  @NotClientField('the mask reporting on ITSELF, so the screen can say hidden rather than empty')
  @ApiPropertyOptional({ type: [String] })
  maskedFields?: string[];
}

/** MT5's account holder, as the account sync read it (0166) — a person, masked as one. */
export class Mt5HolderDto {
  @ClientField('client.lastName')
  @ApiPropertyOptional({ type: String, nullable: true })
  name?: string | null;
  @ClientField('client.email')
  @ApiPropertyOptional({ type: String, nullable: true })
  email?: string | null;
}

export class TradingAccountRowDto {
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty()
  id: string;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'The MT5 login, once there is an MT5 to issue one. NULL until assigned, and a STRING ' +
      'rather than a number because leading zeros are significant to the bridge.',
  })
  @NotClientField(
    'the MT5 account NUMBER \u2014 identifying, but the catalogue defines no key to hide it',
  )
  login?: string | null;
  @NotClientField(
    'a money, paging or configuration value on the RECORD, carrying no client attribute',
  )
  @ApiPropertyOptional({ type: String, nullable: true })
  mt5Group?: string | null;
  @NotClientField('a lifecycle state or classification the desk acts on, not client-owned data')
  @ApiProperty({ enum: ['live', 'demo'] })
  environment: string;
  @NotClientField(
    'a money, paging or configuration value on the RECORD, carrying no client attribute',
  )
  @ApiProperty({ example: 'USD' })
  currency: string;
  @ApiProperty({
    type: 'string',
    example: '1000.00000000',
    description:
      'Monetary value — ALWAYS a string. The CRM mirror of the MT5 balance, kept by the ' +
      "bridge's push and sweep (see the schema comment).",
  })
  @NotClientField(
    'a money, paging or configuration value on the RECORD, carrying no client attribute',
  )
  balance: string;
  /**
   * The product this account was opened under, replacing `tier`.
   *
   * `trading_accounts.tier` has never had a writer, so the key it filled was
   * NULL on every row this endpoint has ever returned. Resolved from the
   * account's own `product_id` first and the catalogue second — see
   * `common/account-product` — so the operator and the client read the same
   * answer off the same account.
   *
   * NULL is a real state: an account may be opened straight into an MT5 group
   * the catalogue does not sell.
   */
  @NotClientField(
    'not a client-owned attribute \u2014 product describes the record rather than the person',
  )
  @ApiPropertyOptional({ type: String, nullable: true })
  product?: string | null;
  /**
   * When MT5 last confirmed `balance`. NULL means never.
   *
   * The list serves a MIRROR — the bridge refreshes it on its sweep rather than
   * the console calling MT5 once per row — so the age is part of the answer. A
   * mirrored figure rendered without it reads as live, which is the one thing it
   * must not do.
   */
  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  @NotClientField('a timestamp the system recorded, describing the record rather than the client')
  balanceSyncedAt?: Date | null;
  @NotClientField(
    'a money, paging or configuration value on the RECORD, carrying no client attribute',
  )
  @ApiPropertyOptional({ type: Number, nullable: true })
  leverage?: number | null;
  @NotClientField('a lifecycle state or classification the desk acts on, not client-owned data')
  @ApiProperty({ enum: ['active', 'suspended', 'closed'] })
  status: string;
  @NotClientField('a timestamp the system recorded, describing the record rather than the client')
  @ApiProperty()
  createdAt: Date;
  @NotClientField('a timestamp the system recorded, describing the record rather than the client')
  @ApiProperty()
  updatedAt: Date;
  @NotClientField(
    'the nested person, whose own shape carries the marks \u2014 masked there, not here',
  )
  @ApiProperty({ type: HoldingOwnerDto, nullable: true })
  user: HoldingOwnerDto | null;
  /**
   * MT5's holder name and email, as the sync read them: how an operator matches an
   * account with no client (0166, `user` NULL) to a client. NULL on accounts the
   * CRM opened, and when the reader's role hides client names / emails.
   */
  @NotClientField('the nested person, whose own shape carries the marks — masked there, not here')
  @ApiPropertyOptional({ type: () => Mt5HolderDto, nullable: true })
  mt5Holder?: Mt5HolderDto | null;
}

@NoClientFields(
  'an administrative or configuration shape - no client-owned field on it; the client-carrying shapes in this file are marked field by field',
)
export class TradingAccountListResponseDto {
  @ApiProperty({ type: [TradingAccountRowDto] }) items: TradingAccountRowDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor: string | null;
  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
  /*
   * DECLARED because it is RETURNED. The desk began reporting its mask when the
   * wallet and trading-account exposures were closed, and the envelope was never
   * updated — so both frontends' generated types were missing the one field that
   * tells a screen "hidden" rather than "empty".
   *
   * Found by `response-completeness.spec.ts` on the change that introduced it,
   * which is the whole point of checking a real response against the shape that
   * claims to describe it.
   */
  @NotClientField('the mask reporting on ITSELF, so the screen can say hidden rather than empty')
  @ApiPropertyOptional({ type: [String] })
  maskedFields?: string[];
}

@NoClientFields(
  'an administrative or configuration shape - no client-owned field on it; the client-carrying shapes in this file are marked field by field',
)
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
@NoClientFields(
  'an administrative or configuration shape - no client-owned field on it; the client-carrying shapes in this file are marked field by field',
)
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
@NoClientFields(
  'an administrative or configuration shape - no client-owned field on it; the client-carrying shapes in this file are marked field by field',
)
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
/**
 * ⚠️ THIS NOW CARRIES CLIENT IDENTITY, and it did not until 14 Sep 2026.
 *
 * The reconciliation report named clients by uuid alone — on the one screen
 * whose entire job is to say that a SPECIFIC client's money does not add up.
 * An operator reading it had to resolve the id by hand before they could act.
 *
 * Masked on the admin path by `FieldMaskInterceptor`, like every other shape
 * here. Note the mask is independent of client SCOPE: this route already
 * refuses a territory-scoped actor outright, because a reconciliation over part
 * of the ledger cannot answer whether the ledger balances — but an unscoped
 * administrator may still hold a field mask, and it applies.
 */
export class WalletDiscrepancyDto {
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty()
  walletId: string;

  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty({
    example: '4f7kq2nm8xcb',
    description: 'The wallet’s human-friendly number — display only; `walletId` is the key.',
  })
  walletNumber: string;

  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty()
  userId: number;

  /** The client's Portal ID — the identifier an operator quotes. Never masked. */
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty({ type: Number, nullable: true, example: 1000001 })
  userPortalId: number | null;

  /* Nullable for the LEFT join's reason — see the service. A discrepancy must
     not disappear because the client row did. */
  @ClientField('client.firstName')
  @ApiProperty({ type: 'string', nullable: true })
  userFirstName: string | null;

  @ClientField('client.lastName')
  @ApiProperty({ type: 'string', nullable: true })
  userLastName: string | null;

  @ClientField('client.email')
  @ApiProperty({ type: 'string', nullable: true })
  userEmail: string | null;

  @NotClientField('a figure about a wallet, not an attribute of the person it belongs to')
  @ApiProperty()
  currency: string;

  @NotClientField('a figure about a wallet, not an attribute of the person it belongs to')
  @ApiProperty({
    type: 'string',
    example: '150.00000000',
    description: 'What the wallet row claims. Monetary value — always a string.',
  })
  balance: string;

  @NotClientField('a figure about a wallet, not an attribute of the person it belongs to')
  @ApiProperty({
    type: 'string',
    example: '149.00000000',
    description: 'What its ledger entries actually sum to. Monetary value — always a string.',
  })
  ledgerSum: string;

  @NotClientField('a figure about a wallet, not an attribute of the person it belongs to')
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
/*
 * No class-level exemption here any more, and its absence is required rather
 * than an oversight: this references `WalletDiscrepancyDto`, which now carries
 * client identity, and GUARD 1 of `client-field-coverage.spec.ts` refuses an
 * exempt class that reaches one holding client fields. The report's OWN fields
 * are platform-wide integrity figures and say so individually.
 */
export class ReconciliationReportDto {
  @NotClientField('a platform-wide integrity figure, not an attribute of any person')
  @ApiProperty({ description: 'When this run completed (ISO 8601).' })
  checkedAt: string;

  @NotClientField('a platform-wide integrity figure, not an attribute of any person')
  @ApiProperty({ description: 'How many wallets were compared against their ledgers.' })
  walletsChecked: number;

  @NotClientField(
    'the sample of mismatched wallets; whose data each row holds is declared on WalletDiscrepancyDto itself',
  )
  @ApiProperty({
    type: [WalletDiscrepancyDto],
    description:
      'A SAMPLE — the largest discrepancies by absolute difference, capped at 20. Empty when ' +
      'every wallet agrees with its ledger. Read `discrepancyCount` for how many there really ' +
      'are: a screen that counts this array reports 20 on a database with thousands.',
  })
  walletDiscrepancies: WalletDiscrepancyDto[];

  @NotClientField('a platform-wide integrity figure, not an attribute of any person')
  @ApiProperty({
    description:
      'How many wallets disagree in total, independent of the capped sample above. Counted in ' +
      'SQL, so it is exact.',
  })
  discrepancyCount: number;

  @NotClientField('a platform-wide integrity figure, not an attribute of any person')
  @ApiProperty({
    description:
      'The SUM OF ABSOLUTE differences across every mismatched wallet — the size of the problem. ' +
      'Absolute rather than net, so two large opposite errors do not report as nearly balanced. ' +
      'Monetary value — always a string.',
    example: '24995.35000000',
  })
  totalDifference: string;

  @NotClientField('a platform-wide integrity figure, not an attribute of any person')
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
@NoClientFields(
  'an administrative or configuration shape - no client-owned field on it; the client-carrying shapes in this file are marked field by field',
)
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
@NoClientFields(
  'an administrative or configuration shape - no client-owned field on it; the client-carrying shapes in this file are marked field by field',
)
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
@NoClientFields(
  'an administrative or configuration shape - no client-owned field on it; the client-carrying shapes in this file are marked field by field',
)
export class AdminProfileNameDto {
  @ApiProperty({ example: 'Ada Lovelace' })
  name: string;
}

/**
 * One CLOSED position on the client profile's Positions tab, built from the
 * ingested MT5 deals: the closing deal, plus its opening deal when that was
 * ingested too.
 *
 * Prices carry more decimals than money and both cross as STRINGS — §6.1 for
 * the money, and for the prices because a JPY pair quotes to 3 places while
 * most others quote to 5, so there is no single float that round-trips them.
 */
@NoClientFields(
  'an administrative or configuration shape - no client-owned field on it; the client-carrying shapes in this file are marked field by field',
)
export class ClientClosedPositionRowDto {
  @ApiProperty({ description: 'The closing deal’s CRM id.' }) id: string;
  @ApiProperty({ description: 'The closing deal’s MT5 ticket.' }) ticket: string;
  @ApiProperty({ type: 'string', nullable: true, description: 'The MT5 position id.' })
  positionId: string | null;
  @ApiProperty({ description: 'The MT5 login it was traded on.' }) login: string;
  @ApiProperty({ enum: ['live', 'demo'] }) environment: string;
  @ApiProperty() symbol: string;
  @ApiProperty({
    enum: ['buy', 'sell'],
    description: 'The POSITION’s side — the opening deal’s, not the closing deal’s.',
  })
  side: string;
  @ApiProperty({ type: 'string', example: '0.20000000', description: 'Lots closed.' })
  volume: string;
  @ApiProperty({
    type: 'string',
    nullable: true,
    description: 'NULL when the opening deal was never ingested (opened before the CRM was).',
  })
  openPrice: string | null;
  @ApiProperty({ type: 'string' }) closePrice: string;
  @ApiProperty({ type: 'string', description: 'The realised result of the closing deal.' })
  profit: string;
  @ApiProperty({
    type: 'string',
    description:
      'MT5 commission on the trade: opening and closing deal together. Negative is charged.',
  })
  commission: string;
  @ApiProperty({ type: 'string' }) swap: string;
  @ApiProperty() currency: string;
  @ApiProperty({
    type: Date,
    nullable: true,
    description: 'NULL when the opening deal is unknown.',
  })
  openedAt: Date | null;
  @ApiProperty() closedAt: Date;
}

@NoClientFields(
  'an administrative or configuration shape - no client-owned field on it; the client-carrying shapes in this file are marked field by field',
)
export class ClientClosedPositionsPageDto {
  @ApiProperty({ type: [ClientClosedPositionRowDto] }) rows: ClientClosedPositionRowDto[];
  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
}

/** One movement of a client's money, in either direction. */
@NoClientFields(
  'an administrative or configuration shape - no client-owned field on it; the client-carrying shapes in this file are marked field by field',
)
export class ClientTransactionRowDto {
  @ApiProperty() id: string;
  @ApiProperty({ enum: ['deposit', 'withdrawal', 'transfer'] }) direction: string;
  @ApiProperty() state: string;
  @ApiProperty({ type: 'string', example: '250.00000000', description: 'A decimal string (§6.1).' })
  amount: string;
  @ApiProperty() currency: string;
  @ApiProperty({ type: 'string', nullable: true }) methodKey: string | null;
  @ApiProperty({
    type: 'string',
    nullable: true,
    description:
      'The payment or payout method’s display name. Null for money that went through no method ' +
      '— a manual credit (`provider` = manual_admin) — which a screen names from `provider`.',
  })
  methodName: string | null;
  @ApiProperty({ type: 'string', nullable: true }) provider: string | null;
  @ApiProperty({ type: 'string', nullable: true }) providerRef: string | null;
  @ApiProperty() createdAt: Date;
  @ApiProperty({ type: Date, nullable: true }) settledAt: Date | null;
}

@NoClientFields(
  'an administrative or configuration shape - no client-owned field on it; the client-carrying shapes in this file are marked field by field',
)
export class ClientTransactionsPageDto {
  @ApiProperty({ type: [ClientTransactionRowDto] }) rows: ClientTransactionRowDto[];
  @ApiProperty() total: number;
  @ApiProperty() page: number;
  @ApiProperty() limit: number;
}

/** RBAC-08 — an administrator exempt from the network check (0192). */
@NoClientFields(
  'an administrative or configuration shape - no client-owned field on it; the client-carrying shapes in this file are marked field by field',
)
export class IpAllowlistExemptionDto {
  @ApiProperty() adminId: string;
  @ApiProperty() name: string;
  @ApiProperty()
  @NotClientField('an ADMINISTRATOR attribute — this describes the operator, never a client')
  email: string;
  @ApiProperty({ example: 'Owner, travels' }) reason: string;
  @ApiProperty() createdBy: string;
  @ApiProperty({ nullable: true, type: String, description: 'Null once the granter is deleted.' })
  createdByName: string | null;
  @ApiProperty() createdAt: string;
}

/** RBAC-08 — one allowlist rule. */
@NoClientFields(
  'an administrative or configuration shape - no client-owned field on it; the client-carrying shapes in this file are marked field by field',
)
export class IpAllowlistRuleDto {
  @ApiProperty() id: string;
  @ApiProperty({ example: '203.0.113.0/24' }) cidr: string;
  @ApiProperty({ example: 'Beirut office' }) label: string;
  @ApiProperty() createdBy: string;
  @ApiProperty() createdAt: string;
}

@NoClientFields(
  'an administrative or configuration shape - no client-owned field on it; the client-carrying shapes in this file are marked field by field',
)
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

  /**
   * Enforcement switched off by `ADMIN_IP_ALLOWLIST_ENABLED=false`, with the
   * rules left in place.
   *
   * Distinct from `enforced: false` with an empty list. "Nobody has configured
   * this yet" and "somebody turned it off and the rules are still here" are
   * different situations and the console must not render them alike.
   */
  @ApiProperty() disabledByConfig: boolean;

  @ApiProperty({ type: [IpAllowlistRuleDto] })
  rules: IpAllowlistRuleDto[];

  @ApiProperty({
    type: [IpAllowlistExemptionDto],
    description: 'Administrators who may reach the console from any network (0192).',
  })
  exemptAdmins: IpAllowlistExemptionDto[];

  @ApiProperty({
    description:
      'Whether the requesting administrator is exempt — they cannot lock themselves out.',
  })
  youAreExempt: boolean;
}

/**
 * How many transfers are stuck, for the Financial screen's banner.
 *
 * A COUNT, not a list. The transfers themselves are already rows on that table
 * and now carry the release action; what was missing was a reason to go and
 * look at them, because a stuck transfer renders as one more pending row among
 * settled history.
 *
 * The condition is the same one `TransferResumeScheduler` raises
 * `money.transfer_stuck` on. That alert is a log line and §12.3 deliberately
 * stops short of choosing a paging provider, so on a deployment with no log
 * drain it reaches nobody. This is the console's answer to that.
 */
@NoClientFields(
  'an administrative or configuration shape - no client-owned field on it; the client-carrying shapes in this file are marked field by field',
)
export class StuckTransfersDto {
  @ApiProperty({
    example: 1,
    description:
      'Transfers still pending past the staleness threshold. No money has moved on any of them.',
  })
  count: number;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When the OLDEST of them was requested, or null when there are none.',
  })
  oldestAt: Date | null;

  @ApiProperty({
    example: 15,
    description:
      'The threshold itself, in minutes. Sent so the copy can name it without the frontend ' +
      'keeping its own copy of a number this side owns and can change.',
  })
  thresholdMinutes: number;
}

/**
 * What a deposit DECISION answers with — the row as it now stands.
 *
 * Deliberately carries NO client attribute: not an email, not a name, not a
 * country. A decision response is about the record the operator just acted on,
 * and the queue they came from already carries the client. That keeps this DTO
 * outside RBAC-03 masking entirely rather than relying on every field being
 * marked correctly — the approve-response masking bug the withdrawal desk had is
 * one this shape cannot reproduce.
 */
export class DepositDecisionDto {
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty()
  id: string;

  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty({ description: 'The client this deposit belongs to.' })
  userId: number;

  @NotClientField(
    'a money, paging or configuration value on the RECORD, carrying no client attribute',
  )
  @ApiProperty({
    description: 'Monetary value — always a string, never a number',
    example: '250.00000000',
  })
  amount: string;

  @NotClientField(
    'a money, paging or configuration value on the RECORD, carrying no client attribute',
  )
  @ApiProperty({ example: 'USD' })
  currency: string;

  @NotClientField(
    'a money, paging or configuration value on the RECORD, carrying no client attribute',
  )
  @ApiProperty({ enum: ['pending', 'approved', 'success', 'failure', 'rejected'] })
  state: string;

  @NotClientField(
    'a money, paging or configuration value on the RECORD, carrying no client attribute',
  )
  @ApiPropertyOptional({ description: 'The deposit method the client chose.', nullable: true })
  methodKey: string | null;

  @NotClientField(
    'a money, paging or configuration value on the RECORD, carrying no client attribute',
  )
  @ApiPropertyOptional({ description: 'The OX- reference quoted on the transfer.', nullable: true })
  providerRef: string | null;

  @NotClientField(
    'a money, paging or configuration value on the RECORD, carrying no client attribute',
  )
  @ApiPropertyOptional({
    description:
      'The stored receipt, as `uploads/deposit-proofs/<file>`. Null when the deposit carried none.',
    nullable: true,
  })
  proofPath: string | null;

  @NotClientField(
    'a money, paging or configuration value on the RECORD, carrying no client attribute',
  )
  @ApiPropertyOptional({ nullable: true })
  rejectionReason: string | null;

  @NotClientField(
    'a money, paging or configuration value on the RECORD, carrying no client attribute',
  )
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'The reason in Arabic as the client was shown it (0179). Null when none.',
  })
  rejectionReasonAr: string | null;

  @NotClientField(
    'a money, paging or configuration value on the RECORD, carrying no client attribute',
  )
  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  reviewedAt: Date | null;

  @NotClientField(
    'a money, paging or configuration value on the RECORD, carrying no client attribute',
  )
  @ApiPropertyOptional({ nullable: true, type: String, format: 'date-time' })
  settledAt: Date | null;
}

/** A flagged provider payout, finished by a person (0174). */
@NoClientFields('the outcome of one payout’s finishing: its state and amount, no client attribute')
export class FlaggedPayoutFinishedDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ enum: ['success', 'failure'] })
  state: string;

  @ApiProperty({ type: 'string', example: '100.00000000' })
  amount: string;

  @ApiProperty()
  currency: string;
}

/** A flagged hosted deposit, finished by a person (0173). */
@NoClientFields(
  'the outcome of one deposit’s finishing: its state and credited figure, no client attribute',
)
export class FlaggedDepositFinishedDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ enum: ['success', 'failure'] })
  state: string;

  @ApiProperty({
    description: 'The credited amount (decimal string) — or the asked one when closed.',
  })
  amount: string;

  @ApiProperty()
  currency: string;
}

/**
 * The answer to "Mark resolved" on a payment that needed attention. The flag is
 * gone and, with it, every admin's task about it (migration 0140's trigger).
 */
@NoClientFields('the state of one payment’s attention flag, no client attribute')
export class AttentionResolvedDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ description: 'Always false after a successful resolve.' })
  needsAttention: boolean;
}

/** A tag an administrator's sign-up link gives — from their territory, live. */
@NoClientFields('a configuration shape: a tag, no client-owned field')
export class SignupLinkTagDto {
  @ApiProperty() id: string;
  @ApiProperty() slug: string;
  @ApiProperty() label: string;
  @ApiPropertyOptional() color?: string;
}

/** The caller's own sign-up link (0198). Counts, never who. */
@NoClientFields("the calling administrator's link and aggregate counts; no client is named")
export class MySignupLinkDto {
  @ApiProperty({ example: 'omar-farah' }) slug: string;
  @ApiProperty({ description: 'The link to hand out: <PORTAL_URL>/join/<slug>.' }) url: string;
  @ApiProperty({
    type: [SignupLinkTagDto],
    description: 'What a sign-up through it gets right now: your territory, minus countries.',
  })
  tags: SignupLinkTagDto[];
  @ApiProperty({
    description:
      'True when the link gives no tag: you see every client, or only countries. Clients you bring are recorded as yours, not put in a book.',
  })
  addsNoTag: boolean;
  @ApiProperty() signups: number;
  @ApiProperty() verified: number;
  @ApiProperty() funded: number;
}

/** One administrator's sign-up link on the Admin users page. */
@NoClientFields('a configuration shape with aggregate counts; no client is named')
export class SignupLinkRowDto {
  @ApiProperty() adminId: string;
  @ApiProperty() name: string;
  @ApiProperty() slug: string;
  @ApiProperty() url: string;
  @ApiProperty({ description: "A suspended administrator's link tags nobody." }) active: boolean;
  @ApiProperty() signups: number;
  @ApiProperty() verified: number;
  @ApiProperty() funded: number;
}

/** A sign-up link after a rename. */
@NoClientFields(
  'an administrator’s sign-up link after a rename: a word and a URL, no client-owned field',
)
export class SignupLinkUrlDto {
  @ApiProperty() slug: string;
  @ApiProperty() url: string;
}

/** What a bulk tag change did — counts, never who. */
@NoClientFields('aggregate counts of a bulk action; no client is named')
export class BulkTagResultDto {
  @ApiProperty({ description: 'Clients the action was asked about and may see.' }) matched: number;
  @ApiProperty({ description: 'Of which actually changed.' }) changed: number;
  @ApiProperty({ description: 'Of which already carried the change.' }) unchanged: number;
  @ApiProperty({ description: 'Picked clients outside your territory — skipped, never touched.' })
  skippedOutOfScope: number;
}
