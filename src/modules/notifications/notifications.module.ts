import { Global, Module } from '@nestjs/common';
import { NOTIFICATION_DISPATCH } from '../../common/provisioning/notification-dispatch.port';
import { AdminAuthModule } from '../admin/admin-auth.module';
import { IdentityModule } from '../identity/identity.module';
import { AdminNotificationsController } from './admin-notifications.controller';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NotificationsRealtimeGateway } from './realtime.gateway';

/**
 * The in-app notification feed — the implementation behind
 * `NOTIFICATION_DISPATCH` plus (from the controllers step) the two feed
 * controllers.
 *
 * `@Global()` for the same reason `EmailModule` and the two provisioning
 * bindings are: five domain modules dispatch notifications, and each of them
 * importing this module is how a cycle starts. They inject the TOKEN declared
 * in `common/`; this module binds the implementation — the
 * `WALLET_PROVISIONING` recipe exactly.
 */
@Global()
@Module({
  // `AdminAuthModule` for `PermissionsGuard` (the payments-module precedent);
  // `IdentityModule` for `JwtAuthGuard` on the client controller.
  imports: [AdminAuthModule, IdentityModule],
  controllers: [NotificationsController, AdminNotificationsController],
  providers: [
    NotificationsService,
    NotificationsRealtimeGateway,
    { provide: NOTIFICATION_DISPATCH, useExisting: NotificationsService },
  ],
  exports: [NotificationsService, NotificationsRealtimeGateway, NOTIFICATION_DISPATCH],
})
export class NotificationsModule {}
