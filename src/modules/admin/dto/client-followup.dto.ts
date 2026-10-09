import { ApiProperty } from '@nestjs/swagger';
import { IsISO8601, IsInt, IsString, Matches, MaxLength, Min, ValidateIf } from 'class-validator';
import { FOLLOW_UP_MAX_LENGTH } from '../../../common/client-follow-up';
import { NotClientField } from '../../../common/security/client-field.decorator';

/*
 * A client's Follow-up and Result (0212): the desk's working notes about a
 * client, written by staff and never shown to the client.
 *
 * NOT maskable, and that is the owner's rule rather than an oversight: masking
 * covers the client's personal DETAILS only (0208, 7 Oct 2026), and these are
 * the staff's own words, like the KYC reviewer's notes and the tags.
 */
const STAFF_NOTE =
  "the staff's own working note about the client, not a personal detail (masking covers personal details only, 0208)";

/** Who last saved the notes. */
export class ClientFollowUpEditorDto {
  @NotClientField('an administrator id - who on the staff saved the notes, not the client')
  @ApiProperty({ format: 'uuid' })
  id: string;

  @NotClientField("the administrator's display name - a member of staff, not the client")
  @ApiProperty({ example: 'Omar Farah' })
  name: string;
}

export class ClientFollowUpDto {
  @NotClientField(STAFF_NOTE)
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Call back after payday; wants to fund 500 USD.',
    description: 'What to do next. Null when empty.',
  })
  followUp: string | null;

  @NotClientField(STAFF_NOTE)
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Interested. Asked for the gold spreads by email.',
    description: 'How the last contact went. Null when empty.',
  })
  result: string | null;

  @NotClientField(STAFF_NOTE)
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When to follow up. Null for no date.',
  })
  followUpAt: Date | null;

  @NotClientField('a version counter for the conflict check, not client-owned data')
  @ApiProperty({
    type: 'integer',
    example: 3,
    description:
      'Send it back with the next save. 0 when nothing was ever written for this client. A save ' +
      'made from an older version answers 409 FOLLOWUP_STALE.',
  })
  version: number;

  @NotClientField('when the staff last saved the notes - a fact about the notes, not the client')
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  updatedAt: Date | null;

  @NotClientField('the administrator who last saved the notes - staff, not the client')
  @ApiProperty({
    type: ClientFollowUpEditorDto,
    nullable: true,
    description: 'Null when nothing was ever saved, or the administrator was since removed.',
  })
  updatedBy: ClientFollowUpEditorDto | null;
}

/**
 * Save both notes and the date together — a full replacement, so a field left
 * as it was is sent as it was. `version` is the one GET returned.
 */
export class UpdateClientFollowUpDto {
  @ApiProperty({
    type: String,
    nullable: true,
    maxLength: FOLLOW_UP_MAX_LENGTH,
    description: 'What to do next. Empty or null clears it.',
  })
  @ValidateIf((_, value: unknown) => value !== null)
  @IsString()
  @MaxLength(FOLLOW_UP_MAX_LENGTH)
  followUp: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    maxLength: FOLLOW_UP_MAX_LENGTH,
    description: 'How the last contact went. Empty or null clears it.',
  })
  @ValidateIf((_, value: unknown) => value !== null)
  @IsString()
  @MaxLength(FOLLOW_UP_MAX_LENGTH)
  result: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '2026-10-12T10:00:00+03:00',
    description:
      'When to follow up: an ISO date-time WITH its offset, so it means the same moment ' +
      'everywhere. Null for no date. A newly chosen date may not lie in the past or more than ' +
      'five years ahead.',
  })
  @ValidateIf((_, value: unknown) => value !== null)
  @IsISO8601({ strict: true })
  @Matches(/(?:Z|[+-]\d{2}:\d{2})$/, {
    message: 'followUpAt must end with its offset (Z or +03:00).',
  })
  followUpAt: string | null;

  @ApiProperty({
    type: 'integer',
    minimum: 0,
    example: 3,
    description: 'The version these notes were edited from, as GET returned it.',
  })
  @IsInt()
  @Min(0)
  version: number;
}
