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
@ApiTags('notifications')
@UseGuards(JwtAuthGuard, EmailVerifiedGuard)
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

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
  list(
    @Req() req: Request & { user: User },
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('unread') unread?: string,
    @Query('read') read?: string,
  ) {
    return this.notifications.list(
      { kind: 'client', id: req.user.id },
      {
        limit: limit ? Number.parseInt(limit, 10) : undefined,
        cursor: cursor ? decodeCursor(cursor) : undefined,
        unreadOnly: unread === 'true',
        readOnly: read === 'true',
      },
    );
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
