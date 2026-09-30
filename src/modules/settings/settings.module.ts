import { Module } from '@nestjs/common';
import { AdminSettingsController } from './admin-settings.controller';
import { SettingsService } from './settings.service';
import { RivalSettingsService } from './rival-settings.service';
import { AdminAuthModule } from '../admin/admin-auth.module';
import { RivalModule } from '../payments/providers/rival/rival.module';

/**
 * The Trading, Email and Payments (Rival) tabs of the admin settings screen.
 *
 * `AdminAuthModule` is imported for the same reason every other admin-facing
 * module imports it — `AdminGuard`, `MasterAdminGuard` and `PermissionsGuard`
 * resolve their dependencies from it.
 *
 * `EmailService` and `SmtpConfigService` need no import: `EmailModule` is
 * `@Global()`. That is also what keeps this acyclic — the email module reads
 * SMTP settings through the `@Global()` store rather than through this module.
 *
 * `RivalModule` is the Rival substrate (client + config), NOT the payments
 * module — importing `PaymentsModule` for one test-connection call would drag
 * the whole money surface into this graph.
 */
@Module({
  imports: [AdminAuthModule, RivalModule],
  controllers: [AdminSettingsController],
  providers: [SettingsService, RivalSettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
