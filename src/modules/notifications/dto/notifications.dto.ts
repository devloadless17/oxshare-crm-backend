import { ApiProperty } from '@nestjs/swagger';

/**
 * One bell row.
 *
 * Deliberately carries NO title, body or link: the row is a `kind` slug plus
 * structured `params`, and each frontend owns the copy (i18n) and the deep
 * link. Money values inside `params` are STRINGS — the schema note and §6.1
 * say why.
 */
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

export class NotificationListResponseDto {
  @ApiProperty({ type: [NotificationDto] }) items: NotificationDto[];

  /** Pass back as `?cursor=` for the next page; `null` on the last (R-2.4). */
  @ApiProperty({ type: String, nullable: true })
  nextCursor: string | null;
}

export class NotificationUnreadCountDto {
  @ApiProperty({ description: 'Unread rows for the caller. The bell badge number.' })
  count: number;
}

export class NotificationsMarkAllReadResponseDto {
  @ApiProperty({ description: 'Rows marked read by this call. 0 when everything already was.' })
  updated: number;
}
