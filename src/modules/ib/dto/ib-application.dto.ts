import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { OptionalArabicText } from '../../../common/dto/arabic-text';
import {
  ClientField,
  NoClientFields,
  NotClientField,
} from '../../../common/security/client-field.decorator';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

export const IB_APPLICATION_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type IbApplicationStatusDto = (typeof IB_APPLICATION_STATUSES)[number];

/**
 * The programme a sub-partner inherits, named rather than merely identified.
 *
 * The id is what the application carries; the NAME is what the screen shows.
 * Sending only the id would force the portal to fetch the agency catalogue to
 * render one label — a request whose whole purpose is to look up a string the
 * API already had.
 */
export class InheritedAgencyDto {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty({
    type: 'string',
    nullable: true,
    description: 'The agency name in Arabic (0179); null = not translated, show `name`.',
  })
  nameAr: string | null;
}

/**
 * What a client sends to apply.
 *
 * The AGENCY is required and everything else is optional, and the split is the
 * whole design. An application is a request to be considered, not a form to be
 * passed: the reviewer decides from the account behind it — verified identity,
 * real activity — far more than from free text, and a mandatory `motivation`
 * only produces a paragraph written to satisfy a validator.
 *
 * "Which programme" is the exception because it is not evidence, it is the
 * REQUEST. It decides what the partner may sell, the applicant is the only one
 * who can answer it, and leaving it blank used to grant the whole catalogue.
 *
 * `expectedVolume` was here too, and went with the column — a figure the
 * applicant typed that nobody measured and no decision ever turned on. See
 * migration 0063.
 */
export class CreateIbApplicationDto {
  /**
   * The agency (وكالة) being applied for. Required for a DIRECT applicant,
   * absent BY DESIGN for an introduced one — and only the SERVICE can tell
   * them apart.
   *
   * A client introduced by an existing partner does not choose: the service
   * derives their programme from the introducer and IGNORES this field, and
   * the portal deliberately sends nothing (see apply-panel.tsx — sending a
   * copy invites the two to disagree, and the API would silently win). A bare
   * `@IsUUID()` here refused that shape at the pipe with "agencyId must be a
   * UUID" — every introduced applicant was blocked by the transport edge
   * before the rule that welcomes them could run.
   *
   * So the DTO validates the SHAPE (present means a UUID) and the service owns
   * the REQUIREMENT: `apply()` refuses a direct applicant with no agency using
   * a sentence a person can act on, which also holds for anything calling the
   * service directly. The blank-grants-everything hole this field's history
   * warns about stays closed — the refusal moved, it did not go.
   *
   * Validated against the OPEN agencies on submit. A disabled one is refused
   * rather than accepted-and-queued: the programme is closed, and letting the
   * application sit means telling somebody later that the thing they applied
   * for was never available.
   */
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Which agency the applicant wants to be appointed under. Required for an applicant who ' +
      'chooses; omitted when they were introduced by a partner — the programme is inherited from ' +
      'the introducer and anything sent here is ignored.',
  })
  @IsOptional()
  @IsUUID()
  agencyId?: string;

  @ApiPropertyOptional({
    maxLength: 2000,
    description: 'Why the client wants to introduce business. Shown to the reviewer verbatim.',
  })
  @IsOptional()
  @IsString()
  @Length(0, 2000)
  motivation?: string;

  @ApiPropertyOptional({ maxLength: 2048 })
  @IsOptional()
  @IsString()
  @Length(0, 2048)
  website?: string;
}

/*
 * Field by field since D-82: `motivation` and `website` are the applicant's own
 * words, and a class-wide "no client fields" waved them through every mask.
 */
