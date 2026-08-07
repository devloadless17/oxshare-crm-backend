import { Module } from '@nestjs/common';
import { AdminAuditController } from './admin-audit.controller';
import { AdminSecuritySettingsController } from './admin-security-settings.controller';
import { SecuritySettingsService } from './security-settings.service';
import { AdminAuthController } from './admin-auth.controller';
import { AdminTagsController } from './admin-tags.controller';
import { AdminClientsController } from './admin-clients.controller';
import { AdminComplianceController } from './admin-compliance.controller';
import { AdminRbacController } from './admin-rbac.controller';
import { APP_GUARD } from '@nestjs/core';
import { AdminIpAllowlistController } from './admin-ip-allowlist.controller';
import { AdminIpAllowlistService } from './admin-ip-allowlist.service';
import { IpAllowlistGuard } from './guards/ip-allowlist.guard';
import { AdminAuthService } from './admin-auth.service';
import { AdminTagsService } from './admin-tags.service';
import { AdminClientsService } from './admin-clients.service';
import { AdminComplianceService } from './admin-compliance.service';
import { AdminRbacService } from './admin-rbac.service';
import { AdminMoneyService } from './admin-money.service';
import { AdminMoneyController } from './admin-money.controller';
import { PaymentsModule } from '../payments/payments.module';
import { WalletModule } from '../wallet/wallet.module';
import { AdminAuthModule } from './admin-auth.module';
import { ComplianceModule } from '../compliance/compliance.module';

/*
 * Every import above this array, including the ones that used to sit below it.
 *
 * `AdminMoneyService` is a MEMBER of it, and a class imported after the
 * `const` that references it is a temporal dead zone the moment tsc emits
 * CommonJS: `ReferenceError: Cannot access 'admin_money_service_1' before
 * initialization`, at boot, from a file that typechecks and that vitest's ESM
 * transform runs happily. The trailing imports predate this change and were
 * harmless only because nothing in the array named them.
 */

const ADMIN_SERVICES = [
  AdminIpAllowlistService,
  AdminAuthService,
  AdminRbacService,
  AdminComplianceService,
  AdminClientsService,
  AdminTagsService,
  SecuritySettingsService,
  AdminMoneyService,
];

@Module({
  /*
   * `PaymentsModule` and `WalletModule` for the withdrawal desk —
   * `AdminMoneyService` drives the same `TransactionsService` state machine the
   * client-facing routes do, rather than a second copy of it. The dependency
   * runs one way: payments imports `AdminAuthModule` for its guards, never this
   * module, so the back-office graph stays out of the portal's routes.
   */
  imports: [ComplianceModule, AdminAuthModule, PaymentsModule, WalletModule],
  // Eight controllers share the 'admin' prefix, one per concern, mirroring the
  // services. Express registers all of their routes; there are no path
  // collisions. Order is irrelevant — no two routes overlap.
  controllers: [
    AdminAuthController,
    AdminClientsController,
    AdminTagsController,
    AdminComplianceController,
    AdminRbacController,
    AdminAuditController,
    AdminSecuritySettingsController,
    AdminIpAllowlistController,
    AdminMoneyController,
  ],
  providers: [
    ...ADMIN_SERVICES,
    // RBAC-08, global rather than per-route for the same reason CsrfGuard is: a
    // route that forgets to opt IN is indistinguishable from one that never
    // needed it. The guard itself is a no-op until the allowlist has a row.
    { provide: APP_GUARD, useClass: IpAllowlistGuard },
  ],
  // Re-exported so importers keep reaching the audit writer through this
  // module, as they did when it was provided here.
  exports: [...ADMIN_SERVICES, AdminAuthModule],
})
export class AdminModule {}
