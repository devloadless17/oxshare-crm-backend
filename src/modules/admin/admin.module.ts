import { AdminCountriesController } from './admin-countries.controller';
import { AdminCountriesService } from './admin-countries.service';
import { Module } from '@nestjs/common';
import { AdminAuditController } from './admin-audit.controller';
import { AdminApiKeysController } from './admin-api-keys.controller';
import { AdminAuthController } from './admin-auth.controller';
import { AdminTagsController } from './admin-tags.controller';
import { SignupLinksController } from './signup-links.controller';
import { AdminClientsController } from './admin-clients.controller';
import { AdminClientIdentityController } from './admin-client-identity.controller';
import { AdminClientIdentityService } from './admin-client-identity.service';
import { AdminClientFollowupController } from './admin-client-followup.controller';
import { AdminClientFollowupService } from './admin-client-followup.service';
import { AdminComplianceController } from './admin-compliance.controller';
import { AdminKycAssistController } from './admin-kyc-assist.controller';
import { AdminClientCreateController } from './admin-client-create.controller';
import { AdminRbacController } from './admin-rbac.controller';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { HiddenEmailLookupInterceptor } from './hidden-email-lookup.interceptor';
import { DenialAuditInterceptor } from './denial-audit.interceptor';
import { AdminIpAllowlistController } from './admin-ip-allowlist.controller';
import { AdminIpAllowlistService } from './admin-ip-allowlist.service';
import { IpAllowlistGuard } from './guards/ip-allowlist.guard';
import { AdminAuthService } from './admin-auth.service';
import { AdminProfileService } from './admin-profile.service';
import { AdminTagsService } from './admin-tags.service';
import { SignupLinksService } from './signup-links.service';
import { AdminClientsBulkService } from './admin-clients-bulk.service';
import { AdminClientsService } from './admin-clients.service';
import { AdminComplianceService } from './admin-compliance.service';
import { AdminKycAssistService } from './admin-kyc-assist.service';
import { AdminClientCreateService } from './admin-client-create.service';
import { ClientCreation } from '../identity/client-creation';
import { AdminRbacService } from './admin-rbac.service';
import { ApiKeysService } from './api-keys.service';
import { AdminMoneyService } from './admin-money.service';
import { AdminMoneyController } from './admin-money.controller';
import { AdminFinancialController } from './admin-financial.controller';
import { AdminStatsService } from './admin-stats.service';
import { AdminStatsController } from './admin-stats.controller';
import { AdminHoldingsController } from './admin-holdings.controller';
import { AdminBridgeController } from './admin-bridge.controller';
import { TradingModule } from '../trading/trading.module';
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
  AdminIpAllowlistService,
  AdminClientIdentityService,
  AdminClientFollowupService,
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
  // "Complete KYC" (0210): staff do a client's KYC through the client's own actions.
  AdminKycAssistService,
  // "New client" (0211): staff create a client by the same checks a sign-up passes.
  ClientCreation,
  AdminClientCreateService,
  AdminClientsService,
  AdminTagsService,
  SignupLinksService,
  AdminClientsBulkService,
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
    // For AdminBridgeController: TradingModule exports Mt5BridgeClient, which the
    // bridge diagnostics routes call straight through.
    TradingModule,
  ],
  // Nine controllers share the 'admin' prefix, one per concern, mirroring the
  // services. Express registers all of their routes; there are no path
  // collisions. Order is irrelevant — no two routes overlap. (`stats/*` sits
  // under no parameterised sibling, so it needs no ordering care of the kind
  // `clients/export` before `clients/:id` does.)
  controllers: [
    AdminCountriesController,
    AdminAuthController,
    AdminClientsController,
    AdminClientIdentityController,
    AdminClientFollowupController,
    AdminTagsController,
    SignupLinksController,
    AdminComplianceController,
    AdminKycAssistController,
    AdminClientCreateController,
    AdminRbacController,
    AdminAuditController,
    AdminApiKeysController,
    AdminIpAllowlistController,
    AdminMoneyController,
    AdminFinancialController,
    AdminStatsController,
    AdminHoldingsController,
    AdminBridgeController,
  ],
  /*
   * RBAC-08, restored. Global rather than per-route for the same reason
   * `CsrfGuard` is: a route that forgets to opt IN is indistinguishable from one
   * that never needed it, and the surface this protects grows every week.
   *
   * It is a NO-OP until the allowlist has a row, which is what makes it safe to
   * deploy — an empty table cannot lock anybody out, and that property is
   * asserted rather than assumed (test/ip-allowlist.spec.ts).
   *
   * The deletion that removed this argued the restriction belongs at the edge,
   * in a load balancer or WAF rule, "where it survives an application bug". That
   * is correct and this does not replace it: an application guard is defence in
   * depth behind an edge rule, not a substitute for one. What it does buy is a
   * control an operator can change from the console, on a deployment that has no
   * WAF in front of it yet — which is this one.
   */
  providers: [
    AdminCountriesService,
    ...ADMIN_SERVICES,
    { provide: APP_GUARD, useClass: IpAllowlistGuard },
    /*
     * Records the permission refusals decided INSIDE services, which the guard
     * never sees — see `denial-audit.interceptor.ts`. Global because
     * `assertActorCan` is called from every admin module, not only this one, and
     * a per-controller interceptor would be a list to keep in step with the
     * eighty call sites it exists to cover.
     */
    { provide: APP_INTERCEPTOR, useClass: DenialAuditInterceptor },
    { provide: APP_INTERCEPTOR, useClass: HiddenEmailLookupInterceptor },
  ],
  // Re-exported so importers keep reaching the audit writer through this
  // module, as they did when it was provided here.
  exports: [...ADMIN_SERVICES, AdminAuthModule],
})
export class AdminModule {}
