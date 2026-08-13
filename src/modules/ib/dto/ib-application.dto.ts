import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Min,
  ValidateIf,
} from 'class-validator';

export const IB_APPLICATION_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type IbApplicationStatusDto = (typeof IB_APPLICATION_STATUSES)[number];

/**
 * What a client sends to apply.
 *
 * Every field is optional. The application is a request to be considered, not a
 * form to be passed — the reviewer's decision rests on the account behind it
 * (verified identity, activity) far more than on free text, and making
 * `motivation` mandatory produces a paragraph written to satisfy a validator.
 */
export class CreateIbApplicationDto {
  /**
   * The agency (وكالة) being applied for.
   *
   * OPTIONAL, like every other field here, and for a different reason than the
   * rest: a deployment with no agencies configured must still take
   * applications. Where agencies DO exist the portal makes this a required
   * choice, because "which programme" is the one question an applicant is best
   * placed to answer and a reviewer is not.
   *
   * Validated against the OPEN agencies on submit. A disabled one is refused
   * rather than accepted-and-queued: the programme is closed, and letting the
   * application sit means telling somebody later that the thing they applied
   * for was never available.
   */
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Which agency the applicant wants to be appointed under.',
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

  @ApiPropertyOptional({
    maxLength: 120,
    description: 'Self-reported and unverified. Labelled as such on the review screen.',
  })
  @IsOptional()
  @IsString()
  @Length(0, 120)
  expectedVolume?: string;

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
  @ApiProperty({ type: 'string', nullable: true }) expectedVolume: string | null;
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
}

/** @see IbStatusDto.ineligibleCode */
export type IbIneligibleCode = 'unverified' | 'chain_full';

export class ApproveIbApplicationDto {
  @ApiPropertyOptional({
    minimum: 1,
    description:
      'Which rung to place them on. Omitted, the service derives it: the shallowest enabled ' +
      'level with no parent, one below the parent otherwise.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  level?: number;

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
   */
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Omitted grants the agency the applicant chose. Supply one to override it.',
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

export class ChangeIbLevelDto {
  @ApiProperty({ minimum: 1, description: 'Must be an ENABLED level.' })
  @IsInt()
  @Min(1)
  level: number;
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

/** One partner directly beneath this one, with their rung. */
export class IbSubPartnerRowDto extends IbPartnerPersonDto {
  @ApiProperty() level: number;
  @ApiProperty() levelName: string;
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
  @ApiProperty() level: number;
  @ApiProperty({ type: 'string', nullable: true }) levelName: string | null;
  @ApiProperty({
    type: 'string',
    nullable: true,
    description: 'The rung’s percentage of the broker’s revenue. A decimal string, never a number.',
  })
  rateValue: string | null;
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
