import { Module } from '@nestjs/common';
import { ThreePayClient } from './threepay.client';
import { ThreePayConfigService } from './threepay-config.service';

/**
 * The 3pay connection substrate — its client and its settings (0174). The
 * adapter and the webhook receiver are registered in `PaymentsModule` beside
 * every other provider's; `PaymentProvidersStore` comes from the global
 * StoreModule.
 */
@Module({
  providers: [ThreePayClient, ThreePayConfigService],
  exports: [ThreePayClient, ThreePayConfigService],
})
export class ThreePayModule {}
