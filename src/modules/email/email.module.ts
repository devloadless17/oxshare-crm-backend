import { Module, Global } from '@nestjs/common';
import { AlertEmailService } from './alert-email.service';
import { EmailService } from './email.service';
import { SmtpConfigService } from './smtp-config.service';

/**
 * Exports `SmtpConfigService` as well as `EmailService`, so the settings screen
 * can report which configuration is in force without importing the store and
 * re-deriving the same precedence rule.
 *
 * Note this module deliberately does NOT import `SettingsModule`, even though
 * SMTP settings now live in the database: `AppSettingsStore` is `@Global()`, and
 * depending on the settings module here would close a cycle — the settings
 * controller needs `EmailService` for its test send.
 */
@Global()
@Module({
  providers: [EmailService, SmtpConfigService, AlertEmailService],
  exports: [EmailService, SmtpConfigService],
})
export class EmailModule {}
