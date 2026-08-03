import { Module } from '@nestjs/common';
import { TradingController } from './trading.controller';
import { TradingService } from './trading.service';
import { Mt5WebhookController } from './mt5-webhook.controller';
import { PartnersModule } from '../partners/partners.module';

/** MT5 accounts · groups · tiers · deal ingestion */
@Module({
  imports: [PartnersModule],
  controllers: [TradingController, Mt5WebhookController],
  providers: [TradingService],
  exports: [TradingService],
})
export class TradingModule {}
