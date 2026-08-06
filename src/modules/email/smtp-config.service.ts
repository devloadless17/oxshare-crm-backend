import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { openSecret } from '../../common/security/secret-box';
import { AppSettingsStore } from '../../store/app-settings.store';

/**
 * Resolves the SMTP configuration actually in force: the admin-managed row if
 * there is one, the environment otherwise.
 *
 * ── Why this is its own service ────────────────────────────────────────────
 *
 * It is the ONE place that turns `smtp_settings.password_ciphertext` back into a
 * password. `settings.service.ts` seals passwords on the way in and never
 * unseals; this unseals on the way out and never writes. Keeping the two
 * directions in separate classes means "who can read the SMTP password" is
 * answerable by finding the injections of this class — currently one.
 *
 * It also breaks what would otherwise be a module cycle. The settings controller
 * needs `EmailService` to send its test message, so `EmailModule` must not in
 * turn depend on the settings module. `AppSettingsStore` is `@Global()`, so this
 * reaches the row without importing anything from `modules/settings`.
 *
 * ── Env is the floor, not the default ──────────────────────────────────────
 *
 * The row wins WHOLE, not field by field. A half-merged configuration — the
 * row's host with the environment's password — is a state no operator chose and
 * cannot see on the screen; it would silently authenticate to a new relay with
 * an old credential and fail in a way the settings form shows as correct.
 *
 * The environment still has to be complete enough to send, because the row
 * cannot exist before somebody signs in to create it. See the SMTP block in
 * `env.validation.ts`.
 */

export interface EffectiveSmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  username: string | null;
  password: string | null;
  from: string;
  /** Where this came from, for the log line and the settings screen. */
  source: 'database' | 'environment';
  /**
   * Changes whenever anything above changes, so `EmailService` can decide
   * whether its cached transporter is still valid without comparing fields.
   * Deliberately excludes the password itself — see `EmailService`.
   */
  fingerprint: string;
}

@Injectable()
export class SmtpConfigService {
  private readonly logger = new Logger(SmtpConfigService.name);

  constructor(
    private readonly settings: AppSettingsStore,
    private readonly config: ConfigService,
  ) {}

  async resolve(): Promise<EffectiveSmtpConfig> {
    const row = await this.settings.getSmtp();

    if (row) {
      /*
       * A password that will not decrypt is NOT a reason to fall back to the
       * environment. The operator configured this relay deliberately, and
       * quietly sending their clients' password-reset links through a different
       * server because a key rotation went wrong is the kind of silent
       * substitution this codebase refuses elsewhere. Send unauthenticated
       * against the configured host instead — that fails loudly at the relay,
       * which is where somebody will look.
       */
      let password: string | null = null;
      if (row.passwordCiphertext) {
        try {
          password = openSecret(
            row.passwordCiphertext,
            this.config.get<string>('APP_ENCRYPTION_KEY'),
          );
        } catch (error) {
          this.logger.error(
            'Stored SMTP password could not be decrypted; connecting without authentication. ' +
              'Re-save the password in Settings → Email. ' +
              (error instanceof Error ? error.message : String(error)),
          );
        }
      }

      return {
        host: row.host,
        port: row.port,
        secure: row.secure,
        username: row.username,
        password,
        from: row.fromAddress,
        source: 'database',
        fingerprint: [
          'db',
          row.host,
          row.port,
          row.secure,
          row.username ?? '',
          row.fromAddress,
          // The timestamp covers the password: it changes on every save, so a
          // password-only edit still invalidates the cached transporter without
          // the secret ever entering the fingerprint.
          row.updatedAt.toISOString(),
        ].join('|'),
      };
    }

    const host = this.config.get<string>('SMTP_HOST', 'smtp.example.com');
    const port = this.config.get<number>('SMTP_PORT', 587);
    const username = this.config.get<string>('SMTP_USER', '') || null;
    const password = this.config.get<string>('SMTP_PASS', '') || null;
    const from = this.config.get<string>('SMTP_FROM', '"OxShare System" <no-reply@oxshare.com>');

    return {
      host,
      port,
      // Preserves the previous behaviour for the env path exactly. The database
      // path stores this explicitly instead, because deriving it from the port
      // is wrong on any relay using a non-standard SMTPS port.
      secure: port === 465,
      username,
      password,
      from,
      source: 'environment',
      fingerprint: ['env', host, port, username ?? '', from].join('|'),
    };
  }
}
