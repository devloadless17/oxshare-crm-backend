import { forwardRef, Module } from '@nestjs/common';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';
import { ReconciliationService } from './reconciliation.service';
import { ReconciliationScheduler } from './reconciliation.scheduler';
import { WalletProvisioningService } from './wallet-provisioning.service';
import { IdentityModule } from '../identity/identity.module';
import { CurrenciesModule } from '../currencies/currencies.module';

/** Balances · ledger entries · transaction state machine */
@Module({
  // CurrenciesModule for `WalletProvisioningService`, which has to ask which
  // currency is the default and which are enabled. The dependency runs one way
  // only: `CurrenciesService` reads the `wallets` TABLE to refuse deleting a
  // currency somebody holds, but it never uses `WalletService`, so there is no
  // cycle to break.
  // IdentityModule is a forwardRef because it now needs this module back —
  // registration opens the client's first wallet. See identity.module.ts for
  // why that cycle is legitimate rather than a layering mistake.
  imports: [forwardRef(() => IdentityModule), CurrenciesModule],
  controllers: [WalletController],
  providers: [
    WalletService,
    WalletProvisioningService,
    ReconciliationService,
    ReconciliationScheduler,
  ],
  exports: [WalletService, WalletProvisioningService, ReconciliationService],
})
export class WalletModule {}
