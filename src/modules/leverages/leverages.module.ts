import { Module } from '@nestjs/common';
import { AdminLeveragesController } from './admin-leverages.controller';
import { LeveragesService } from './leverages.service';
import { AdminAuthModule } from '../admin/admin-auth.module';

/**
 * The leverage ladder — operator data rather than a CSV in a settings row.
 *
 * `LeveragesService` is EXPORTED because the account-opening path has to ask it
 * two questions: what may this client choose, and is the ratio they chose one
 * we currently offer. That is the runtime check replacing a list parsed out of
 * `trading_settings.leverages`.
 *
 * There is NO public controller, unlike `CurrenciesModule`. A client never
 * fetches the ladder on its own — it arrives with the rest of the
 * account-opening offer from `GET /trading/accounts/self-service`, which needs
 * the caps and the demo ceiling in the same response. A second endpoint
 * returning half of that would be one more thing to keep in step for no screen
 * that wants it.
 */
@Module({
  // AdminAuthModule for PermissionsGuard on the admin controller — the same
  // import currencies and platform-links make, for the same reason.
  imports: [AdminAuthModule],
  controllers: [AdminLeveragesController],
  providers: [LeveragesService],
  exports: [LeveragesService],
})
export class LeveragesModule {}
