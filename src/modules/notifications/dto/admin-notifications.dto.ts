import { DATE_OR_INSTANT } from '../../../common/date-range';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  ADMIN_NOTIFICATION_CATEGORIES,
  ADMIN_NOTIFICATION_KIND_LIST,
  type AdminNotificationCategory,
  type AdminNotificationKind,
} from '../../../common/notifications/admin-notification-catalogue';
import {
  ClientField,
  NoClientFields,
  NotClientField,
} from '../../../common/security/client-field.decorator';
import { NOTIFICATION_SUBJECT_KINDS, type NotificationSubjectKind } from '../../../database/schema';

/*
 * The admin bell's contract. Unlike the client feed's envelope, an admin row
 * NAMES A CLIENT — the task is about somebody — so these shapes carry
 * `@ClientField` marks and pass through the RBAC-03 mask like every other
 * client-bearing response. The name is joined at read time; it is never stored
 * in `params` and never sent over the socket.
 */

// ── Requests ────────────────────────────────────────────────────────────────

const VIEWS = ['inbox', 'history'] as const;

export class AdminNotificationsQueryDto {
  @ApiPropertyOptional({
    enum: VIEWS,
    description:
      "'inbox': still waiting — not yet handled by anyone, whether you have opened it or not. " +
      "'history' (default): handled, with how it ended. A task is in exactly one of the two.",
  })
  @IsOptional()
  @IsIn(VIEWS)
  view?: (typeof VIEWS)[number];

  @ApiPropertyOptional({ enum: ADMIN_NOTIFICATION_CATEGORIES })
  @IsOptional()
  @IsIn(ADMIN_NOTIFICATION_CATEGORIES)
  category?: AdminNotificationCategory;

  @ApiPropertyOptional({
    description: 'A client: Portal ID (exact, `#` optional) or part of a name or email.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({
    description: 'Raised at or after: a date-time with offset, or YYYY-MM-DD (a UTC day).',
  })
  @IsOptional()
  @Matches(DATE_OR_INSTANT, { message: 'from must be a date or a date-time with its offset' })
  from?: string;

  @ApiPropertyOptional({
    description: 'End: a date-time with offset (exclusive), or YYYY-MM-DD (that whole day).',
  })
  @IsOptional()
  @Matches(DATE_OR_INSTANT, { message: 'to must be a date or a date-time with its offset' })
  to?: string;

  @ApiPropertyOptional({ description: 'Opaque keyset cursor (R-2.4).' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

/** Ending a task by the decision its kind declares for leaving the item as it is. */
export class AdminNotificationCloseDto {
  @ApiProperty({
    minLength: 3,
    maxLength: 500,
    example: 'Trade re-opened by the dealer; the partner keeps the commission.',
    description: 'Why the item is left as it is. Recorded on the audit row.',
  })
  @IsString()
  @Length(3, 500)
  reason!: string;
}

export class AdminNotificationsReadSubjectDto {
  @ApiProperty({ enum: NOTIFICATION_SUBJECT_KINDS })
  @IsIn(NOTIFICATION_SUBJECT_KINDS)
  subjectKind!: NotificationSubjectKind;

  @ApiProperty({
    description:
      "The item's id — for a KYC task the client's Portal ID, for any other item the record's uuid.",
  })
  // Either shape: a KYC task's subject is the client (a Portal ID since 0159), every other
  // subject a record's uuid. The update matches the reader's own rows by the exact id, so a
  // well-formed id of the wrong kind marks nothing.
  @Matches(/^(?:[1-9][0-9]{0,9}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i, {
    message: "subjectId must be a client's Portal ID or a record's uuid",
  })
  subjectId!: string;
}

// ── Responses ───────────────────────────────────────────────────────────────

/** The client a task is about, as the console names one: Portal ID, then name. */
export class AdminNotificationClientDto {
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'The Portal ID — never masked, so it still names the client under any role.',
  })
  portalId: number | null;

  @ClientField('client.firstName')
  @ApiPropertyOptional({ type: String, nullable: true })
  firstName?: string | null;

  @ClientField('client.lastName')
  @ApiPropertyOptional({ type: String, nullable: true })
  lastName?: string | null;
}

@NoClientFields('names an item in the system — a transaction, a submission — by kind and id')
export class AdminNotificationSubjectDto {
  @ApiProperty({ enum: NOTIFICATION_SUBJECT_KINDS })
  kind: NotificationSubjectKind;

  @ApiProperty({ description: "The item's id. For a KYC task, the client's id." })
  id: string;
}

@NoClientFields('a lifecycle fact about the task and the operator who ended it, never a client')
export class AdminNotificationResolutionDto {
  @ApiProperty({ description: 'When somebody handled the item.' })
  at: Date;

  @ApiProperty({
    description:
      "The item state that ended the task — 'approved', 'rejected', 'success', 'failure', " +
      "'reversed', 'settled', 'resolved', 'reset'. Render per category; unknown → 'Handled'.",
    example: 'approved',
  })
  outcome: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'The administrator who handled it — only when the decision itself recorded one. A ' +
      'cancel, a system settle or a release carries none.',
  })
  byName?: string | null;
}

