import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, IsUUID, Length, Min } from 'class-validator';

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
}

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
