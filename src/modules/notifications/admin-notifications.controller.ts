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
import { ApiCookieAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { AnyAdmin, PermissionsGuard, type AuthenticatedAdmin } from '../admin/guards/admin.guard';
import { Audited, NotAudited } from '../admin/guards/audited.decorator';
import { ScopedToClients } from '../admin/guards/client-scope.decorator';
import { decodeCursor } from '../../common/pagination';
import { NotificationsService } from './notifications.service';
import {
  AdminNotificationCloseDto,
  AdminNotificationCloseResponseDto,
  AdminNotificationListResponseDto,
  AdminNotificationMarkResponseDto,
  AdminNotificationSummaryDto,
  AdminNotificationsQueryDto,
  AdminNotificationsReadSubjectDto,
} from './dto/admin-notifications.dto';
import { NotificationsMarkAllReadResponseDto } from './dto/notifications.dto';

/** The name fields the feed carries — what `maskedFields` reports on. */
const NAME_FIELDS = ['client.firstName', 'client.lastName'] as const;

/** The scope stance every route below shares — one sentence, not five drifting ones. */
const READ_TIME_SCOPE =
  "Scoped at READ time: every query ANDs clientScopePredicate(admin's scope) over the row's " +
  'subject client, and the kinds the admin can act on now — so a re-tagged client or a ' +
  'revoked permission takes the row away on the next request. Out of scope reads as absent.';

/**
 * The admin console's bell — a list of TASKS: things the reader must handle.
 *
 * ## What changed (migration 0140), and why
 *
 * This feed used to be `@NotClientScoped`, bounded only by the fan-out at
 * write time, on the argument that rows carried no client identity. That was
 * true while a row could say nothing more useful than "something happened to
 * <uuid>". A task has to name its client, so the argument expired, and scope
 * is now applied on every read — list, badge and every marker share one
 * visibility definition in `NotificationsStore.adminVisibility`.
 *
 * Handled tasks leave every admin's inbox without anybody touching this
 * controller: the item tables' triggers resolve them the moment the item
 * leaves its queue, whichever path moved it. That is the ONLY way out of the
 * inbox (the owner's rule, 5 Oct 2026): opening a task marks it seen, nothing
 * more, so there is no "mark unread" and no "mark all read" for an admin.
 *
 * ## `@AnyAdmin`, not a `notifications.*` permission key — a decision, written down
 *
 * The feed shows a kind only to an admin holding a permission that kind needs
 * (the catalogue), so a `notifications.view` key would gate a mirror of
 * information the admin was already granted — the grantable no-op the
 * permissions catalog's own `clients.edit` note argues against.
 *
 * The reader is `req.admin` from the session, never a parameter — an admin
 * reads and marks their OWN feed only.
 */
@ApiTags('notifications')
@Controller('admin/notifications')
@UseGuards(PermissionsGuard)
export class AdminNotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @AnyAdmin(
    'An admin reads only their own tasks, filtered to kinds they can act on. See the class note.',
  )
  @ApiCookieAuth()
  @ApiOperation({ summary: "The signed-in admin's tasks, newest first — inbox or history" })
  @ApiOkResponse({ type: AdminNotificationListResponseDto })
  @ScopedToClients(READ_TIME_SCOPE)
  async list(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Query() query: AdminNotificationsQueryDto,
  ): Promise<AdminNotificationListResponseDto> {
    const page = await this.notifications.adminFeed(req.admin, {
      view: query.view ?? 'history',
      category: query.category,
      q: query.q,
      cursor: query.cursor ? decodeCursor(query.cursor) : undefined,
      limit: query.limit,
    });
    return {
      items: page.items.map((row) => ({
        id: row.id,
        kind: row.kind,
        category: row.category,
        params: row.params,
        readAt: row.readAt,
        createdAt: row.createdAt,
        subject: { kind: row.subjectKind, id: row.subjectId },
        client: {
          portalId: row.client.portalId,
          firstName: row.client.firstName,
          lastName: row.client.lastName,
        },
        resolution: row.resolvedAt
          ? {
              at: row.resolvedAt,
              outcome: row.resolution ?? 'resolved',
              byName: row.resolvedByName,
            }
          : null,
      })),
      nextCursor: page.nextCursor,
      // The interceptor REMOVES masked fields by shape; this says which, so the
      // screen can print "hidden for your role" instead of an empty name.
      maskedFields: NAME_FIELDS.filter((key) => req.admin.fieldMask.includes(key)),
    };
  }

  @Get('unread-count')
  @AnyAdmin('A count of the actor’s own open tasks. No client is named in the response.')
  @ApiCookieAuth()
  @ApiOperation({
    summary:
      'Tasks not yet handled by anybody, seen or not — the bell badge, in total and per category',
  })
  @ApiOkResponse({ type: AdminNotificationSummaryDto })
  @ScopedToClients(READ_TIME_SCOPE)
  summary(
    @Req() req: Request & { admin: AuthenticatedAdmin },
  ): Promise<AdminNotificationSummaryDto> {
    return this.notifications.adminSummary(req.admin);
  }

  @Post('read-subject')
  @HttpCode(200)
  @AnyAdmin('Marks the actor’s OWN tasks about one item read — they opened the item itself.')
  @ApiCookieAuth()
  @ApiOperation({
    summary:
      'The reader opened an item (e.g. a KYC review) — mark their tasks about it seen. They stay ' +
      'in the inbox until the item is handled.',
  })
  @ApiOkResponse({ type: NotificationsMarkAllReadResponseDto })
  @NotAudited('Clears the actor’s own unread markers — no client data, no money, no configuration.')
  @ScopedToClients(READ_TIME_SCOPE)
  async markSubjectRead(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Body() body: AdminNotificationsReadSubjectDto,
  ): Promise<NotificationsMarkAllReadResponseDto> {
    return {
      updated: await this.notifications.markAdminSubjectRead(
        req.admin,
        body.subjectKind,
        body.subjectId,
      ),
    };
  }

  @Post(':id/close')
  @HttpCode(200)
  @AnyAdmin(
    'The kind’s ACTION permission is enforced by the feed’s visibility: a row of a kind the ' +
      'reader cannot act on now reads as absent, so only someone who could decide the item ' +
      'can close its task.',
  )
  @ApiCookieAuth()
  @ApiOperation({
    summary:
      'End a task by the decision its kind declares for leaving the item as it is (a clawback: ' +
      'the partner keeps the commission). Ends it for EVERY admin; 409 if already handled.',
  })
  @ApiOkResponse({ type: AdminNotificationCloseResponseDto })
  @Audited('notification.task_close')
  @ScopedToClients(READ_TIME_SCOPE)
  close(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AdminNotificationCloseDto,
  ): Promise<AdminNotificationCloseResponseDto> {
    return this.notifications.closeAdminTask(req.admin, id, body.reason);
  }

  @Post(':id/read')
  @HttpCode(200)
  @AnyAdmin('Marks the actor’s OWN task read; ownership and scope are the WHERE clause.')
  @ApiCookieAuth()
  @ApiOperation({
    summary: 'Mark one task seen. It stays in the inbox until handled. Idempotent.',
  })
  @ApiOkResponse({ type: AdminNotificationMarkResponseDto })
  @NotAudited(
    'Marks the actor’s own bell row read — touches no client data, no money and no configuration. ' +
      'The same class of action as reading one’s own profile.',
  )
  @ScopedToClients(READ_TIME_SCOPE)
  markRead(
    @Req() req: Request & { admin: AuthenticatedAdmin },
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AdminNotificationMarkResponseDto> {
    return this.notifications.markAdminRead(req.admin, id);
  }
}
