import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { TransactionsService } from './transactions.service';
import { WalletModule } from '../wallet/wallet.module';
import { IdentityModule } from '../identity/identity.module';

/** Whish · USDT · deposits · withdrawals · OTP · provider callbacks */
@Module({
  imports: [WalletModule, IdentityModule],
  controllers: [PaymentsController],
  providers: [PaymentsService, TransactionsService],
  exports: [PaymentsService, TransactionsService],
})
export class PaymentsModule {}