export class IbApplicationDto {
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty()
  id: string;
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty()
  userId: number;
  @ClientField('client.partnerApplication')
  @ApiProperty({ type: 'string', nullable: true })
  motivation: string | null;
  @ClientField('client.partnerApplication')
  @ApiProperty({ type: 'string', nullable: true })
  website: string | null;
  @NotClientField('a lifecycle state or classification the desk acts on, not client-owned data')
  @ApiProperty({ enum: IB_APPLICATION_STATUSES })
  status: IbApplicationStatusDto;
  @NotClientField('the desk\u2019s decision about the record, not an attribute of the person')
  @ApiProperty({
    type: 'string',
    nullable: true,
    description: 'Already composed — this is the sentence the client is shown.',
  })
  rejectionReason: string | null;
  /**
   * Arabic for `rejectionReason` (0179): written with the decision (the
   * reviewer's own Arabic, or the configured reason's as it read then); on an
   * older refusal, the configured reason's Arabic found on read.
   */
  @NotClientField('the desk’s decision about the record, not an attribute of the person')
  @ApiPropertyOptional({
    type: 'string',
    description:
      'Arabic for `rejectionReason` — written with the decision, else the configured partner ' +
      'reason’s. Absent when there is none (show the English).',
  })
  rejectionReasonAr?: string;
  /**
   * The agency (وكالة) applied for, by NAME.
   *
   * Null on an application submitted before agencies existed, or against a
   * deployment that has none. The portal shows it on the pending card so an
   * applicant can see what they asked for while they wait — the one detail
   * they cannot otherwise recover once the form is gone.
   */
  @NotClientField('a catalogue name on the record, not an attribute of the person')
  @ApiPropertyOptional({ type: 'string', nullable: true })
  agencyName: string | null;
  /** The same agency's name in Arabic (0179); null = not translated, show `agencyName`. */
  @NotClientField('a catalogue name on the record, not an attribute of the person')
  @ApiPropertyOptional({ type: 'string', nullable: true })
  agencyNameAr?: string | null;
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty({ type: 'string', nullable: true })
  reviewedBy: string | null;
  @NotClientField('a timestamp the system recorded, describing the record rather than the client')
  @ApiProperty({ type: 'string', format: 'date-time', nullable: true })
  reviewedAt: Date | null;
  @NotClientField('a timestamp the system recorded, describing the record rather than the client')
  @ApiProperty()
  submittedAt: Date;
}

@NoClientFields(
  'the application and its commission terms; the shapes naming a PERSON in this file are marked field by field',
)
export class IbAccountDto {
  @ApiProperty({ type: 'integer' }) userId: number;
  @ApiProperty() level: number;
  @ApiProperty({
    type: 'integer',
    nullable: true,
    description:
      'Null at the top of a chain — or, on an admin response, when the parent is ' +
      'outside your territory (`parentOutsideTerritory`).',
  })
  parentIbUserId: number | null;
  @ApiPropertyOptional({
    description:
      'Admin responses only: true when a parent exists that the reader may not see. The ' +
      'fact, never the id (R1).',
  })
  parentOutsideTerritory?: boolean;
  @ApiProperty({ description: 'What a client types at registration to be attributed here.' })
  referralCode: string;
  @ApiProperty() active: boolean;

  /**
   * The agency this partner was appointed under, and what it lets them sell.
   *
   * `agencyName` is null for a partner approved before agencies existed. Their
   * clients fall back to the full catalogue, which is why `products` is empty
   * rather than wrong — an empty list here means "not narrowed", and the portal
   * says so instead of printing nothing.
   */
  @ApiPropertyOptional({ type: 'string', nullable: true }) agencyName: string | null;
  @ApiPropertyOptional({
    type: 'string',
    nullable: true,
    description: 'The agency name in Arabic (0179); null = not translated, show `agencyName`.',
  })
  agencyNameAr?: string | null;
  @ApiProperty({
    type: [String],
    description: 'Product names this partner may introduce clients to. Empty means unrestricted.',
  })
  products: string[];
  @ApiPropertyOptional({
    type: 'array',
    items: { type: 'string', nullable: true },
    description:
      'The same products in Arabic (0179), index for index with `products`; a null item is ' +
      'untranslated — show that index of `products`.',
  })
  productsAr?: (string | null)[];

  @ApiProperty() approvedAt: Date;
}

/**
 * The whole partner screen in one response.
 *
 * `account` and `application` are BOTH present because "not a partner" and
 * "rejected last week, here is why" are different states and a client shown the
 * blank form after a refusal has been told nothing. `eligible` is separate
 * again: a client who has never applied and cannot yet is a third state, and
 * the portal explains it rather than presenting a form that will be refused.
 */
export class IbStatusDto {
  @ApiProperty({ type: IbAccountDto, nullable: true }) account: IbAccountDto | null;
  @ApiProperty({ type: IbApplicationDto, nullable: true }) application: IbApplicationDto | null;
  @ApiProperty() eligible: boolean;
  @ApiProperty({ type: 'string', nullable: true }) ineligibleReason: string | null;
  /**
   * WHICH requirement is unmet, as a token rather than a sentence.
   *
   * `ineligibleReason` stays the thing a client reads, and it stays the API's
   * to word — the portal must not keep a second copy of these sentences to
   * drift. But the two reasons need different CHROME: an unverified client gets
   * "Verify your identity first" and a button to /kyc, while a client whose
   * introducer is already on the deepest rung has nothing to verify and nowhere
   * to be sent, so that same button is an instruction they cannot follow.
   *
   * A code rather than matching on the sentence, because string-matching a
   * human-facing message is broken by the first rewording — and the reword is
   * exactly what nobody remembers to check.
   *
   * Null when eligible, and the union is open-ended on purpose: a portal that
   * does not recognise a future code falls back to the plain sentence, which is
   * always safe to show.
   */
  @ApiProperty({
    type: 'string',
    nullable: true,
    enum: ['unverified', 'chain_full'],
    description:
      'Machine-readable counterpart to ineligibleReason. `unverified` — identity not verified ' +
      'yet. `chain_full` — the partner who introduced them is already on the deepest enabled ' +
      'level, so there is no rung to place them on. Null when eligible.',
  })
  ineligibleCode: IbIneligibleCode | null;

