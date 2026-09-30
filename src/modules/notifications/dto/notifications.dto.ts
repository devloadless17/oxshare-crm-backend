import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsOptional } from 'class-validator';
import { NoClientFields } from '../../../common/security/client-field.decorator';

/**
 * One bell row.
 *
 * Deliberately carries NO title, body or link: the row is a `kind` slug plus
 * structured `params`, and each frontend owns the copy (i18n) and the deep
 * link. Money values inside `params` are STRINGS — the schema note and §6.1
 * say why.
 */
@NoClientFields('a notification envelope; its params are ids by design, never a name or an address')
export class NotificationDto {
  @ApiProperty() id: string;

  @ApiProperty({
    description:
      "Catalogue slug, e.g. 'withdrawal.approved'. Render client-side; unknown kinds get a generic fallback.",
    example: 'withdrawal.approved',
  })
  kind: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'Structured payload for the kind — ids, amounts (as strings), reasons. Never another client’s identifiers.',
    example: { transactionId: 'a6e1…', amount: '25.00000000', currency: 'USD' },
  })
  params: Record<string, unknown>;

  @ApiProperty({ type: String, nullable: true, description: 'Null while unread.' })
  readAt: Date | null;

  @ApiProperty() createdAt: Date;
}

@NoClientFields('a notification envelope; its params are ids by design, never a name or an address')
export class NotificationListResponseDto {
  @ApiProperty({ type: [NotificationDto] }) items: NotificationDto[];

  /** Pass back as `?cursor=` for the next page; `null` on the last (R-2.4). */
  @ApiProperty({ type: String, nullable: true })
  nextCursor: string | null;
}

@NoClientFields('a notification envelope; its params are ids by design, never a name or an address')
export class NotificationUnreadCountDto {
  @ApiProperty({ description: 'Unread rows for the caller. The bell badge number.' })
  count: number;
}

@NoClientFields('a notification envelope; its params are ids by design, never a name or an address')
export class NotificationsMarkAllReadResponseDto {
  @ApiProperty({ description: 'Rows marked read by this call. 0 when everything already was.' })
  updated: number;
}

/**
 * The portal marks what it SHOWED: `upTo` is the newest row on screen, so a
 * notification arriving while the panel was open is never marked read unseen.
 */
export class NotificationsReadAllDto {
  @ApiPropertyOptional({
    description: 'The `createdAt` of the newest notification the reader was shown.',
    example: '2026-09-25T10:15:00.000Z',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  upTo?: string;

  /**
   * The oldest row shown. The panel loads one page, so an unread row past it
   * was never on screen and must stay unread.
   */
  @ApiPropertyOptional({
    description: 'The `createdAt` of the oldest notification the reader was shown.',
    example: '2026-09-20T08:00:00.000Z',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;
}
