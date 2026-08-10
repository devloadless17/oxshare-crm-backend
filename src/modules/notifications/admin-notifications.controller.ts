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
import { Admin } from '../../store/admins.store';
import { AnyAdmin, PermissionsGuard } from '../admin/guards/admin.guard';
import { NotAudited } from '../admin/guards/audited.decorator';
import { NotClientScoped } from '../admin/guards/client-scope.decorator';
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
 * The admin console's bell.
 *
 * ## `@AnyAdmin`, not a `notifications.*` permission key — a decision, written down
 *
 * Every row in this feed exists BECAUSE the recipient held the underlying
 * permission (and client scope) when the event fanned out —
 * `NotificationsService.notifyAdminsWithPermission` filters at write time. A
 * `notifications.view` key would gate a mirror of information the admin was
 * already granted, and a grantable no-op key is what the permissions catalog's
 * own `clients.edit` note argues against. Hiding the bell per-role, if ever
 * wanted, is presentation the frontend can do without a backend key.
 *
 * The recipient is `req.admin.id` from the session, never a parameter — an
 * admin reads their OWN feed only.
 */
@ApiTags('notifications')
@Controller('admin/notifications')
@UseGuards(PermissionsGuard)
export class AdminNotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly realtime: NotificationsRealtimeGateway,
  ) {}

  /**
   * The live stream — the operator's bell, without waiting for a poll.
   *
   * Same transport and same reasoning as the portal's (see that controller),
   * and the same fifteen-minute server-side close. That close matters more
   * here: `AdminGuard` re-reads `admins.status` on every request precisely so
   * a suspension bites on the NEXT one, and a stream held open indefinitely
   * would be a session with no next request. Ending it forces a reconnect
   * through the full guard chain, so a suspended operator's bell goes quiet
   * within the window rather than at token expiry.
   */
  @Sse('stream')
  @AnyAdmin('Streams the actor’s OWN feed; every frame is filtered to their id before it is sent.')
  @ApiExcludeEndpoint()
  @NotClientScoped(
    'Carries no client data — an id and a kind slug, for a row the reader already owns.',
  )
  stream(@Req() req: Request & { admin: Admin }) {
    const recipient = { kind: 'admin' as const, id: req.admin.id };
    return notificationStream(this.realtime.streamFor(recipient), recipient);
  }

  @Get()
  @AnyAdmin(
    'The feed contains only rows fanned out to THIS admin because they held the relevant ' +
      'permission and client scope when the event happened. See the class note.',
  )
  @ApiCookieAuth()
  @ApiOperation({ summary: "The signed-in admin's notification feed, newest first" })
  @ApiOkResponse({ type: NotificationListResponseDto })
  @ApiQuery({ name: 'limit', required: false })
  @ApiQuery({ name: 'cursor', required: false, description: 'Opaque keyset cursor (R-2.4).' })
  @ApiQuery({ name: 'unread', required: false, description: "Pass 'true' to see only unread." })
  @NotClientScoped(
    'Scope is applied at WRITE time: the fan-out only creates rows for admins whose client ' +
      'scope covered the subject client (NotificationsService.notifyAdminsWithPermission), so ' +
      'every row here is already inside the reader’s territory.',
  )
  list(
    @Req() req: Request & { admin: Admin },
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    @Query('unread') unread?: string,
  ) {
    return this.notifications.list(
      { kind: 'admin', id: req.admin.id },
      {
        limit: limit ? Number.parseInt(limit, 10) : undefined,
        cursor: cursor ? decodeCursor(cursor) : undefined,
        unreadOnly: unread === 'true',
      },
    );
  }

  @Get('unread-count')
  @AnyAdmin('A count of the actor’s own unread rows. No client is named in the response.')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Unread notifications for the signed-in admin — the badge number' })
  @ApiOkResponse({ type: NotificationUnreadCountDto })
  @NotClientScoped('A bare count of the actor’s own rows; the response names no client.')
  async unreadCount(@Req() req: Request & { admin: Admin }): Promise<NotificationUnreadCountDto> {
    return { count: await this.notifications.unreadCount({ kind: 'admin', id: req.admin.id }) };
  }

  @Post(':id/read')
  @HttpCode(200)
  @AnyAdmin('Marks the actor’s OWN notification read; ownership is the WHERE clause.')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Mark one notification read. Idempotent.' })
  @ApiOkResponse({ type: NotificationDto })
  @NotAudited(
    'Marks the actor’s own bell row read — touches no client data, no money and no configuration. ' +
      'The same class of action as reading one’s own profile.',
  )
  @NotClientScoped('Operates on the actor’s own row; a foreign id reads as not found.')
  markRead(@Req() req: Request & { admin: Admin }, @Param('id', ParseUUIDPipe) id: string) {
    return this.notifications.markRead({ kind: 'admin', id: req.admin.id }, id);
  }

  @Post('read-all')
  @HttpCode(200)
  @AnyAdmin('Marks the actor’s OWN notifications read; touches nobody else’s rows.')
  @ApiCookieAuth()
  @ApiOperation({ summary: 'Mark every unread notification read. Idempotent.' })
  @ApiOkResponse({ type: NotificationsMarkAllReadResponseDto })
  @NotAudited('Clears the actor’s own unread markers — no client data, no money, no configuration.')
  @NotClientScoped('Operates only on rows addressed to the actor.')
  async markAllRead(
    @Req() req: Request & { admin: Admin },
  ): Promise<NotificationsMarkAllReadResponseDto> {
    return {
      updated: await this.notifications.markAllRead({ kind: 'admin', id: req.admin.id }),
    };
  }
}