export class AdminNotificationDto {
  @NotClientField('an identifier addressing the record, not an attribute of the person behind it')
  @ApiProperty()
  id: string;

  @NotClientField('a catalogue slug naming the task, not client-owned data')
  @ApiProperty({ enum: ADMIN_NOTIFICATION_KIND_LIST })
  kind: AdminNotificationKind;

  @NotClientField('a catalogue grouping, not client-owned data')
  @ApiProperty({ enum: ADMIN_NOTIFICATION_CATEGORIES })
  category: AdminNotificationCategory;

  @NotClientField(
    'ids, amounts (as strings), currencies and reason codes — never a name or an address, ' +
      'which notification-params-no-pii.spec.ts enforces',
  )
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    example: { transactionId: 'a6e1…', amount: '250.00000000', currency: 'USD' },
  })
  params: Record<string, unknown>;

  @NotClientField('the reader’s own marker, not client data')
  @ApiProperty({ type: String, nullable: true, description: 'Null while unread.' })
  readAt: Date | null;

  @NotClientField('when the task was raised — a lifecycle fact, not client data')
  @ApiProperty()
  createdAt: Date;

  @NotClientField('the item the task is about, by kind and id')
  @ApiProperty({ type: AdminNotificationSubjectDto })
  subject: AdminNotificationSubjectDto;

  @NotClientField('the nested person, whose own shape carries the marks — masked there, not here')
  @ApiProperty({ type: AdminNotificationClientDto })
  client: AdminNotificationClientDto;

  @NotClientField('a lifecycle fact about the task, not client data')
  @ApiProperty({
    type: AdminNotificationResolutionDto,
    nullable: true,
    description: 'Null while the item still waits on somebody.',
  })
  resolution: AdminNotificationResolutionDto | null;
}

export class AdminNotificationListResponseDto {
  @NotClientField('the rows, whose own shape carries the marks')
  @ApiProperty({ type: [AdminNotificationDto] })
  items: AdminNotificationDto[];

  @NotClientField('an opaque paging token, not client data')
  @ApiProperty({ type: String, nullable: true, description: '`null` on the last page (R-2.4).' })
  nextCursor: string | null;

  @NotClientField('the mask reporting on ITSELF, so the screen can say hidden rather than empty')
  @ApiProperty({
    type: [String],
    description: 'Client fields hidden from this reader on every row, e.g. `client.firstName`.',
  })
  maskedFields: string[];
}

@NoClientFields('counts of the reader’s own open tasks — no client is named')
export class AdminNotificationCategoryCountsDto {
  @ApiProperty() deposits: number;
  @ApiProperty() withdrawals: number;
  @ApiProperty() kyc: number;
  @ApiProperty() ib: number;
  @ApiProperty() transfers: number;
}

@NoClientFields('counts of the reader’s own open tasks — no client is named')
export class AdminNotificationSummaryDto {
  @ApiProperty({
    description:
      'Tasks waiting on the reader — unread and not yet handled by anyone. The bell badge.',
  })
  count: number;

  @ApiProperty({ type: AdminNotificationCategoryCountsDto })
  byCategory: AdminNotificationCategoryCountsDto;
}

@NoClientFields('a task id and the outcome word it was closed with')
export class AdminNotificationCloseResponseDto {
  @ApiProperty() id: string;

  @ApiProperty({ description: "The outcome recorded, e.g. 'kept' — History shows it." })
  outcome: string;
}

@NoClientFields('the reader’s own marker on one of their rows')
export class AdminNotificationMarkResponseDto {
  @ApiProperty() id: string;

  @ApiProperty({ type: String, nullable: true })
  readAt: Date | null;
}