  /**
   * The programme this applicant will be placed on when it is not theirs to
   * pick — a partner introduced by another partner inherits theirs.
   *
   * NULL means the choice IS theirs, and this is what the portal keys the
   * picker off: present, hide the picker and name the programme; absent, ask.
   *
   * "A programme has been chosen for you" reads as an error for something that
   * is simply how a downline works, which is why the name travels with the id.
   */
  @ApiProperty({
    type: InheritedAgencyDto,
    nullable: true,
    description:
      'Set when the applicant was introduced by an existing partner and therefore inherits that ' +
      "partner's programme — the portal must not offer a choice in that case. Null when the " +
      'applicant chooses: any client not introduced by a partner, or one whose introducer ' +
      'carries no programme.',
  })
  inheritedAgency: InheritedAgencyDto | null;
}

/**
 * @see IbStatusDto.ineligibleCode
 *
 * `'chain_full'` is BACK. It went in 0102 with the first ladder; 0112 made the
 * rung a partner stands on their whole terms again, and the business rule
 * followed: a client whose introducer stands on the deepest ENABLED level of
 * the Commission Levels ladder has no rung to be placed on and cannot become
 * a partner. The Swagger enum on `IbStatusDto.ineligibleCode` kept advertising
 * both codes throughout, so the wire contract does not move.
 *
 * The portal branches on the code — `chain_full` draws no "Verify now" button,
 * hides the Partner page from a client with no application history, and
 * `RequireAuth` bounces a typed URL. The next gate should extend this union
 * rather than reintroduce a second field beside it.
 */
export type IbIneligibleCode = 'unverified' | 'chain_full';

export class ApproveIbApplicationDto {
  /*
   * ── `programId` IS GONE (0112) ────────────────────────────────────────────
   *
   * A reviewer used to appoint a partner onto a named commission programme.
   * Terms come from the partner's RUNG now, which follows from who recruited
   * them — so approval has no commercial choice left in it.
   */

  /**
   * OMITTED and NULL are different instructions, and collapsing them was a
   * live bug: the console omits this field, the controller once coalesced
   * that to null, and every partner it approved landed at the root on level 1
   * with no tree edge — which also let a client under a mislabeled "level-1"
   * partner apply past the two-level ladder.
   */
  @ApiPropertyOptional({
    type: 'integer',
    nullable: true,
    description:
      'The parent to nest the new partner under. OMITTED means "the reviewer did not say" — ' +
      'the introducer recorded at registration becomes the parent, which is the ordinary case. ' +
      'An explicit NULL roots them: they deal with the broker directly at level 1, whoever ' +
      'introduced them.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  parentIbUserId?: number | null;

  /**
   * Override the agency the applicant asked for.
   *
   * OMITTED means "grant what they applied for", which is the normal case and
   * the safe default — approving a request while silently substituting a
   * different programme is how you produce an angry partner. Supply a value
   * only to appoint them somewhere else, which is an ordinary decision but
   * should be a deliberate one.
   *
   * STILL OPTIONAL, unlike the applicant's own field, and the asymmetry is the
   * point: omitting it falls back to the application's agency rather than to
   * "none". The service refuses when BOTH are absent — which is how the ~691
   * applications submitted before an agency was required get approved: the
   * reviewer must supply one here, because there is nothing to fall back to.
   *
   * `null` is no longer a way to appoint somebody under no agency. It is
   * refused like an omission with nothing behind it.
   */
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Omitted grants the agency the applicant chose. Required when the application carries none — ' +
      'a partner cannot be approved without an agency.',
  })
  @IsOptional()
  @IsUUID()
  agencyId?: string;
}

/**
 * Reason and note are individually optional, but the service refuses when both
 * are empty. That rule lives there rather than in a decorator because it spans
 * two fields, and a client-side-only version of it is a rejection with no
 * explanation the first time somebody calls the API directly.
 */
