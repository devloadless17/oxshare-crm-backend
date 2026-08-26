import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IbProgramTierDto } from './ib-program.dto';
import { IsBoolean, IsOptional, IsString, IsUUID, Length, ValidateIf } from 'class-validator';

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
   * The agency (وكالة) being applied for. REQUIRED.
   *
   * It was optional, so that a deployment with no agencies configured could
   * still take applications — and a blank field appointed a partner whose
   * clients are offered the whole catalogue, the broadest grant in the system,
   * reached by omission. `IsUUID` alone now carries the requirement; the
   * service repeats it, because a DTO protects a ROUTE and the rule has to hold
   * for anything calling the service directly.
   *
   * Validated against the OPEN agencies on submit. A disabled one is refused
   * rather than accepted-and-queued: the programme is closed, and letting the
   * application sit means telling somebody later that the thing they applied
   * for was never available.
   */
  @ApiProperty({
    format: 'uuid',
    description:
      'Which agency the applicant wants to be appointed under. Required — it decides what they ' +
      'may sell, and there is no "any" option.',
  })
  @IsUUID()
  agencyId: string;

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

export class IbApplicationDto {
  @ApiProperty() id: string;
  @ApiProperty() userId: string;
  @ApiProperty({ type: 'string', nullable: true }) motivation: string | null;
  @ApiProperty({ type: 'string', nullable: true }) website: string | null;
  @ApiProperty({ enum: IB_APPLICATION_STATUSES }) status: IbApplicationStatusDto;
  @ApiProperty({
    type: 'string',
    nullable: true,
    description: 'Already composed — this is the sentence the client is shown.',
  })
  rejectionReason: string | null;
  /**
   * The agency (وكالة) applied for, by NAME.
   *
   * Null on an application submitted before agencies existed, or against a
   * deployment that has none. The portal shows it on the pending card so an
   * applicant can see what they asked for while they wait — the one detail
   * they cannot otherwise recover once the form is gone.
   */
  @ApiPropertyOptional({ type: 'string', nullable: true }) agencyName: string | null;
  @ApiProperty({ type: 'string', nullable: true }) reviewedBy: string | null;
  @ApiProperty({ type: 'string', format: 'date-time', nullable: true }) reviewedAt: Date | null;
  @ApiProperty() submittedAt: Date;
}

export class IbAccountDto {
  @ApiProperty() userId: string;
  @ApiProperty() level: number;
  @ApiProperty({ type: 'string', nullable: true }) parentIbUserId: string | null;
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
  @ApiProperty({
    type: [String],
    description: 'Product names this partner may introduce clients to. Empty means unrestricted.',
  })
  products: string[];

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
 * `'chain_full'` went in 0102 with the ladder that produced it: with no
 * platform-wide depth ceiling, there is no longer a state where a verified
 * client cannot be placed beneath their introducer.
 *
 * Kept as a UNION of one rather than collapsed to a boolean — the portal
 * branches on the code, and the next gate should extend this rather than
 * reintroduce a second field beside it.
 */
export type IbIneligibleCode = 'unverified';

export class ApproveIbApplicationDto {
  /**
   * The terms to appoint them on — FR-IB-06's "exactly one named program".
   *
   * Replaces `level`, and it is that field promoted to the thing that actually
   * decides money: a rung was a placement a reviewer picked and the engine then
   * ignored.
   *
   * OMITTED means the first ENABLED programme by `sortOrder`, so the ordinary
   * approval stays one click. A UUID rather than a name, like
   * `ChangeIbProgramDto`: the name is editable and an assignment keyed on one
   * would follow a rename somewhere nobody intended.
   */
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'The commission programme to appoint them on. Omitted, the first enabled programme is ' +
      'used. A disabled programme is refused — it would pay them nothing.',
  })
  @IsOptional()
  @IsUUID()
  programId?: string;

  @ApiPropertyOptional({
    type: 'string',
    nullable: true,
    description: 'The partner who introduced them. Omitted or null means they deal direct.',
  })
  @IsOptional()
  @IsUUID()
  parentIbUserId?: string;

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
}

