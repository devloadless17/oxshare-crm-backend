import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { AdminPaymentMethodsController } from './admin-payment-methods.controller';
import { AdminAuthModule } from '../admin/admin-auth.module';
import { TransactionsService } from './transactions.service';
import { TransfersService } from './transfers.service';
import { TransferExecutor } from './transfer-executor.service';
import { PaymentMethodsService } from './payment-methods.service';
import { WalletModule } from '../wallet/wallet.module';
import { TradingModule } from '../trading/trading.module';
import { IdentityModule } from '../identity/identity.module';
import { CurrenciesModule } from '../currencies/currencies.module';
import { WithdrawalOtpService } from './withdrawal-otp.service';
import { SecuritySettingsService } from '../admin/security-settings.service';
import { AdminAuditService } from '../admin/admin-audit.service';
import { PaymentCallbacksController } from './payment-callbacks.controller';
import { PaymentGateways } from './payment-gateways.service';
import { WhishProvider } from './whish.provider';

/** Whish · USDT · deposits · withdrawals · OTP · provider callbacks */
@Module({
  // CurrenciesModule so the money paths can refuse an unknown or DISABLED
  // currency at runtime — the check that replaced the old `'USD' | 'USDT'`
  // union when currencies became operator data.
  /*
   * `AdminAuthModule` for `PermissionsGuard`, which the payment-methods admin
   * controller needs. That is the SAME narrow import the settings, currencies
   * and IB modules make — it carries the admin guards and not the back-office
   * graph, which is the thing the note below is protecting against.
   */
  /*
   * `TradingModule` for `Mt5BridgeClient`, which `TransferExecutor` uses to
   * move the MT5 leg of a transfer. The dependency runs one way — trading does
   * not import payments — so there is no cycle.
   */
  imports: [WalletModule, IdentityModule, CurrenciesModule, AdminAuthModule, TradingModule],
  /*
   * `PaymentCallbacksController` is UNAUTHENTICATED, uniquely in this module and
   * deliberately: a payment gateway calls it server-to-server with no credential
   * of any kind. It is a separate file rather than an exception inside
   * `PaymentsController` so that the unauthenticated surface of this system
   * stays greppable — see the note in it for why that is safe.
   */
  controllers: [PaymentsController, PaymentCallbacksController, AdminPaymentMethodsController],
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
    PaymentMethodsService,
    TransfersService,
    /*
     * The MT5 leg of a transfer. `TransfersService` moves the CRM's two
     * balances; this is what actually credits or debits the trading account on
     * the broker's server, and what settles or fails the row afterwards.
     */
    TransferExecutor,
    WithdrawalOtpService,
    SecuritySettingsService,
    AdminAuditService,
    /*
     * The hosted-gateway seam. `PaymentGateways` is the registry every caller
     * talks to; `WhishProvider` is the one implementation behind it today.
     *
     * Nothing outside this module names Whish — adding a second provider is a
     * case in one switch, not a change to the deposit flow, the method list and
     * the callback route.
     */
    PaymentGateways,
    WhishProvider,
  ],
  /*
   * `PaymentsService` is gone from this list, and it was an empty
   * `@Injectable() class PaymentsService {}` — a Nest scaffold placeholder that
   * survived the module's whole life without gaining a method. The real work is
   * in the three services beside it.
   */
  exports: [TransactionsService, TransfersService, PaymentMethodsService],
})
export class PaymentsModule {}
