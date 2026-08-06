import { Module } from '@nestjs/common';
import { TradingController } from './trading.controller';
import { TradingService } from './trading.service';
import { Mt5WebhookController } from './mt5-webhook.controller';
import { PartnersModule } from '../partners/partners.module';
import { IdentityModule } from '../identity/identity.module';

/** MT5 accounts · groups · tiers · deal ingestion */
@Module({
  // IdentityModule for `JwtAuthGuard` on GET /trading/accounts — the same import
  // WalletModule makes for the same reason. `DRIZZLE_DB` needs no import:
  // DatabaseModule is @Global.
  imports: [PartnersModule, IdentityModule],
  controllers: [TradingController, Mt5WebhookController],
  providers: [TradingService],
  exports: [TradingService],
})
export class TradingModule {}
