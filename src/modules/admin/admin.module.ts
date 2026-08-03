import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AdminAuthModule } from './admin-auth.module';
import { ComplianceModule } from '../compliance/compliance.module';
import { PaymentsModule } from '../payments/payments.module';
import { WalletModule } from '../wallet/wallet.module';
import { PartnersModule } from '../partners/partners.module';

@Module({
  imports: [
    ComplianceModule,
    PaymentsModule,
    WalletModule,
    PartnersModule,
    AdminAuthModule,
  ],
  controllers: [AdminController],
  providers: [AdminService],
  exports: [AdminService],
})
export class AdminModule {}
