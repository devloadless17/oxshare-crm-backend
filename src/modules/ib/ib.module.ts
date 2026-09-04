import { Global, Module } from '@nestjs/common';
import { AdminIbController } from './admin-ib.controller';
import { AdminIbLevelsController } from './admin-ib-levels.controller';
import { IbController } from './ib.controller';
import { IbApplicationsService } from './ib-applications.service';
import { IbLevelsService } from './ib-levels.service';
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
 * It owns the commission LADDER, partner APPLICATIONS and partner ACCOUNTS
 * together, because they share the one rule that matters: a partner's terms come
 * from their LEVEL in the tree, so approving an application is the moment that
 * level is decided. Splitting them would leave one side re-deriving the other.
 *
 * `IbProgramsService` and its controller went in 0112 with the catalogue they
 * served — a partner cannot be paid both by a card they hold and by where they
 * stand. See the header of `ib-levels.service.ts`.
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
  controllers: [IbController, AdminIbController, AdminIbLevelsController],
  providers: [
    IbApplicationsService,
    IbLevelsService,
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
    IbOverviewService,
    IbWalletService,
    CommissionService,
    COMMISSION_ACCRUAL,
  ],
})
export class IbModule {}
