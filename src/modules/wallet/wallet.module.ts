import { Global, Module } from '@nestjs/common';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';
import { ReconciliationService } from './reconciliation.service';
import { ReconciliationScheduler } from './reconciliation.scheduler';
import { WalletProvisioningService } from './wallet-provisioning.service';
import { IdentityModule } from '../identity/identity.module';
import { CurrenciesModule } from '../currencies/currencies.module';
import { WALLET_PROVISIONING } from '../../common/provisioning/wallet-provisioning.port';

/** Balances · ledger entries · transaction state machine */
@Global()
@Module({
  /*
   * ONE-WAY, and no forwardRef. This is the change identity.module.ts asked for.
   *
   * The deleted version imported `forwardRef(() => IdentityModule)` because
   * registration opened the client's first wallet, so identity needed wallet
   * while wallet needed identity for `JwtAuthGuard` — the only module cycle in
   * the backend. Its note said to prefer having the money side listen rather
   * than having identity reach in, and warned that "a cycle is cheap to add and
   * expensive to notice".
   *
   * Neither half is needed now. `WalletService` depends on nothing but the
   * database, and `AuthService` reaches provisioning through the @Global
   * `StoreModule` — the same route it takes to `IbStore` for referral codes. So
   * the edge runs one way, identity → nothing, and this module simply imports
   * what its controller's guard needs.
   *
   * CurrenciesModule is for `WalletProvisioningService`, which asks which
   * currencies are enabled. That dependency is also one-way: `CurrenciesService`
   * reads the `wallets` TABLE to refuse deleting a currency somebody holds, but
   * it never touches `WalletService`.
   */
  imports: [IdentityModule, CurrenciesModule],
  controllers: [WalletController],
  providers: [
    WalletService,
    WalletProvisioningService,
    ReconciliationService,
    ReconciliationScheduler,
    /*
     * The binding for `WalletProvisioningPort`.
     *
     * `AuthService` injects the TOKEN, so identity never names this class or
     * this module — which is what keeps the graph acyclic. @Global because
     * identity does not import this module and cannot be made to without
     * restoring the cycle.
     */
    { provide: WALLET_PROVISIONING, useExisting: WalletProvisioningService },
  ],
  exports: [WalletService, WalletProvisioningService, ReconciliationService, WALLET_PROVISIONING],
})
export class WalletModule {}
