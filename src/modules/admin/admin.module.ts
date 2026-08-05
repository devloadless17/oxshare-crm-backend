import { Module } from '@nestjs/common';
import { AdminAuditController } from './admin-audit.controller';
import { AdminAuthController } from './admin-auth.controller';
import { AdminClientsController } from './admin-clients.controller';
import { AdminComplianceController } from './admin-compliance.controller';
import { AdminMoneyController } from './admin-money.controller';
import { AdminRbacController } from './admin-rbac.controller';
import { APP_GUARD } from '@nestjs/core';
import { AdminAuditService } from './admin-audit.service';
import { AdminIpAllowlistController } from './admin-ip-allowlist.controller';
import { AdminIpAllowlistService } from './admin-ip-allowlist.service';
import { IpAllowlistGuard } from './guards/ip-allowlist.guard';
import { AdminAuthService } from './admin-auth.service';
import { AdminClientsService } from './admin-clients.service';
import { AdminComplianceService } from './admin-compliance.service';
import { AdminMoneyService } from './admin-money.service';
import { AdminRbacService } from './admin-rbac.service';

const ADMIN_SERVICES = [
  AdminAuditService,
  AdminIpAllowlistService,
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
  // Seven controllers share the 'admin' prefix, one per concern, mirroring the
  // services. Express registers all of their routes; there are no path
  // collisions. Order is irrelevant — no two routes overlap.
  controllers: [
    AdminAuthController,
    AdminClientsController,
    AdminComplianceController,
    AdminMoneyController,
    AdminRbacController,
    AdminAuditController,
    AdminIpAllowlistController,
  ],
  providers: [
    ...ADMIN_SERVICES,
    // RBAC-08, global rather than per-route for the same reason CsrfGuard is: a
    // route that forgets to opt IN is indistinguishable from one that never
    // needed it. The guard itself is a no-op until the allowlist has a row.
    { provide: APP_GUARD, useClass: IpAllowlistGuard },
  ],
  exports: ADMIN_SERVICES,
})
export class AdminModule {}
