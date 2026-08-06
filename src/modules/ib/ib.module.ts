import { Module } from '@nestjs/common';
import { AdminIbLevelsController } from './admin-ib-levels.controller';
import { IbLevelsService } from './ib-levels.service';
import { AdminAuthModule } from '../admin/admin-auth.module';

/**
 * The introducing-broker programme.
 *
 * Rebuilt from zero after the commission engine was removed. This module owns
 * the payout LADDER today; partner applications, partner accounts and the
 * approval flow join it next, and they share a module because they share the
 * one rule that matters — a partner's level decides both what they earn and how
 * many partners they may recruit, so the two cannot live apart without one of
 * them re-deriving the other.
 *
 * `AdminAuthModule` for `PermissionsGuard`, the same import the settings,
 * platform-links and currencies modules make.
 */
@Module({
  imports: [AdminAuthModule],
  controllers: [AdminIbLevelsController],
  providers: [IbLevelsService],
  exports: [IbLevelsService],
})
export class IbModule {}
