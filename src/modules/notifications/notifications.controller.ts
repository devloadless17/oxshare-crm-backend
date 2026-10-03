import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { EmailVerifiedGuard } from '../identity/guards/email-verified.guard';
import { User } from '../../store/users.store';
import { RejectionReasonsStore, type RejectionContext } from '../../store/rejection-reasons.store';
import { decodeCursor } from '../../common/pagination';
import { NotificationsService } from './notifications.service';
import {
  NotificationDto,
  NotificationListResponseDto,
  NotificationUnreadCountDto,
  NotificationsMarkAllReadResponseDto,
  NotificationsReadAllDto,
} from './dto/notifications.dto';

/**
 * The client portal's bell.
 *
 * Authenticated but not permission-gated, so the recipient comes from the
 * SESSION and never from a parameter (R-4.4) — the same stance as
 * `GET /wallet/ledger`, and for the same reason: it is the entire distance
 * between "my notifications" and "anyone's".
 */
/** The notification kinds whose `params.reason` is a copied rejection reason, and its context. */
const REASON_CONTEXT: Readonly<Record<string, RejectionContext>> = {
  'kyc.rejected': 'kyc',
  'kyc.reverification_requested': 'kyc',
  'withdrawal.rejected': 'withdrawal',
  'deposit.rejected': 'deposit',
  'partner.rejected': 'partner',
};

@ApiTags('notifications')
@UseGuards(JwtAuthGuard, EmailVerifiedGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    /* A refusal's reason in Arabic, resolved on read (0179) — `params.reasonAr`. */
    private readonly reasons: RejectionReasonsStore,
  ) {}

  @Get()
  @ApiCookieAuth()
  @ApiOperation({ summary: "The signed-in client's notification feed, newest first" })
  @ApiOkResponse({ type: NotificationListResponseDto })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'cursor', required: false, description: 'Opaque keyset cursor (R-2.4).' })
  @ApiQuery({ name: 'unread', required: false, description: "Pass 'true' to see only unread." })
  @ApiQuery({
    name: 'read',
    required: false,
    description:
      "Pass 'true' to see only what was already seen — the portal's Earlier tab, paged on its own " +
      'so it never mixes with New.',
  })
  async list(
    @Req() req: Request & { user: User },
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('unread') unread?: string,
    @Query('read') read?: string,
  ) {
    const page = await this.notifications.list(
      { kind: 'client', id: req.user.id },
      {
        limit: limit ? Number.parseInt(limit, 10) : undefined,
        cursor: cursor ? decodeCursor(cursor) : undefined,
        unreadOnly: unread === 'true',
        readOnly: read === 'true',
      },
    );
    /*
     * `params.reasonAr` (0179): the Arabic written into the row WITH the decision
     * wins (the reviewer's own, or the configured reason's as it read then);
     * an older row whose `reason` is a configured reason — or a sentence the
     * system wrote — gets its Arabic here. ONE query for the page, none when
     * nothing on it needs one.
     */
    const contextOf = (kind: string) =>
      Object.prototype.hasOwnProperty.call(REASON_CONTEXT, kind) ? REASON_CONTEXT[kind] : undefined;
    const hasStoredArabic = (params: Record<string, unknown> | null | undefined) =>
      typeof params?.['reasonAr'] === 'string' && params['reasonAr'].trim() !== '';
    const withReason = page.items.filter(
      (item) =>
        contextOf(item.kind) &&
        typeof item.params?.['reason'] === 'string' &&
        !hasStoredArabic(item.params),
    );
    if (withReason.length === 0) return page;
    const arabicOf = await this.reasons.arabicFor(withReason.map((item) => contextOf(item.kind)!));
    return {
      ...page,
      items: page.items.map((item) => {
        if (hasStoredArabic(item.params)) return item;
        const context = contextOf(item.kind);
        const reason = item.params?.['reason'];
        const arabic =
          context && typeof reason === 'string' ? arabicOf(context, reason) : undefined;
        return arabic ? { ...item, params: { ...item.params, reasonAr: arabic } } : item;
      }),
    };
  }

  @Get('unread-count')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Unread notifications for the signed-in client — the badge number' })
  @ApiOkResponse({ type: NotificationUnreadCountDto })
  async unreadCount(@Req() req: Request & { user: User }): Promise<NotificationUnreadCountDto> {
    return { count: await this.notifications.unreadCount({ kind: 'client', id: req.user.id }) };
  }

  @Post(':id/read')
  @HttpCode(200)
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Mark one notification read. Idempotent.' })
  @ApiOkResponse({ type: NotificationDto })
  markRead(@Req() req: Request & { user: User }, @Param('id', ParseUUIDPipe) id: string) {
    return this.notifications.markRead({ kind: 'client', id: req.user.id }, id);
  }

  @Post('read-all')
  @HttpCode(200)
  @ApiCookieAuth()
  @ApiOperation({
    summary:
      'Mark unread notifications read — every one, or up to the newest one shown. Idempotent.',
  })
  @ApiOkResponse({ type: NotificationsMarkAllReadResponseDto })
  async markAllRead(
    @Req() req: Request & { user: User },
    @Body() body: NotificationsReadAllDto,
  ): Promise<NotificationsMarkAllReadResponseDto> {
    return {
      updated: await this.notifications.markAllRead(
        { kind: 'client', id: req.user.id },
        body.upTo ? new Date(body.upTo) : undefined,
        body.from ? new Date(body.from) : undefined,
      ),
    };
  }
}
