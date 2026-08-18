import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MailNotConfiguredError } from '../../common/errors/domain-errors';
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
 * ── The row is the ONLY source ─────────────────────────────────────────────
 *
 * There is no SMTP_* environment fallback. Mail is configured by an
 * administrator on Settings → Email; until that row exists `resolve()` refuses
 * with `MailNotConfiguredError` rather than reaching for a second, invisible
 * configuration. Holding relay credentials in two places meant the environment
 * copy was never used after the first save, while still being the thing a
 * misconfigured deployment silently fell back to.
 *
 * The bootstrap chicken-and-egg that once justified an env floor is handled
 * elsewhere: `scripts/bootstrap-admin.mjs` creates the first administrator from
 * BOOTSTRAP_ADMIN_EMAIL/PASSWORD, so no invite email is needed to get in. See
 * DEPLOYMENT.md, "The first administrator".
 */

export interface EffectiveSmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  username: string | null;
  password: string | null;
  from: string;
  /**
   * Where this came from, for the log line and the settings screen. Only ever
   * `'database'` now that the environment fallback is gone — kept as a field
   * because the settings DTO and both frontends still read it.
   */
  source: 'database';
  /**
   * Changes whenever anything above changes, so `EmailService` can decide
   * whether its cached transporter is still valid without comparing fields.
   * Deliberately excludes the password itself — see `EmailService`.
   */
  fingerprint: string;
}

@Injectable()
export class SmtpConfigService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SmtpConfigService.name);

  constructor(
    private readonly settings: AppSettingsStore,
    private readonly config: ConfigService,
  ) {}

  /**
   * Say once, at boot, whether mail can be sent at all.
   *
   * `resolve()` refusing is the correct behaviour but a quiet one: every
   * `send*` path funnels through `EmailService.send`, which logs and swallows
   * on purpose — no caller treats "the mail did not go" as a reason to fail the
   * operation that triggered it, and a KYC approval must not report failure
   * after it has already committed. Correct, and it means an unconfigured
   * deployment reveals itself only to whoever reads a log line at the moment
   * somebody happens to register.
   *
   * A deploy, on the other hand, is watched. This puts the answer where the
   * operator is already looking, on the one occasion they are looking.
   *
   * It never throws: the process must start regardless, because the screen that
   * fixes this is served by the process. A database not yet reachable is
   * reported as unknown rather than as unconfigured — claiming mail is broken
   * because a probe failed would be its own kind of wrong.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const row = await this.settings.getSmtp();
      if (row) {
        this.logger.log(`Mail configured from the database (${row.host}:${row.port}).`);
        return;
      }
      this.logger.warn(
        'NO MAIL SERVER IS CONFIGURED. Verification links, KYC decisions, withdrawal ' +
          'notifications and admin invites will not be delivered. An administrator must ' +
          'configure one in Settings → Email.',
      );
    } catch (error) {
      this.logger.warn(
        `Could not determine the mail configuration at boot: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

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

    /*
     * NO ROW IS A REFUSAL, not a default.
     *
     * There is nothing left to fall back to. This once read SMTP_* from the
     * environment, and before that defaulted to `smtp.example.com` — a host RFC
     * 2606 reserves to never resolve — so an unconfigured deployment produced a
     * config that looked complete and failed at the relay. `EmailService.send`
     * catches and logs rather than throwing, so that failure stopped there: no
     * verification link, no KYC decision, no withdrawal notification, and
     * nothing above the logger any the wiser.
     *
     * Refusing here keeps that failure loud and names the one place it is fixed.
     */
    throw new MailNotConfiguredError();
  }
}
