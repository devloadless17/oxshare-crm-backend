import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminAuditService } from './admin-audit.service';
import { AdminAuthService } from './admin-auth.service';
import { AdminClientsService } from './admin-clients.service';
import { AdminComplianceService } from './admin-compliance.service';
import { AdminMoneyService } from './admin-money.service';
import { AdminRbacService } from './admin-rbac.service';

const ADMIN_SERVICES = [
  AdminAuditService,
  AdminAuthService,
  AdminRbacService,
  AdminComplianceService,
  AdminClientsService,
  AdminMoneyService,
];
import { AdminAuthModule } from './admin-auth.module';
import { ComplianceModule } from '../compliance/compliance.module';
import { PaymentsModule } from '../payments/payments.module';
import { WalletModule } from '../wallet/wallet.module';
import { PartnersModule } from '../partners/partners.module';

@Module({
  imports: [ComplianceModule, PaymentsModule, WalletModule, PartnersModule, AdminAuthModule],
  controllers: [AdminController],
  providers: ADMIN_SERVICES,
  exports: ADMIN_SERVICES,
})
export class AdminModule {}
