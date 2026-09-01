import { Module } from '@nestjs/common';
import { ExternalLinksController } from './external-links.controller';
import { AdminExternalLinksController } from './admin-external-links.controller';
import { ExternalLinksService } from './external-links.service';
import { IdentityModule } from '../identity/identity.module';
import { AdminAuthModule } from '../admin/admin-auth.module';

/**
 * The portal's sidebar links — one service, two audiences.
 *
 * Both controllers live here rather than the admin one being filed under
 * `modules/admin`, for the reason `PlatformsModule` gives: they are two views of
 * ONE piece of operator data, and splitting them across modules is how the read
 * and the write drift — a field added on one side and not the other, or a
 * validation rule applied to the admin write and not to whatever else learns to
 * write it later. `assertSafeExternalUrl` in particular has to be unmissable,
 * because it is the only thing between an admin account and stored XSS on every
 * client's chrome.
 *
 * The guards are what separate the audiences, and they are visible on each route
 * rather than implied by which folder the file sits in: `IdentityModule` for the
 * client read's `JwtAuthGuard`, `AdminAuthModule` for the admin half's
 * `PermissionsGuard`.
 *
 * Nothing is EXPORTED. Unlike `LeveragesService`, no other module has a question
 * for this one — a link decides nothing about an account, a balance or a trade.
 */
@Module({
  imports: [IdentityModule, AdminAuthModule],
  controllers: [ExternalLinksController, AdminExternalLinksController],
  providers: [ExternalLinksService],
})
export class ExternalLinksModule {}
