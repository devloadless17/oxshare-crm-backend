import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { IdentityModule } from './modules/identity/identity.module';
import { TradingModule } from './modules/trading/trading.module';
import { WalletModule } from './modules/wallet/wallet.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { PartnersModule } from './modules/partners/partners.module';
import { ComplianceModule } from './modules/compliance/compliance.module';
import { AdminModule } from './modules/admin/admin.module';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [
    // Global config — loads .env
    ConfigModule.forRoot({ isGlobal: true }),

    // Domain modules (map 1:1 to ARCHITECTURE.md §4)
    IdentityModule,
    TradingModule,
    WalletModule,
    PaymentsModule,
    PartnersModule,
    ComplianceModule,
    AdminModule,

    // Infrastructure
    HealthModule,
  ],
})
export class AppModule {}
