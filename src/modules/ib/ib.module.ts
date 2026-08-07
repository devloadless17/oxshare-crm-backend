import { Module } from '@nestjs/common';
import { AdminIbController } from './admin-ib.controller';
import { AdminIbLevelsController } from './admin-ib-levels.controller';
import { IbController } from './ib.controller';
import { IbApplicationsService } from './ib-applications.service';
import { IbLevelsService } from './ib-levels.service';
import { AdminAuthModule } from '../admin/admin-auth.module';
import { IdentityModule } from '../identity/identity.module';
import { EmailModule } from '../email/email.module';
import { AdminExportModule } from '../admin/admin-export.module';

/**
 * The introducing-broker programme.
 *
 * Rebuilt from zero after the commission engine was removed. It owns the payout
 * LADDER, partner APPLICATIONS and partner ACCOUNTS together, because they share
 * the one rule that matters — a partner's level decides both what they earn and
 * how many partners they may recruit, so splitting them would leave one side
 * re-deriving the other.
 *
 * `AdminAuthModule` for `PermissionsGuard`, the same import the settings,
 * platform-links and currencies modules make. `IdentityModule` for
 * `JwtAuthGuard` and `EmailVerifiedGuard`, which the CLIENT-facing controller
 * needs — this is the first module here to carry both surfaces.
 */
@Module({
  // `AdminExportModule` for the two partner exports. A narrow import, like
  // `AdminAuthModule` above — never the whole `AdminModule`.
  imports: [AdminAuthModule, IdentityModule, EmailModule, AdminExportModule],
  controllers: [IbController, AdminIbController, AdminIbLevelsController],
  providers: [IbApplicationsService, IbLevelsService],
  exports: [IbApplicationsService, IbLevelsService],
})
export class IbModule {}
