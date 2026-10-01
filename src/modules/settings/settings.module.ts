import { Module } from '@nestjs/common';
import { AdminSettingsController } from './admin-settings.controller';
import { SettingsService } from './settings.service';
import { AdminAuthModule } from '../admin/admin-auth.module';

/**
 * The Trading and Email tabs of the admin settings screen.
 *
 * `AdminAuthModule` is imported for the same reason every other admin-facing
 * module imports it — `AdminGuard`, `MasterAdminGuard` and `PermissionsGuard`
 * resolve their dependencies from it.
 *
 * `EmailService` and `SmtpConfigService` need no import: `EmailModule` is
 * `@Global()`. That is also what keeps this acyclic — the email module reads
 * SMTP settings through the `@Global()` store rather than through this module.
 */
@Module({
  imports: [AdminAuthModule],
  controllers: [AdminSettingsController],
  providers: [SettingsService],
  exports: [SettingsService],
})
export class SettingsModule {}
