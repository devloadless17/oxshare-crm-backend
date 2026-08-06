import { Module } from '@nestjs/common';
import { TradingController } from './trading.controller';
import { TradingService } from './trading.service';
import { PartnersModule } from '../partners/partners.module';
import { IdentityModule } from '../identity/identity.module';

/** Trading accounts · groups · tiers */
@Module({
  // IdentityModule for `JwtAuthGuard` on GET /trading/accounts — the same import
  // WalletModule makes for the same reason. `DRIZZLE_DB` needs no import:
  // DatabaseModule is @Global.
  imports: [PartnersModule, IdentityModule],
  controllers: [TradingController],
  providers: [TradingService],
  exports: [TradingService],
})
export class TradingModule {}