/*
 * `ChangeIbLevelDto` IS GONE (0102). `ChangeIbProgramDto` below is what a
 * partner's terms are changed with; `ChangeIbParentDto` is what moves them in
 * the tree. The rung conflated the two and decided neither.
 */

/**
 * The terms a partner is paid on.
 *
 * A UUID rather than a name: the name is editable, and an assignment keyed on
 * one would follow a rename somewhere nobody intended.
 */
export class ChangeIbProgramDto {
  @ApiProperty({ format: 'uuid', description: 'Must be an ENABLED programme.' })
  @IsUUID()
  programId: string;
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
    type: 'string',
    nullable: true,
    description: 'The new parent partner, or null to make them a direct partner.',
  })
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  parentIbUserId: string | null;
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
  @ApiProperty() userId: string;
  @ApiProperty() email: string;
  @ApiProperty({ type: 'string', nullable: true }) firstName: string | null;
  @ApiProperty({ type: 'string', nullable: true }) lastName: string | null;
}

/** One partner directly beneath this one, with the terms they are paid on. */
export class IbSubPartnerRowDto extends IbPartnerPersonDto {
  @ApiProperty({ format: 'uuid' }) programId: string;
  @ApiProperty({
    example: 'Silver',
    description:
      'Replaced `level` / `levelName` in 0102. A rung named a placement that decided nothing; ' +
      'a programme is what this sub-partner is actually paid on.',
  })
  programName: string;
  @ApiProperty() referralCode: string;
  @ApiProperty() active: boolean;
  @ApiProperty() approvedAt: Date;
}

/** Confirmed and pending totals, as decimal strings (§6.1). */
export class IbPartnerEarningsDto {
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
  @ApiProperty() userId: string;
  /*
   * `level`, `levelName` and `rateValue` went in 0102 with the ladder.
   *
   * All three described the rung, which had decided nothing since the
   * programmes landed — so this response carried three fields that read like
   * the partner's economics beside the one that actually was. What replaces
   * them says more than a rung ever did: the programme, its mode, its rebate,
   * and the LADDER, which is how far this partner's earnings reach.
   */
  @ApiProperty({ format: 'uuid', description: 'The terms this partner is paid on.' })
  programId: string;
  @ApiProperty({
    type: 'string',
    nullable: true,
    description: 'Null only if the programme row vanished, which the foreign key prevents.',
  })
  programName: string | null;
  @ApiProperty({
    enum: ['commission_only', 'rebate_only', 'hybrid'],
    nullable: true,
    description: 'Which legs their programme pays.',
  })
  programMode: 'commission_only' | 'rebate_only' | 'hybrid' | null;
  @ApiProperty({
    type: [IbProgramTierDto],
    description:
      'What they take at each depth, shallowest first. The COUNT is how many levels below them ' +
      'their earnings reach.',
  })
  programTiers: IbProgramTierDto[];
  @ApiProperty({
    type: 'string',
    nullable: true,
    description: 'What their clients get back, as a percentage of the same revenue.',
  })
  programRebateRate: string | null;
  @ApiProperty() referralCode: string;
  @ApiProperty({ description: 'A suspended partner keeps their code and tree, and stops earning.' })
  active: boolean;
  @ApiProperty() approvedAt: Date;
  @ApiProperty({ type: 'string', nullable: true }) agencyId: string | null;
  @ApiProperty({ type: 'string', nullable: true }) agencyName: string | null;
  @ApiProperty({
    type: [String],
    description: 'What the agency lets them sell. Empty means the full catalogue.',
  })
  products: string[];
  @ApiProperty({ type: IbPartnerPersonDto, nullable: true })
  parent: IbPartnerPersonDto | null;
  @ApiProperty({ type: [IbSubPartnerRowDto] }) directPartners: IbSubPartnerRowDto[];
  @ApiProperty({ description: 'How many clients they introduced.' }) referredClientCount: number;
  @ApiProperty({ type: IbPartnerEarningsDto }) earnings: IbPartnerEarningsDto;
}
