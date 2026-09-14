import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsReturnController } from './payments-return.controller';
import { AdminPaymentMethodsController } from './admin-payment-methods.controller';
import { AdminAuthModule } from '../admin/admin-auth.module';
import { TransactionsService } from './transactions.service';
import { TransfersService } from './transfers.service';
import { TransferExecutor } from './transfer-executor.service';
import { TransferResumeScheduler } from './transfer-resume.scheduler';
import { PaymentMethodsService } from './payment-methods.service';
import { WalletModule } from '../wallet/wallet.module';
import { TradingModule } from '../trading/trading.module';
import { IdentityModule } from '../identity/identity.module';
import { CurrenciesModule } from '../currencies/currencies.module';
import { AdminAuditService } from '../admin/admin-audit.service';
import { PaymentGateways } from './payment-gateways.service';
import { RivalModule } from './rival/rival.module';
import { RivalWebhookController } from './rival/rival-webhook.controller';
import { RivalWebhookService } from './rival/rival-webhook.service';
import { RivalWithdrawalsService } from './rival/rival-withdrawals.service';
import { RivalPollScheduler } from './rival/rival-poll.scheduler';

/** Deposits · withdrawals · OTP · the Rival platform connection */
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
  // `RivalModule` is the platform substrate (client + config), shared with
  // SettingsModule for the test-connection call — one-way arrows both ways.
  imports: [
    WalletModule,
    IdentityModule,
    CurrenciesModule,
    AdminAuthModule,
    TradingModule,
    RivalModule,
  ],
  /*
   * `RivalWebhookController` carries no session auth, uniquely in this module
   * and deliberately: Rival calls it server-to-server, authenticated by a
   * minted bearer key plus an HMAC over the raw body — verified before
   * parsing, replay-blocked by nonce. It is a separate file rather than an
   * exception inside `PaymentsController` so that the low-auth surface of this
   * system stays greppable — see its class comment.
   */
  controllers: [
    PaymentsController,
    PaymentsReturnController,
    RivalWebhookController,
    AdminPaymentMethodsController,
  ],
  /*
   * `AdminAuditService` is provided here rather than imported from
   * AdminModule, deliberately: importing the admin module into the
   * client-facing payments module would drag the whole back-office graph — and
   * its guards — behind a portal route. It is a thin service over @Global
   * stores, so a second instance costs nothing and keeps the dependency
   * pointing one way. (`SecuritySettingsService` used to sit beside it for the
   * withdrawal OTP; the OTP is gone and so is the switch — see D-67.)
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
    // Finishes transfers the executor deliberately left pending — see its note.
    TransferResumeScheduler,
    // `WithdrawalOtpService` and `SecuritySettingsService` are gone with the
    // withdrawal confirmation code (D-67).
    AdminAuditService,
    /*
     * The hosted-gateway seam. `PaymentGateways` is the registry every caller
     * talks to; behind it sits Rival — Loadless's own payments platform, where
     * Whish is integrated once. Nothing outside this module names either:
     * a second rail is a case in one switch, not a change to the deposit flow,
     * the method list or the webhook route.
     */
    PaymentGateways,
    RivalWebhookService,
    RivalWithdrawalsService,
    RivalPollScheduler,
  ],
  /*
   * `PaymentsService` is gone from this list, and it was an empty
   * `@Injectable() class PaymentsService {}` — a Nest scaffold placeholder that
   * survived the module's whole life without gaining a method. The real work is
   * in the three services beside it.
   */
  // `RivalWithdrawalsService` is exported for AdminModule: the approve hook
  // and the desk's cancel/retry actions live behind admin routes.
  /*
   * `TransferExecutor` is exported for `AdminMoneyService.fundTradingAccount`,
   * which funds a client's trading account by hand as a wallet credit followed
   * by a real transfer. It needs the SAME executor the client's own transfer
   * endpoint uses — MT5 first, ledger second, idempotent on the transfer id —
   * rather than a second implementation of that ordering. AdminModule imports
   * this module, so the arrow runs one way and there is no cycle.
   */
  exports: [
    TransactionsService,
    TransfersService,
    TransferExecutor,
    PaymentMethodsService,
    RivalWithdrawalsService,
  ],
})
export class PaymentsModule {}
