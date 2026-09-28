import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import type { RejectionContext } from '../../../../store/rejection-reasons.store';
import type { KycDocumentType } from '../../../../store/kyc-config.store';
import { DOCUMENT_CATALOGUE, documentFieldType } from '../../../../common/kyc/document-catalogue';

// Request DTOs for the KYC review + step-configurator surface.
// See the note in ./auth.dto.ts for why these moved out of the controller.

const KYC_BASE_FIELD_TYPES = [
  'text',
  'date',
  'phone',
  'select',
  'file',
  'camera',
  'checkbox',
] as const;

/**
 * ⚠️ THE DOCUMENT TYPES BELONG HERE TOO, and their absence made the KYC step
 * builder unable to save at all.
 *
 * `kyc-config.store.ts` defines a field type as "a base type, or `doc:<value>`
 * for a document", and SEEDS exactly that — `doc:passport`, `doc:national_id`,
 * `doc:driving_license`, `doc:utility_bill`. GET returns them. This list did not
 * contain them, so a pure read-modify-write round trip — which is precisely what
 * the builder performs, `steps = draft ?? query.data` with no transform — came
 * back 400 VALIDATION_FAILED on every save.
 *
 * The screen reported success and nothing persisted. It was invisible because
 * the jsdom page tests mock `api.put`, so the request shape was never checked
 * against this DTO, and no browser spec clicked Save until one was written.
 *
 * DERIVED FROM THE CATALOGUE rather than hand-listed, which is what the response
 * DTO has always done (`kyc-response.dto.ts`) and what the store's own docblock
 * asks for: "the catalogue defines the document half, so a union here would have
 * to be regenerated every time one is added". Computed, so adding a document
 * cannot leave this behind again.
 */
const KYC_FIELD_TYPES = [
  ...KYC_BASE_FIELD_TYPES,
  ...DOCUMENT_CATALOGUE.map((doc) => documentFieldType(doc.value)),
] as const;

// `deposit` joins them with the offline deposit desk: a refused receipt needs a
// reason a client can act on, and typing it freehand every time is how a queue
// ends up with twelve spellings of "the image is unreadable".
const REJECTION_CONTEXTS = ['kyc', 'withdrawal', 'deposit'] as const;

/** The most a reviewer's reason may hold — it is emailed and shown as written. */
const KYC_REASON_MAX = 500;

/**
 * A reviewer's REASON on an approved verification — the correction's audit
 * note, the re-verification's message to the client. ONE rule for both: any
 * text that is not blank, trimmed, up to {@link KYC_REASON_MAX} characters.
 *
 * It demanded ten characters until it was reported on 28 Sep 2026: a reviewer
 * had to pad a complete reason ("Expired", "Wrong surname") before the button
 * would work, with nothing on screen saying why. The rule that
 * matters is that a reason EXISTS — a verified record never changes, and a
 * client is never sent back, without one — not how long it is. Whitespace is
 * trimmed first, so a reason of spaces is still no reason.
 */
function KycReason(example: string, description?: string) {
  return applyDecorators(
    ApiProperty({ example, minLength: 1, maxLength: KYC_REASON_MAX, description }),
    Transform(({ value }: { value: unknown }) =>
      typeof value === 'string' ? value.trim() : value,
    ),
    IsString(),
    IsNotEmpty({ message: 'Give a reason.' }),
    MaxLength(KYC_REASON_MAX),
  );
}

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

/**
 * Body of `POST /admin/kyc/:userId/reverify` — return an APPROVED verification
 * to the client to update. The reason is emailed to the client; the items are
 * what they must redo (identity fields by key, documents by page slot or by
 * document), shown on their form and the reviewer's.
 */
export class ReverifyKycDto {
  @KycReason('Your passport on file has expired. Please upload your new one.')
  reason: string;

  @ApiProperty({ type: [String], example: ['doc_front', 'address'], minItems: 1 })
  @IsArray()
  @ArrayNotEmpty({ message: 'Name at least one thing for the client to update.' })
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  items: string[];
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

  /**
   * ACCEPTED AND IGNORED. The GET hydrates every document field with
   * `{ value, label, category, parts[] }`, resolved from `type` when serving and
   * explicitly NOT persisted — the store says so: "the type is the only stored
   * fact".
   *
   * Declared here so the global `whitelist` pipe does not answer "property
   * document should not exist" to a client that sent back exactly what it was
   * given. An API whose GET output its own PUT refuses is a trap for every
   * consumer, not just the builder that found it.
   *
   * Not read by anything: `type` remains the single stored fact, so sending a
   * `document` that disagrees with the type changes nothing.
   */
  @ApiPropertyOptional({
    description: 'Hydrated from `type` on read. Accepted on write and ignored.',
  })
  @IsOptional()
  document?: KycDocumentType;

  /**
   * ACCEPTED AND IGNORED, like `document`: the GET marks the platform's own
   * fields (the identity fields, the selfie camera), and the builder sends back
   * what it was given. Whether a field IS the platform's is decided by the
   * server from its key and step, never by this flag — a client cannot promote
   * its own field to `system`, nor demote the platform's.
   */
  @ApiPropertyOptional({ description: 'Served on read. Accepted on write and ignored.' })
  @IsOptional()
  @IsBoolean()
  system?: boolean;
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

