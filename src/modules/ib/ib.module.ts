import { Global, Module } from '@nestjs/common';
import { AdminIbController } from './admin-ib.controller';
import { AdminIbLevelsController } from './admin-ib-levels.controller';
import { AdminIbProgramsController } from './admin-ib-programs.controller';
import { IbController } from './ib.controller';
import { IbApplicationsService } from './ib-applications.service';
import { IbLevelsService } from './ib-levels.service';
import { IbProgramsService } from './ib-programs.service';
import { IbOverviewService } from './ib-overview.service';
import { IbWalletService } from './ib-wallet.service';
import { CommissionService } from './commission.service';
import { CommissionScheduler } from './commission.scheduler';
import { COMMISSION_ACCRUAL } from '../../common/provisioning/commission-accrual.port';
import { AdminAuthModule } from '../admin/admin-auth.module';
import { IdentityModule } from '../identity/identity.module';
import { EmailModule } from '../email/email.module';
import { AdminExportModule } from '../admin/admin-export.module';

/**
 * The introducing-broker programme.
 *
 * Rebuilt from zero after the commission engine was removed. It owns the payout
 * LADDER, partner APPLICATIONS and partner ACCOUNTS together, because they share
 * the one rule that matters — a partner's level decides both what they earn and
 * how many partners they may recruit, so splitting them would leave one side
 * re-deriving the other.
 *
 * `AdminAuthModule` for `PermissionsGuard`, the same import the settings,
 * platform-links and currencies modules make. `IdentityModule` for
 * `JwtAuthGuard` and `EmailVerifiedGuard`, which the CLIENT-facing controller
 * needs — this is the first module here to carry both surfaces.
 */
/*
 * `@Global` for ONE reason: the `COMMISSION_ACCRUAL` binding below.
 *
 * `PaymentsModule` must be able to resolve that token without importing this
 * module — importing it would close a cycle, since both modules depend on
 * `WalletModule`. This is the same recipe `WalletModule` uses to expose
 * `WALLET_PROVISIONING` to identity, and for the same reason.
 */
@Global()
@Module({
  // `AdminExportModule` for the two partner exports. A narrow import, like
  // `AdminAuthModule` above — never the whole `AdminModule`.
  imports: [AdminAuthModule, IdentityModule, EmailModule, AdminExportModule],
  controllers: [
    IbController,
    AdminIbController,
    AdminIbLevelsController,
    AdminIbProgramsController,
  ],
  providers: [
    IbApplicationsService,
    IbLevelsService,
    IbProgramsService,
    IbOverviewService,
    IbWalletService,
    CommissionService,
    CommissionScheduler,
    /*
     * The binding for `CommissionAccrualPort`.
     *
     * `TransactionsService` injects the TOKEN, so payments never names this
     * class or this module — which is what keeps the graph acyclic. Payments
     * importing `IbModule` directly would be a cycle: this module imports
     * `WalletModule` (to pay commissions out) and payments imports it too, so
     * the edge has to run one way through `common/`.
     *
     * `@Global()` above is the other half of the recipe, exactly as
     * `WalletModule` does it for `WALLET_PROVISIONING`: payments does not — and
     * must not — import this module, so the binding has to be reachable without
     * that import.
     */
    { provide: COMMISSION_ACCRUAL, useExisting: CommissionService },
  ],
  exports: [
    IbApplicationsService,
    IbLevelsService,
    IbOverviewService,
    IbWalletService,
    CommissionService,
    COMMISSION_ACCRUAL,
  ],
})
export class IbModule {}
