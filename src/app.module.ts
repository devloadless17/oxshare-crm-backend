import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { validateEnv } from './config/env.validation';
import { DatabaseModule } from './database/database.module';
import { EmailModule } from './modules/email/email.module';
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
    // Global config — loads .env, validated at boot (refuses to start on invalid)
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),

    // §9 repeatable jobs. Interim host for the confirm job until BullMQ lands.
    ScheduleModule.forRoot(),

    // Infrastructure
    DatabaseModule,
    EmailModule,
    HealthModule,

    // Domain modules
    IdentityModule,
    TradingModule,
    WalletModule,
    PaymentsModule,
    PartnersModule,
    ComplianceModule,
    AdminModule,
  ],
})
export class AppModule {}
