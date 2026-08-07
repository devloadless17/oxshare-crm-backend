import { Module } from '@nestjs/common';
import { TradingController } from './trading.controller';
import { TradingService } from './trading.service';
import { IdentityModule } from '../identity/identity.module';

/**
 * The client's view of their own trading accounts.
 *
 * `IdentityModule` for `JwtAuthGuard` and `EmailVerifiedGuard` — the same
 * import `IbModule` makes for its client-facing controller.
 *
 * Separate from the admin holdings surface on purpose: that one reads ACROSS
 * clients, is permission-gated, joins owner identity onto every row and is
 * cursor-paged. Sharing a service between the two would mean one query trying
 * to be both, with client scope as an optional parameter — and an optional
 * scope is one that is eventually omitted.
 *
 * The service is exported so the transfer screen's destination list has a
 * single source; nothing else should reach into `trading_accounts` directly.
 */
@Module({
  imports: [IdentityModule],
  controllers: [TradingController],
  providers: [TradingService],
  exports: [TradingService],
})
export class TradingModule {}
