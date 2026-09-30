import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller';
import { PaymentsReturnController } from './payments-return.controller';
import { AdminPaymentMethodsController } from './admin-payment-methods.controller';
import { AdminWithdrawalMethodsController } from './admin-withdrawal-methods.controller';
import { WithdrawalMethodsService } from './withdrawal-methods.service';
import { AdminAuthModule } from '../admin/admin-auth.module';
import { TransactionsService } from './transactions.service';
import { TransfersService } from './transfers.service';
import { TransferExecutor } from './transfer-executor.service';
import { TransferResumeScheduler } from './transfer-resume.scheduler';
import { MovementTotalsScheduler } from './movement-totals.scheduler';
import { PaymentMethodsService } from './payment-methods.service';
import { WalletModule } from '../wallet/wallet.module';
import { TradingModule } from '../trading/trading.module';
import { IdentityModule } from '../identity/identity.module';
import { CurrenciesModule } from '../currencies/currencies.module';
import { AdminAuditService } from '../admin/admin-audit.service';
import { PaymentProviderRegistry } from './providers/payment-provider-registry';
import { PAYMENT_PROVIDER_ADAPTERS, PAYMENT_PROVIDER_WEBHOOKS } from './providers/payment-provider';
import { PaymentProvidersService } from './providers/payment-providers.service';
import { AdminPaymentProvidersController } from './providers/admin-payment-providers.controller';
import {
  LegacyProviderWebhookController,
  PaymentProviderWebhookController,
} from './providers/payment-provider-webhook.controller';
// THE CORE (0173): decides — state, money, retries, people. Names no provider.
import { ChannelSwitchesService } from './core/channel-switches.service';
import { PayoutEngine } from './core/payout-engine.service';
import { HostedDepositsService } from './core/hosted-deposits.service';
import { ProviderWebhookIngress } from './core/provider-webhook-ingress.service';
import { ProviderReconcileScheduler } from './core/provider-reconcile.scheduler';
// THE PROVIDERS: each translates for one provider, in its own folder. This file
// is the only place outside a provider's folder that names it (lint enforces).
import { ManualPaymentProvider } from './providers/manual/manual.provider';
import { RivalModule } from './providers/rival/rival.module';
import { RivalPaymentProvider } from './providers/rival/rival.provider';
import { RivalWebhookReceiver } from './providers/rival/rival-webhook.receiver';

/** Deposits · withdrawals · transfers · the payment providers and the core that runs them */
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
    PaymentProviderWebhookController,
    // Rival's dashboard still delivers to `/v1/payments/rival/webhook` (0168).
    LegacyProviderWebhookController,
    AdminPaymentMethodsController,
    AdminWithdrawalMethodsController,
    AdminPaymentProvidersController,
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
    WithdrawalMethodsService,
    TransfersService,
    /*
     * The MT5 leg of a transfer. `TransfersService` moves the CRM's two
     * balances; this is what actually credits or debits the trading account on
     * the broker's server, and what settles or fails the row afterwards.
     */
    TransferExecutor,
    // Finishes transfers the executor deliberately left pending — see its note.
    TransferResumeScheduler,
    MovementTotalsScheduler,
    // `WithdrawalOtpService` and `SecuritySettingsService` are gone with the
    // withdrawal confirmation code (D-67).
    AdminAuditService,
    /*
     * EVERY PAYMENT PROVIDER THE BUILD KNOWS (0168). A new provider is one
     * adapter class added here and to the list below — nothing else names it.
     */
    ManualPaymentProvider,
    RivalPaymentProvider,
    {
      provide: PAYMENT_PROVIDER_ADAPTERS,
      useFactory: (manual: ManualPaymentProvider, rival: RivalPaymentProvider) => [manual, rival],
      inject: [ManualPaymentProvider, RivalPaymentProvider],
    },
    PaymentProviderRegistry,
    PaymentProvidersService,
    // Each provider's inbound events: verified into notices, applied by the core.
    RivalWebhookReceiver,
    {
      provide: PAYMENT_PROVIDER_WEBHOOKS,
      useFactory: (rival: RivalWebhookReceiver) => [rival],
      inject: [RivalWebhookReceiver],
    },
    ChannelSwitchesService,
    PayoutEngine,
    HostedDepositsService,
    ProviderWebhookIngress,
    ProviderReconcileScheduler,
  ],
  /*
   * `PaymentsService` is gone from this list, and it was an empty
   * `@Injectable() class PaymentsService {}` — a Nest scaffold placeholder that
   * survived the module's whole life without gaining a method. The real work is
   * in the three services beside it.
   */
  // The core's engines are exported for AdminModule: approving, cancelling,
  // resending and finishing flagged deposits live behind admin routes.
  /*
   * `TransferExecutor` is exported for `AdminMoneyService.fundTradingAccount`,
   * which funds a client's trading account by hand as a wallet credit followed
   * by a real transfer. It needs the SAME executor the client's own transfer
   * endpoint uses — MT5 first, ledger second, idempotent on the transfer id —
   * rather than a second implementation of that ordering. AdminModule imports
   * this module, so the arrow runs one way and there is no cycle.
   */
  exports: [
    PaymentProviderRegistry,
    TransactionsService,
    TransfersService,
    TransferExecutor,
    PaymentMethodsService,
    PayoutEngine,
    HostedDepositsService,
    ChannelSwitchesService,
  ],
})
export class PaymentsModule {}
