import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { TransactionsService } from './transactions.service';
import { WalletModule } from '../wallet/wallet.module';
import { IdentityModule } from '../identity/identity.module';
import { WithdrawalOtpService } from './withdrawal-otp.service';
import { SecuritySettingsService } from '../admin/security-settings.service';
import { AdminAuditService } from '../admin/admin-audit.service';

/** Whish · USDT · deposits · withdrawals · OTP · provider callbacks */
@Module({
  imports: [WalletModule, IdentityModule],
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
    PaymentsService,
    TransactionsService,
    WithdrawalOtpService,
    SecuritySettingsService,
    AdminAuditService,
  ],
  exports: [PaymentsService, TransactionsService],
})
export class PaymentsModule {}