export class RejectIbApplicationDto {
  @ApiPropertyOptional({ description: 'A configured label from the `partner` rejection context.' })
  @IsOptional()
  @IsString()
  @Length(1, 500)
  reason?: string;

  @ApiPropertyOptional({ description: "The reviewer's own words, appended to the label." })
  @IsOptional()
  @IsString()
  @Length(1, 1000)
  note?: string;

  /**
   * The label in Arabic (0179). Optional: a configured `partner` reason brings
   * its own Arabic; this is for a label typed freehand.
   */
  @OptionalArabicText(500, 'الطلب غير مكتمل')
  reasonAr?: string | null;

  /** `note` in Arabic, for a client reading the portal in Arabic (0179). Optional. */
  @OptionalArabicText(1000, 'يُرجى إضافة رابط موقعك الإلكتروني.')
  noteAr?: string | null;
}

/*
 * `ChangeIbProgramDto` IS GONE (0112). `ChangeIbLevelDto` below is what a
 * partner's terms are changed with; `ChangeIbParentDto` is what moves them in
 * the tree.
 *
 * The two are separate on purpose even though a partner's level is normally
 * DERIVED from their parent's. Reassigning a parent is a statement about the
 * tree and does not re-price anybody; changing a level is a statement about
 * money. An operator correcting a mis-recorded introducer must not silently
 * change what that partner earns, and one granting main-partner terms to
 * somebody sitting under another partner must not have to lie about the tree
 * to do it.
 */

/**
 * The RUNG a partner stands on, and therefore their terms.
 *
 * A number rather than an id, because a level IS its number — `ib_levels.level`
 * is the unique key and the thing every accrual is priced from.
 */
export class ChangeIbLevelDto {
  @ApiProperty({
    example: 2,
    minimum: 1,
    maximum: 2,
    description:
      'The level IS the position (0197): 1 with no parent, 2 under a main partner. Choosing the ' +
      'other level MOVES them — 1 detaches them from their parent, 2 places them under ' +
      '`parentIbUserId` — and "introduced by" follows the new position.',
  })
  @IsInt()
  @Min(1)
  @Max(2)
  level: number;

