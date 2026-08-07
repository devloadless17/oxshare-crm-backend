import { Module } from '@nestjs/common';
import { AdminExportService } from './admin-export.service';
import { AdminAuditService } from './admin-audit.service';
import { AdminHoldingsService } from './admin-holdings.service';
import { PaymentsModule } from '../payments/payments.module';

/**
 * The table exports, as a module of their own.
 *
 * ── Why this is not simply a provider inside `AdminModule` ──────────────────
 *
 * The export routes live on the SAME controllers as the lists they export —
 * that is a requirement of the feature, so that a route and its export cannot
 * drift apart on permissions or scope. Those controllers are spread across four
 * modules: `AdminModule` (clients, KYC, audit log, tags, RBAC), `IbModule`
 * (applications, partners), `CurrenciesModule` and `PaymentsModule`.
 *
 * So `AdminExportService` has to be injectable in all four. Providing it inside
 * `AdminModule` and importing `AdminModule` into `IbModule` would drag the
 * entire back-office graph — and its guards — behind the partner routes, which
 * is exactly what `PaymentsModule`'s own note warns against. A small module
 * exporting one service keeps the dependency pointing one way.
 *
 * ── `PaymentsModule` is imported, and nothing imports back ─────────────────
 *
 * `AdminExportService` needs `TransactionsService` for the withdrawal rows.
 * `PaymentsModule` already exports it, and `PaymentsModule` imports only
 * `AdminAuthModule` from the admin surface, never this — so the cycle the
 * layering rule exists to prevent does not form.
 *
 * `AdminAuditService` is provided here for the same reason `PaymentsModule`
 * provides its own copy rather than importing `AdminModule`: it is a thin
 * service over `@Global` stores, so a second instance costs nothing and keeps
 * the graph acyclic.
 */
/*
 * `AdminHoldingsService` is provided HERE rather than only in `AdminModule`.
 *
 * It is the row source for the wallet and trading-account exports, so
 * `AdminExportService` needs it — and this module must stay resolvable on its
 * own for the same reason the whole file exists: importing `AdminModule` to
 * reach one service would drag the entire back-office graph behind every
 * controller that carries an export route.
 *
 * It is a thin service over the injected `DRIZZLE_DB` handle, which is a lazy
 * singleton, so a second instance opens no second pool and holds no state —
 * exactly the reasoning `AdminAuditService` is provided here under.
 */
@Module({
  imports: [PaymentsModule],
  providers: [AdminExportService, AdminAuditService, AdminHoldingsService],
  exports: [AdminExportService, AdminAuditService, AdminHoldingsService],
})
export class AdminExportModule {}
