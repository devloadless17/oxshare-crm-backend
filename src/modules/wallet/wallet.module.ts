import { Module } from '@nestjs/common';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';
import { IdentityModule } from '../identity/identity.module';

/** Balances · ledger entries · transaction state machine */
@Module({
  imports: [IdentityModule],
  controllers: [WalletController],
  providers: [WalletService],
  exports: [WalletService],
})
export class WalletModule {}