  @ApiPropertyOptional({
    type: 'integer',
    nullable: true,
    description: 'The main partner to place them under. Required when moving a main partner to 2.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  parentIbUserId?: number | null;
}

/**
 * `POST /admin/ib/partners/{userId}` — make an individual client a partner
 * under an agency (owner, 7 Oct 2026). With no parent they are a main partner;
 * with one, a sub-partner beneath that main partner.
 */
export class AppointIbPartnerDto {
  @ApiProperty({ format: 'uuid', description: 'The agency to appoint them under.' })
  @IsUUID()
  agencyId: string;

  @ApiPropertyOptional({
    type: 'integer',
    nullable: true,
    description: 'A main partner to place them under. Omitted or null: a main partner.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  parentIbUserId?: number | null;
}

/**
 * Why this accrual is being taken back.
 *
 * REQUIRED, and not for tidiness. This is the one operation in the module that
 * removes money from somebody who has already been paid, and the audit row is
 * the only place a partner's "where did my commission go" is ever answered
 * from. A reversal with no stated cause is indistinguishable from a mistake,
 * including to whoever made it.
 */
export class ReverseAccrualDto {
  @ApiProperty({
    minLength: 3,
    maxLength: 500,
    example: 'MT5 deal 41207 cancelled by the dealer on 2026-08-24.',
    description: 'Recorded on the audit row. Name the cancellation or the decision behind it.',
  })
  @IsString()
  @Length(3, 500)
  reason: string;
}

/**
 * `null` is a real value here, not an omission: it means "deals with the broker
 * directly", which is the top of a chain. So the field is required and
 * explicitly nullable rather than optional — omitting it would be
 * indistinguishable from asking for no change, and this endpoint's entire
 * purpose is to change it.
 */
export class ReassignIbParentDto {
  @ApiProperty({
    type: 'integer',
    nullable: true,
    description: 'The new parent partner, or null to make them a direct partner.',
  })
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(1)
  parentIbUserId: number | null;
}

/**
 * `PATCH /admin/ib/partners/{userId}/terms` — a SUB-PARTNER's own commission
 * and rebate (0197). `null` falls back to level 2's share; an absent key is
 * left as it is.
 */
export class SetIbTermsDto {
  @ApiPropertyOptional({
    type: 'string',
    nullable: true,
    example: '50',
    description:
      'Their percentage of the product’s commission, 0–100. The main partner above them takes ' +
      'the rest. Null = level 2’s share.',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Matches(/^(100(\.0{1,4})?|\d{1,2}(\.\d{1,4})?)$/, {
    message: 'Commission share must be a percentage from 0 to 100, at most 4 decimals.',
  })
  commissionShare?: string | null;

  @ApiPropertyOptional({
    type: 'string',
    nullable: true,
    example: '30',
    description:
      'What their CLIENTS get back, as a percentage of the product’s rebate, 0–100. Null = ' +
      'level 2’s rebate share.',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @Matches(/^(100(\.0{1,4})?|\d{1,2}(\.\d{1,4})?)$/, {
    message: 'Rebate share must be a percentage from 0 to 100, at most 4 decimals.',
  })
  rebateShare?: string | null;
}

export class SetIbActiveDto {
  @ApiProperty({
    description:
      'False suspends: the referral code and the tree are kept, the earning stops. There is no ' +
      'delete — removing the row would orphan every partner beneath them.',
  })
  @IsBoolean()
  active: boolean;
}

/** A person named on the partner tab — the parent, or one of the line below. */
export class IbPartnerPersonDto {
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty()
  userId: number;
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty({ type: 'integer', example: 1000245, description: 'Their Portal ID.' })
  portalId: number;
  @ClientField('client.email')
  @ApiProperty()
  email: string;
  @ClientField('client.firstName')
  @ApiProperty({ type: 'string', nullable: true })
  firstName: string | null;
  @ClientField('client.lastName')
  @ApiProperty({ type: 'string', nullable: true })
  lastName: string | null;
}

/** One partner directly beneath this one, with the terms they are paid on. */
export class IbSubPartnerRowDto extends IbPartnerPersonDto {
  @NotClientField('a lifecycle state or classification the desk acts on, not client-owned data')
  @ApiProperty({
    example: 2,
    description: 'The rung this sub-partner stands on, which is what decides their terms (0112).',
  })
  @NotClientField(
    'not a client-owned attribute \u2014 level describes the record rather than the person',
  )
  level: number;
  @ApiProperty({
    type: 'string',
    nullable: true,
    example: 'Sub Partner',
    description:
      'Null when no level is configured at this depth — a partner sitting deeper than the ' +
      'ladder pays earns nothing until it is extended, and a client rendering the null as a ' +
      'name would hide that.',
  })
  @NotClientField(
    'the name of the RUNG they stand on - commission terms, not an attribute of the person',
  )
  levelName: string | null;
  @NotClientField(
    'a relationship or record attribute; the person it points at is masked on their own shape',
  )
  @ApiProperty()
  @NotClientField(
    'not a client-owned attribute \u2014 referralCode describes the record rather than the person',
  )
  referralCode: string;
  @NotClientField('a lifecycle state the desk acts on, not client-owned data')
  @ApiProperty()
  active: boolean;
  @NotClientField('a timestamp the system recorded, describing the record rather than the client')
  @ApiProperty()
  approvedAt: Date;
  @NotClientField('an aggregate count describing the partner record, not a client attribute')
  @ApiProperty({
    description:
      'How many clients THIS sub-partner introduced — a count, never who (R2), so it spans ' +
      "territories, unlike the partner's own referredClientCount, which is scoped.",
  })
  clientCount: number;
  @NotClientField('an aggregate count describing the partner record, not a client attribute')
  @ApiProperty({ description: 'How many partners sit directly beneath THIS sub-partner.' })
  subPartnerCount: number;
  @NotClientField('an agency is operator configuration, not a client attribute')
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The agency they sell under; null offers their clients the full catalogue.',
  })
  agencyName: string | null;
}

/**
 * One currency's commission — confirmed and pending, as decimal strings (§6.1).
 *
 * A partner's earnings are a LIST of these, one per currency, never a single
 * total: an accrual takes the currency of the trade that produced it, and there
 * is no FX source to add a EUR accrual to a USD one with. It was one object,
 * summed across currencies and printed as the platform's default — see
 * `IbStore.earningsByPartner`.
 */
@NoClientFields(
  'the application and its commission terms; the shapes naming a PERSON in this file are marked field by field',
)
export class IbPartnerEarningsDto {
  @ApiProperty({ example: 'USD', description: 'The currency both figures are in.' })
  currency: string;
  @ApiProperty({ type: 'string', example: '73.50000000' }) confirmed: string;
  @ApiProperty({ type: 'string', example: '0.00000000' }) pending: string;
}

/**
 * One partner's standing — `GET /admin/ib/partners/:userId`.
 *
 * The shape the client profile's partner tab renders. Everything here is a fact
 * about the SUBJECT: which rung they stand on and what it pays, what they may
 * sell, who placed them, who they placed, and what it has earned.
 *
 * The response is `null` for a client who is not a partner. Nest describes that
 * as this type regardless, so a client MUST null-check before reading it — the
 * generated type says `IbPartnerDetailDto`, not `IbPartnerDetailDto | null`,
 * which is the one place this contract is weaker than the runtime.
 */
export class IbPartnerDetailDto {
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty()
  userId: number;
  /*
   * The RUNG this partner stands on, and the terms it carries (0112).
   *
   * These fields existed before 0102, went with the old ladder because the rung
   * had stopped deciding anything, and are back because it decides the terms
   * again. The programme fields that replaced them in between (`programId`,
   * `programName`, `programMode`, `programTiers`, `programRebateRate`) are gone
   * with the catalogue.
   *
   * ⚠️ EVERY TERM IS NULLABLE, and none of them is null in the ordinary case.
   * A partner sitting deeper than the ladder is configured for has no terms at
   * all — a real state, because a tree may legitimately run deeper than the
   * broker pays, and that partner earns nothing until the ladder is extended.
   * A client rendering a null as a zero would show that partner as configured
   * to earn nothing, which is the one reading that hides the problem.
   */
  @ApiProperty({
    example: 1,
    description:
      'The rung, and what decides their terms. 1 is a partner dealing with the broker directly.',
  })
  @NotClientField(
    'not a client-owned attribute \u2014 level describes the record rather than the person',
  )
  level: number;
  @ApiProperty({
    type: 'string',
    nullable: true,
    description: 'Null when no level is configured at this depth.',
  })
  @NotClientField(
    'the name of the RUNG they stand on - commission terms, not an attribute of the person',
  )
  levelName: string | null;
  @ApiProperty({
    description:
      'False when the level is disabled OR not configured at all. A disabled level pays nothing.',
  })
  @NotClientField(
    'not a client-owned attribute \u2014 levelEnabled describes the record rather than the person',
  )
  levelEnabled: boolean;
  @ApiProperty({
    type: 'string',
    nullable: true,
    description:
      'Their rung’s percentage of the traded product’s commission per lot (0140). Null when ' +
      'the rung is not configured.',
  })
  @NotClientField(
    'not a client-owned attribute \u2014 levelCommissionShare describes the record rather than the person',
  )
  levelCommissionShare: string | null;
  @ApiProperty({
    type: 'string',
    nullable: true,
    description: 'What their clients get back, as a percentage of the product’s rebate per lot.',
  })
  @NotClientField(
    'not a client-owned attribute \u2014 levelRebateShare describes the record rather than the person',
  )
  levelRebateShare: string | null;
  @ApiProperty({
    type: 'string',
    nullable: true,
    description:
      'A sub-partner’s own commission share (0197), overriding the level’s. Null = the level’s.',
  })
  @NotClientField('commission terms set for this partner — not an attribute of the person')
  commissionShareOverride: string | null;
  @ApiProperty({
    type: 'string',
    nullable: true,
    description:
      'What a sub-partner’s clients get back of the rebate (0197), overriding the level’s. ' +
      'Null = the level’s.',
  })
  @NotClientField('commission terms set for this partner — not an attribute of the person')
  rebateShareOverride: string | null;
  @NotClientField(
    'not a client-owned attribute \u2014 referralCode describes the record rather than the person',
  )
  @ApiProperty()
  referralCode: string;
  @ApiProperty({ description: 'A suspended partner keeps their code and tree, and stops earning.' })
  @NotClientField('a lifecycle state the desk acts on, not client-owned data')
  active: boolean;
  @NotClientField('a timestamp the system recorded, describing the record rather than the client')
  @ApiProperty()
  approvedAt: Date;
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty({ type: 'string', nullable: true })
  agencyId: string | null;
  @NotClientField(
    'not a client-owned attribute \u2014 agencyName describes the record rather than the person',
  )
  @ApiProperty({ type: 'string', nullable: true })
  agencyName: string | null;
  @ApiProperty({
    type: [String],
    description: 'What the agency lets them sell. Empty means the full catalogue.',
  })
  @NotClientField(
    'not a client-owned attribute \u2014 products describes the record rather than the person',
  )
  products: string[];
  @ApiProperty({ type: IbPartnerPersonDto, nullable: true })
  @NotClientField(
    'the nested partner, whose own shape carries the marks \u2014 masked there, not here',
  )
  parent: IbPartnerPersonDto | null;
  /**
   * True when a parent EXISTS but sits outside this reader's territory.
   *
   * `parent` is null in two completely different situations and the difference
   * decides how the partner is paid: a level 1 partner deals with the broker
   * directly and genuinely has none, while a level 2 partner whose parent is in
   * another desk's territory has one this reader may not see. Rendering both as
   * "no parent" reads the second as the first.
   *
   * The id is deliberately NOT substituted. Scoping the downline below exists
   * because ids of people a reader is denied are an oracle; handing one over
   * here would reopen it for the most interesting person in the tree.
   */
  @NotClientField('a visibility state about the reader, not an attribute of the person')
  @ApiProperty({
    description:
      'True when this partner has a parent the reader may not see. Distinguishes “deals ' +
      'with the broker directly” from “parent outside your territory”.',
  })
  parentOutsideTerritory: boolean;
  @NotClientField(
    'the nested partner, whose own shape carries the marks \u2014 masked there, not here',
  )
  @ApiProperty({
    type: [IbSubPartnerRowDto],
    description:
      'SCOPED to the reader’s territory. The ones withheld are counted in ' +
      '`directPartnersOutsideScope` — never named.',
  })
  directPartners: IbSubPartnerRowDto[];
  @NotClientField(
    'a money, paging or configuration value on the RECORD, carrying no client attribute',
  )
  @ApiProperty({
    type: 'integer',
    description:
      'How many direct sub-partners sit OUTSIDE the reader’s territory, and so are absent from ' +
      '`directPartners`. Zero for an unrestricted reader. A count, no identity (R2): a line ' +
      'that silently dropped them would read as a partner with nobody beneath them.',
  })
  directPartnersOutsideScope: number;
  @NotClientField(
    'not a client-owned attribute \u2014 referredClientCount describes the record rather than the person',
  )
  @ApiProperty({ description: 'How many clients they introduced.' })
  referredClientCount: number;
  @NotClientField(
    'a money, paging or configuration value on the RECORD, carrying no client attribute',
  )
  @ApiProperty({
    type: 'integer',
    description:
      'How many clients this partner introduced sit OUTSIDE the reader’s territory, and so are ' +
      'absent from `referredClientCount`. Zero for an unrestricted reader. A count, no identity.',
  })
  referredClientsOutsideScope: number;
  @NotClientField('a count on the RECORD, carrying no client attribute')
  @ApiProperty({
    type: 'integer',
    description:
      'IB total, first half: sub-partners directly under this partner, in the reader’s territory.',
  })
  subPartnerCount: number;
  @NotClientField('a count on the RECORD, carrying no client attribute')
  @ApiProperty({
    type: 'integer',
    description:
      'IB total, second half: clients this partner introduced who are not partners themselves, ' +
      'in the reader’s territory — so it adds to `subPartnerCount` without double counting.',
  })
  clientCount: number;
  @NotClientField(
    'not a client-owned attribute \u2014 earnings describes the record rather than the person',
  )
  @ApiProperty({
    type: [IbPartnerEarningsDto],
    description:
      'One entry per currency they have earned in, sorted by currency. Empty when nothing has ' +
      'accrued yet — never a zero in a currency nobody chose.',
  })
  earnings: IbPartnerEarningsDto[];
  /**
   * RBAC-03: the keys hidden from this viewer, omitted from the body.
   *
   * DECLARED because it is RETURNED. The interceptor adds it to every masked
   * response, and this shape did not mention it — so both frontends were
   * missing the one field that lets the partner screen say "hidden" rather than
   * an em dash. That matters here more than most: this is the response of
   * exposure 8, where the parent partner and the whole downline were served
   * unmasked, so it is the screen most likely to be showing an operator
   * something withheld.
   */
  @NotClientField('the mask reporting on ITSELF, so the screen can say hidden rather than empty')
  @ApiPropertyOptional({ type: [String] })
  maskedFields?: string[];
}

/** `?status=` on the partner directory — the `active` column, said in words. */
export const IB_PARTNER_STATUSES = ['active', 'suspended'] as const;

/**
 * The partner-account fields the DIRECTORY shows — declared rather than the raw
 * `ib_accounts` row, which also carried `programId` (dead since 0112),
 * `applicationId` and timestamps, and would have carried whatever the next
 * migration added.
 *
 * No `parentIbUserId`: see `IbPartnerRowDto.parentPortalId`.
 */
@NoClientFields(
  'the partner account: rung, code, state and appointment — none of it an attribute of the person',
)
export class IbPartnerListAccountDto {
  @ApiProperty({ type: 'integer' }) userId: number;
  @ApiProperty({ example: 1, description: 'The rung, which decides their terms (0112).' })
  level: number;
  @ApiProperty({ description: 'What a client types at registration to be attributed here.' })
  referralCode: string;
  @ApiProperty({ description: 'A suspended partner keeps their code and tree, and stops earning.' })
  active: boolean;
  @ApiProperty({ type: 'string', nullable: true }) agencyId: string | null;
  @ApiProperty() approvedAt: Date;
}

/**
 * The partner as a PERSON on a directory row.
 *
 * The three identity fields are OPTIONAL because RBAC-03 removes a hidden one
 * from the payload rather than blanking it; declaring them required would type
 * a masked row as impossible.
 */
export class IbPartnerListPersonDto {
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty({ type: 'integer', example: 1000245, description: 'The client’s Portal ID (0159).' })
  id: number;
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty({ type: 'integer', example: 1000245, description: 'Their Portal ID.' })
  portalId: number;
  @ClientField('client.email')
  @ApiPropertyOptional({ type: 'string' })
  email?: string;
  @ClientField('client.firstName')
  @ApiPropertyOptional({ type: 'string', nullable: true })
  firstName?: string | null;
  @ClientField('client.lastName')
  @ApiPropertyOptional({ type: 'string', nullable: true })
  lastName?: string | null;
}

/** One partner in the directory. */
export class IbPartnerRowDto {
  @NotClientField('the partner account, whose own shape declares it holds no client fields')
  @ApiProperty({ type: IbPartnerListAccountDto })
  account: IbPartnerListAccountDto;
  @NotClientField(
    'the nested partner, whose own shape carries the marks \u2014 masked there, not here',
  )
  @ApiProperty({ type: IbPartnerListPersonDto })
  user: IbPartnerListPersonDto;
  /**
   * The parent's Portal ID — only when the parent is inside this reader's
   * territory. The uuid is never sent: ids of people a reader is denied are an
   * oracle (the reason `IbPartnerDetailDto.parentOutsideTerritory` exists).
   */
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty({ type: 'integer', nullable: true, example: 1000210 })
  parentPortalId: number | null;
  @NotClientField('a visibility state about the reader, not an attribute of the person')
  @ApiProperty({
    description:
      'True when this partner has a parent the reader may not see. With `parentPortalId` null ' +
      'and this false, they deal with the broker directly.',
  })
  parentOutsideTerritory: boolean;
  @NotClientField(
    'not a client-owned attribute \u2014 agencyName describes the record rather than the person',
  )
  @ApiProperty({
    type: 'string',
    nullable: true,
    description: 'Null when they are on no agency, which means the full catalogue.',
  })
  agencyName: string | null;
  @NotClientField(
    'not a client-owned attribute \u2014 earnings describes the record rather than the person',
  )
  @ApiProperty({
    type: [IbPartnerEarningsDto],
    description: 'Commission only (a rebate is the client’s money), one entry per currency.',
  })
  earnings: IbPartnerEarningsDto[];
  @NotClientField('a count on the RECORD, carrying no client attribute')
  @ApiProperty({
    type: 'integer',
    description:
      'IB total, first half: sub-partners directly under this partner, in the reader’s territory.',
  })
  subPartnerCount: number;
  @NotClientField('a count on the RECORD, carrying no client attribute')
  @ApiProperty({
    type: 'integer',
    description:
      'IB total, second half: clients this partner introduced who are not partners themselves, ' +
      'in the reader’s territory — so it adds to `subPartnerCount` without double counting.',
  })
  clientCount: number;
}

/** `GET /admin/ib/partners` — the partner directory. */
export class IbPartnerListResponseDto {
  @NotClientField('the rows, whose own shape carries the marks')
  @ApiProperty({ type: [IbPartnerRowDto] })
  rows: IbPartnerRowDto[];
  @NotClientField('a count of rows, not an attribute of any person')
  @ApiProperty({
    description: 'Partners matching the filters that this reader may see, counted up to 10,001.',
  })
  total: number;
  @NotClientField('a count of rows, not an attribute of any person')
  @ApiProperty({ description: 'True when more than 10,000 match: total is then 10,000.' })
  totalCapped: boolean;
  @NotClientField('a paging position, not an attribute of any person')
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Pass back as ?cursor= for the next page.',
  })
  nextCursor: string | null;
  @NotClientField('a paging position, not an attribute of any person')
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Pass back as ?cursor=…&dir=prev for the page before; null on the first page.',
  })
  prevCursor: string | null;
  @NotClientField('the mask reporting on ITSELF, so the screen can say hidden rather than empty')
  @ApiProperty({ type: [String] })
  maskedFields: string[];
}
