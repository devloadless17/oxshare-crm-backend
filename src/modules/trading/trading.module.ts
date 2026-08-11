import { Module } from '@nestjs/common';
import { TradingController } from './trading.controller';
import { TradingService } from './trading.service';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { IdentityModule } from '../identity/identity.module';
import { AdminAuthModule } from '../admin/admin-auth.module';
import { Mt5WebhooksController } from './mt5/mt5-webhooks.controller';
import { Mt5AccountsController } from './mt5/mt5-accounts.controller';
import { Mt5AccountsService } from './mt5/mt5-accounts.service';
import { Mt5DealsService } from './mt5/mt5-deals.service';
import { Mt5BridgeClient } from './mt5/mt5-bridge.client';

/**
 * The client's view of their own trading accounts.
 *
 * `IdentityModule` for `JwtAuthGuard` and `EmailVerifiedGuard` — the same
 * import `IbModule` makes for its client-facing controller.
 *
 * Separate from the admin holdings surface on purpose: that one reads ACROSS
 * clients, is permission-gated, joins owner identity onto every row and is
 * cursor-paged. Sharing a service between the two would mean one query trying
 * to be both, with client scope as an optional parameter — and an optional
 * scope is one that is eventually omitted.
 *
 * The service is exported so the transfer screen's destination list has a
 * single source; nothing else should reach into `trading_accounts` directly.
 */
/*
 * The DASHBOARD lives here rather than in a module of its own.
 *
 * It is a composition of reads this module already owns — accounts and
 * positions — plus wallets and transactions. A separate module would import
 * TradingModule for both, and would exist only to hold one controller that
 * assembles other people's data.
 *
 * `WalletService` resolves without an import because `WalletModule` is @Global.
 */
/*
 * The MT5 surface lives here too — ARCHITECTURE §4 puts "MT5 accounts, groups,
 * tiers, deal ingestion" in this module, and splitting the bridge into its own
 * would separate deal ingestion from the trading accounts every deal resolves
 * against.
 *
 * `Mt5WebhooksController` is machine-to-machine and carries its own guard
 * (`BridgeSecretGuard`) rather than the client JWT ones this module's other
 * controllers use — the bridge is a service on a private network, not a person.
 *
 * `Mt5BridgeClient` is exported because account creation and transfers will call
 * it from the wallet and admin surfaces. Nothing else should know the bridge's
 * address.
 */
@Module({
  /*
   * `AdminAuthModule` for the guards on Mt5AccountsController and for
   * AdminAuditService. It is the leaf module the whole back office imports
   * without a cycle — see its own note — so this does not drag the admin graph
   * into trading.
   */
  imports: [IdentityModule, AdminAuthModule],
  controllers: [
    TradingController,
    DashboardController,
    Mt5WebhooksController,
    Mt5AccountsController,
  ],
  providers: [
    TradingService,
    DashboardService,
    Mt5DealsService,
    Mt5BridgeClient,
    Mt5AccountsService,
  ],
  exports: [TradingService, Mt5BridgeClient],
})
export class TradingModule {}