  /*
   * Where the step's answers are filed, and the address the client's browser
   * opens. The four built-in steps keep theirs (`personal`, `document`,
   * `selfie`, `address`); a step the broker adds is given one from its title
   * when this is left out, and an existing step keeps the one it has.
   */
  @ApiPropertyOptional({
    example: 'source-of-funds',
    description:
      "Optional for a new step (generated from its title); an existing step's never changes.",
  })
  @IsString()
  @IsNotEmpty()
  @IsOptional()
  @MaxLength(100)
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

  /*
   * ACCEPTED AND IGNORED: the GET marks the built-in steps, and the builder
   * sends back what it was given. What makes a step built-in is its slug.
   */
  @ApiPropertyOptional({ description: 'Served on read. Accepted on write and ignored.' })
  @IsOptional()
  @IsBoolean()
  core?: boolean;

  @ApiPropertyOptional({ description: 'Served on read. Accepted on write and ignored.' })
  @IsOptional()
  @IsBoolean()
  alwaysOn?: boolean;
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
  /*
   * ⚠️ `@ArrayNotEmpty` REFUSES AN EMPTY CONFIGURATION, AND IT HAS TO BE HERE.
   *
   * `KycConfigStore.setSteps` is a DELETE followed by an INSERT of whatever it
   * was handed. Given `[]` it performs the DELETE and inserts nothing, answers
   * 200, and every client's onboarding is gone — the wizard has no steps to
   * render, no client can submit, and no reviewer has anything to review. Four
   * confirmed deletions on the builder screen reach that state, and the last one
   * arrives with a success toast.
   *
   * A guard INSIDE `setSteps` would sit after the destructive half or duplicate
   * the decision beside it. The DTO refuses before the service is entered at
   * all, which is the only place the refusal costs nothing to be sure about.
   *
   * ## This does NOT reinstate the mandatory-step rule that was retired
   *
   * That rule said WHICH steps may be deleted, and it refused deletions an
   * operator legitimately wanted — which is why it went. This refuses only the
   * deletion that leaves nothing behind. Zero steps is not a configuration
   * somebody could want; it is the absence of one. Every other edit the
   * builder can make is still accepted, including deleting any step the
   * operator chooses, right down to the last one remaining.
   *
   * The admin builder disables the final Delete for the same reason, so an
   * operator does not reach this refusal by ordinary use. The two are not
   * substitutes: the screen is what means nobody meets a 400, and this is the
   * guarantee — a 400 after four confirmed deletions tells an operator their
   * work was rejected without telling them which deletion was the problem, and
   * a screen alone protects nothing against curl, a stale tab, or the next
   * client written against this API.
   */
  @ApiProperty({ type: [KycStepDto], minItems: 1 })
  @IsArray()
  @ArrayNotEmpty({
    message:
      'A KYC configuration must keep at least one step. Saving an empty list ' +
      'would remove onboarding for every client.',
  })
  @ValidateNested({ each: true })
  @Type(() => KycStepDto)
  steps: KycStepDto[];
}

/**
 * Body of `PATCH /admin/kyc/:userId/personal-info` — CORE-18.
 *
 * A reviewer's correction of an APPROVED client's verified identity: any field
 * but the phone (the desk edits that directly — no document proves it), and a
 * REASON, always. It was a date of birth or an address and nothing else, so a
 * misspelt surname on an approved client had no remedy but a rejection, which
 * shuts the money doors for a typo (the owner's ruling, 26 Sep 2026).
 *
 * Every value is re-checked by the profile's own rules; the reason goes on the
 * audit row beside the value on both sides, and the client is emailed which
 * details changed. At least one field besides the reason — an empty correction
 * would write an audit row that changed nothing.
 */
export class CorrectKycIdentityDto {
  @KycReason(
    'Surname misspelt at registration; passport reads "Haddad".',
    'Why the verified record is being changed. Recorded on the audit row.',
  )
  reason: string;

  @ApiPropertyOptional({ example: 'Layla', maxLength: 100 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  firstName?: string;

  @ApiPropertyOptional({ example: 'Haddad', maxLength: 100 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  lastName?: string;

  @ApiPropertyOptional({
    example: '1985-04-12',
    description:
      'ISO date. RE-VALIDATED through the same rules as submission: an impossible, ' +
      'future or under-18 date is REFUSED with 409, not 400 — that is a fact about the ' +
      'record rather than about what was typed.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  dateOfBirth?: string;

  @ApiPropertyOptional({ example: 'Lebanese', maxLength: 100 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  nationality?: string;

  @ApiPropertyOptional({ example: 'Lebanon', maxLength: 100 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  country?: string;

  @ApiPropertyOptional({ example: '12 Rue Verdun', maxLength: 200 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  address?: string;

  @ApiPropertyOptional({ example: 'Beirut', maxLength: 100 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  city?: string;

  @ApiPropertyOptional({
    example: '1103 2080',
    maxLength: 12,
    description: 'Send an empty string to clear it — many addresses have none.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(12)
  postalCode?: string;
}
