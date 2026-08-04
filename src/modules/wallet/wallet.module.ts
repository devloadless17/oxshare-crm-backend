import { Module } from '@nestjs/common';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';
import { ReconciliationService } from './reconciliation.service';
import { ReconciliationScheduler } from './reconciliation.scheduler';
import { IdentityModule } from '../identity/identity.module';

/** Balances · ledger entries · transaction state machine */
@Module({
  imports: [IdentityModule],
  controllers: [WalletController],
  providers: [WalletService, ReconciliationService, ReconciliationScheduler],
  exports: [WalletService, ReconciliationService],
})
export class WalletModule {}
