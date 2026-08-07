import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { TransactionsService } from './transactions.service';
import { TransfersService } from './transfers.service';
import { WalletModule } from '../wallet/wallet.module';
import { IdentityModule } from '../identity/identity.module';
import { CurrenciesModule } from '../currencies/currencies.module';
import { WithdrawalOtpService } from './withdrawal-otp.service';
import { SecuritySettingsService } from '../admin/security-settings.service';
import { AdminAuditService } from '../admin/admin-audit.service';

/** Whish · USDT · deposits · withdrawals · OTP · provider callbacks */
@Module({
  // CurrenciesModule so the money paths can refuse an unknown or DISABLED
  // currency at runtime — the check that replaced the old `'USD' | 'USDT'`
  // union when currencies became operator data.
  imports: [WalletModule, IdentityModule, CurrenciesModule],
  controllers: [PaymentsController],
  /*
   * `SecuritySettingsService` and `AdminAuditService` are provided here rather
   * than imported from AdminModule, deliberately: importing the admin module
   * into the client-facing payments module would drag the whole back-office
   * graph — and its guards — behind a portal route. Both are thin services over
   * @Global stores, so a second instance costs nothing and keeps the dependency
   * pointing one way.
   */
  providers: [
    TransactionsService,
    TransfersService,
    WithdrawalOtpService,
    SecuritySettingsService,
    AdminAuditService,
  ],
  /*
   * `PaymentsService` is gone from this list, and it was an empty
   * `@Injectable() class PaymentsService {}` — a Nest scaffold placeholder that
   * survived the module's whole life without gaining a method. The real work is
   * in the three services beside it.
   */
  exports: [TransactionsService, TransfersService],
})
export class PaymentsModule {}
