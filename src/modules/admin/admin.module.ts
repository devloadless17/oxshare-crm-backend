import { Module } from '@nestjs/common';
import { AdminAuditController } from './admin-audit.controller';
import { AdminApiKeysController } from './admin-api-keys.controller';
import { AdminSecuritySettingsController } from './admin-security-settings.controller';
import { SecuritySettingsService } from './security-settings.service';
import { AdminAuthController } from './admin-auth.controller';
import { AdminTagsController } from './admin-tags.controller';
import { AdminClientsController } from './admin-clients.controller';
import { AdminComplianceController } from './admin-compliance.controller';
import { AdminRbacController } from './admin-rbac.controller';
import { AdminAuthService } from './admin-auth.service';
import { AdminProfileService } from './admin-profile.service';
import { AdminTagsService } from './admin-tags.service';
import { AdminClientsService } from './admin-clients.service';
import { AdminComplianceService } from './admin-compliance.service';
import { AdminRbacService } from './admin-rbac.service';
import { ApiKeysService } from './api-keys.service';
import { AdminMoneyService } from './admin-money.service';
import { AdminMoneyController } from './admin-money.controller';
import { AdminStatsService } from './admin-stats.service';
import { AdminStatsController } from './admin-stats.controller';
import { AdminHoldingsController } from './admin-holdings.controller';
import { PaymentsModule } from '../payments/payments.module';
import { WalletModule } from '../wallet/wallet.module';
import { CurrenciesModule } from '../currencies/currencies.module';
import { AdminAuthModule } from './admin-auth.module';
import { ComplianceModule } from '../compliance/compliance.module';
import { AdminExportModule } from './admin-export.module';

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
  AdminAuthService,
  /*
   * What an administrator may do to their OWN account, kept apart from
   * `AdminRbacService` — see the note at the top of that file. It needs
   * `StoredFilesService` for the avatar, which is provided directly below
   * rather than by importing `IdentityModule`: the service is a stateless
   * directory writer with no dependencies, and pulling the whole portal
   * identity graph into the back office to reach it would be the larger cost.
   */
  AdminProfileService,
  AdminRbacService,
  ApiKeysService,
  AdminComplianceService,
  AdminClientsService,
  AdminTagsService,
  SecuritySettingsService,
  AdminMoneyService,
  // Reads only, and only through StoreModule's StatsStore — no money service and
  // no audit writer, because it neither moves money nor names a client.
  AdminStatsService,
];

@Module({
  /*
   * `PaymentsModule` and `WalletModule` for the withdrawal desk —
   * `AdminMoneyService` drives the same `TransactionsService` state machine the
   * client-facing routes do, rather than a second copy of it. The dependency
   * runs one way: payments imports `AdminAuthModule` for its guards, never this
   * module, so the back-office graph stays out of the portal's routes.
   */
  // `AdminExportModule` carries AdminExportService for the export routes that sit
  // on these same controllers — see that module for why it is separate.
  imports: [
    ComplianceModule,
    AdminAuthModule,
    PaymentsModule,
    WalletModule,
    AdminExportModule,
    // For AdminMoneyService.openWallet: a wallet may only be opened in a
    // currency the platform actually holds and has enabled, and
    // CurrenciesService is what answers that.
    CurrenciesModule,
  ],
  // Nine controllers share the 'admin' prefix, one per concern, mirroring the
  // services. Express registers all of their routes; there are no path
  // collisions. Order is irrelevant — no two routes overlap. (`stats/*` sits
  // under no parameterised sibling, so it needs no ordering care of the kind
  // `clients/export` before `clients/:id` does.)
  controllers: [
    AdminAuthController,
    AdminClientsController,
    AdminTagsController,
    AdminComplianceController,
    AdminRbacController,
    AdminAuditController,
    AdminApiKeysController,
    AdminSecuritySettingsController,
    AdminMoneyController,
    AdminStatsController,
    AdminHoldingsController,
  ],
  /*
   * The RBAC-08 `IpAllowlistGuard` was registered HERE as an APP_GUARD and is
   * gone with the feature. It restricted the whole admin surface to configured
   * CIDR ranges and was a no-op until somebody added a rule.
   *
   * What replaced it is nothing: admin routes are gated on authentication and
   * permissions only. If a network restriction is wanted again, it belongs at
   * the edge — a load balancer or WAF rule — rather than as an application
   * guard reading a table, which is where it was.
   */
  providers: [...ADMIN_SERVICES],
  // Re-exported so importers keep reaching the audit writer through this
  // module, as they did when it was provided here.
  exports: [...ADMIN_SERVICES, AdminAuthModule],
})
export class AdminModule {}
