import { Module } from '@nestjs/common';
import { TradingController } from './trading.controller';
import { TradingService } from './trading.service';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { IdentityModule } from '../identity/identity.module';
import { AdminAuthModule } from '../admin/admin-auth.module';
import { LeveragesModule } from '../leverages/leverages.module';
import { Mt5WebhooksController } from './mt5/mt5-webhooks.controller';
import { Mt5AccountsController } from './mt5/mt5-accounts.controller';
import { Mt5AccountsService } from './mt5/mt5-accounts.service';
import { SelfServiceGroups } from './mt5/self-service-groups';
import { Mt5DealsService } from './mt5/mt5-deals.service';
import { Mt5AccountSyncService } from './mt5/mt5-account-sync.service';
import { DealCommissionService } from './mt5/deal-commission.service';
import { DealCommissionScheduler } from './mt5/deal-commission.scheduler';
import { Mt5GroupSyncService } from './mt5/mt5-group-sync.service';
import { Mt5GroupSyncScheduler } from './mt5/mt5-group-sync.scheduler';
import { AdminMt5GroupsController } from './mt5/admin-mt5-groups.controller';
import { PositionsService } from './positions.service';
import { Mt5BridgeClient } from './mt5/mt5-bridge.client';
import { Mt5LiveService } from './mt5/mt5-live.service';
import { Mt5LivePublisher } from './mt5/live-snapshot';

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
  // LeveragesModule for `SelfServiceGroups`, which resolves the ladder a client
  // may open on — the CSV it used to parse is a table now (migration 0067).
  imports: [IdentityModule, AdminAuthModule, LeveragesModule],
  controllers: [
    TradingController,
    DashboardController,
    Mt5WebhooksController,
    Mt5AccountsController,
    AdminMt5GroupsController,
  ],
  providers: [
    TradingService,
    DashboardService,
    Mt5DealsService,
    Mt5AccountSyncService,
    /*
     * The LIVE path: figures for an account somebody currently has on screen,
     * routed to their socket and stored nowhere. Deliberately a pair — the
     * service resolves which client owns the login, the publisher puts the
     * reading on the Postgres channel `RealtimeGateway` listens to. Splitting
     * them keeps the ownership lookup (which needs the database) apart from the
     * fan-out (which must never throw), and the second is what
     * `realtime.gateway.ts` imports the channel name from.
     */
    Mt5LiveService,
    Mt5LivePublisher,
    /*
     * The deal → commission seam and the job that drains it. Ingestion stores a
     * deal; this is what turns it into money owed. Before it existed the two
     * halves of the pipeline had no connecting piece and every partner earned
     * nothing while every stage logged success.
     */
    DealCommissionService,
    DealCommissionScheduler,
    Mt5GroupSyncService,
    Mt5GroupSyncScheduler,
    PositionsService,
    Mt5BridgeClient,
    Mt5AccountsService,
    SelfServiceGroups,
  ],
  /*
   * `Mt5AccountsService` is exported for the products module, which asks it
   * which groups the server actually has before letting an operator attach one
   * to a product. That validation is the point of the products screen.
   */
  /*
   * `Mt5GroupSyncService` is exported for the same consumer and the same reason
   * as `Mt5AccountsService`: the products screen. That one validates a group
   * against the live server when an operator ATTACHES it; this one answers the
   * picker, from the mirror, when the server cannot be reached.
   */
  exports: [
    TradingService,
    Mt5BridgeClient,
    Mt5AccountsService,
    Mt5GroupSyncService,
    PositionsService,
    /*
     * Exported for `TransfersService`, which records the balance MT5 returned
     * from a movement it just made. That write goes through the same staleness
     * guard as the sweep's — a transfer response and a sweep delivery can land
     * in either order — so it is this service's job rather than an inline UPDATE
     * in the payments module.
     */
    Mt5AccountSyncService,
  ],
})
export class TradingModule {}
