import {
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Sse,
  UseGuards,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiExcludeEndpoint,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from '../identity/guards/jwt-auth.guard';
import { EmailVerifiedGuard } from '../identity/guards/email-verified.guard';
import { User } from '../../store/users.store';
import { decodeCursor } from '../../common/pagination';
import { NotificationsService } from './notifications.service';
import { NotificationsRealtimeGateway } from './realtime.gateway';
import { notificationStream } from './notification-stream';
import {
  NotificationDto,
  NotificationListResponseDto,
  NotificationUnreadCountDto,
  NotificationsMarkAllReadResponseDto,
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
  constructor(
    private readonly notifications: NotificationsService,
    private readonly realtime: NotificationsRealtimeGateway,
  ) {}

  /**
   * The live stream — the client's bell, without waiting for a poll.
   *
   * `@Sse` rather than a socket: this channel only ever pushes server→client,
   * which is what Server-Sent Events are for. It costs no dependency, needs no
   * CSP change (`connect-src 'self'` already covers it, because the portal
   * proxies `/api` through its own origin), and the browser reconnects on its
   * own when the server ends the stream — which it does every fifteen minutes,
   * deliberately, so the session is re-authenticated. See
   * `notification-stream.ts`.
   *
   * Excluded from the OpenAPI document: `openapi-typescript` has no shape for
   * an event stream, and generating one would put a lie in `types.gen.ts`. The
   * frontends consume this with `EventSource`, not the typed client.
   */
  @Sse('stream')
  @ApiExcludeEndpoint()
  stream(@Req() req: Request & { user: User }) {
    const recipient = { kind: 'client' as const, id: req.user.id };
    return notificationStream(this.realtime.streamFor(recipient), recipient);
  }

  @Get()
  @ApiCookieAuth()
  @ApiOperation({ summary: "The signed-in client's notification feed, newest first" })
  @ApiOkResponse({ type: NotificationListResponseDto })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'cursor', required: false, description: 'Opaque keyset cursor (R-2.4).' })
  @ApiQuery({ name: 'unread', required: false, description: "Pass 'true' to see only unread." })
  list(
    @Req() req: Request & { user: User },
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('unread') unread?: string,
  ) {
    return this.notifications.list(
      { kind: 'client', id: req.user.id },
      {
        limit: limit ? Number.parseInt(limit, 10) : undefined,
        cursor: cursor ? decodeCursor(cursor) : undefined,
        unreadOnly: unread === 'true',
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
  @ApiOperation({ summary: 'Mark every unread notification read. Idempotent.' })
  @ApiOkResponse({ type: NotificationsMarkAllReadResponseDto })
  async markAllRead(
    @Req() req: Request & { user: User },
  ): Promise<NotificationsMarkAllReadResponseDto> {
    return {
      updated: await this.notifications.markAllRead({ kind: 'client', id: req.user.id }),
    };
  }
}
