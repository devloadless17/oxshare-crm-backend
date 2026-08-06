import { Module } from '@nestjs/common';
import { CurrenciesController } from './currencies.controller';
import { AdminCurrenciesController } from './admin-currencies.controller';
import { CurrenciesService } from './currencies.service';
import { AdminAuthModule } from '../admin/admin-auth.module';

/**
 * What money this platform can hold — operator data rather than a code constant.
 *
 * `CurrenciesService` is EXPORTED because three things outside this module have
 * to ask it questions: registration (which currency does a new client's first
 * wallet open in), KYC approval (which currencies does an approved client get a
 * wallet in), and the payment paths (is this code one we accept right now).
 * That is the runtime check which replaced the old `'USD' | 'USDT'` union.
 */
@Module({
  // AdminAuthModule for PermissionsGuard on the admin controller — the same
  // import the settings and platform-links modules make, for the same reason.
  // Both controllers live here rather than the admin one being filed under
  // modules/admin: they are two views of ONE piece of operator data, and
  // splitting them is how a validation rule ends up on one write and not the
  // other. The guards separate the audiences, visibly, per route.
  imports: [AdminAuthModule],
  controllers: [CurrenciesController, AdminCurrenciesController],
  providers: [CurrenciesService],
  exports: [CurrenciesService],
})
export class CurrenciesModule {}
